'use strict';

const express = require('express');
const { db, newReceiptRef } = require('../db');
const { esc, publicLayout } = require('../views/layout');
const { quote, money, localParts, zonedTimeToUtc, localToday, addOneMonth, inclusiveEnd } = require('../pricing');
const stripe = require('../stripe');

const router = express.Router();

function baseUrl(req) {
  return (process.env.PCA_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function getLocationByCode(code) {
  return db.prepare('SELECT * FROM locations WHERE code = ? COLLATE NOCASE').get(String(code || '').trim());
}

function cleanPlate(v) {
  return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10);
}

/**
 * Cars that overlap [startIso, endIso) at a location: paid sessions plus
 * checkouts still pending at Stripe (recent ones only, so abandoned carts free up).
 */
function overlappingCount(locationId, startIso, endIso) {
  return db.prepare(`
    SELECT COUNT(*) n FROM sessions
    WHERE location_id = ?
      AND (status = 'paid' OR (status = 'pending' AND created_at >= datetime('now','-30 minutes')))
      AND start_ts < ? AND end_ts > ?`).get(locationId, endIso, startIso).n;
}

function spotsLeft(location, startIso, endIso) {
  return location.capacity - overlappingCount(location.id, startIso, endIso);
}

/**
 * Count a promo redemption, never exceeding the campaign's cap (the cap was
 * checked at quote time, but payment can land later — e.g. Stripe checkout).
 */
function countRedemption(campaignId) {
  if (!campaignId) return;
  db.prepare(`UPDATE campaigns SET redemptions = redemptions + 1
              WHERE id = ? AND (max_redemptions IS NULL OR redemptions < max_redemptions)`).run(campaignId);
}

/** Give a redemption back when a counted (paid) session is refunded. */
function releaseRedemption(campaignId) {
  if (!campaignId) return;
  db.prepare('UPDATE campaigns SET redemptions = max(redemptions - 1, 0) WHERE id = ?').run(campaignId);
}

/** Resolve the requested stay start. mode 'reserve' reads local date/time fields. */
function resolveStart(location, body) {
  if (body.mode === 'reserve') {
    const start = zonedTimeToUtc(body.start_date, body.start_time, location.timezone);
    if (!start) return { error: 'Please pick a valid date and time for your reservation.' };
    if (start.getTime() < Date.now() - 5 * 60_000) return { error: 'That start time is in the past.' };
    if (start.getTime() > Date.now() + 90 * 86400_000) return { error: 'Reservations can be made up to 90 days ahead.' };
    return { start, kind: 'reservation' };
  }
  return { start: new Date(), kind: 'drive_up' };
}

// ---------------- landing ----------------

router.get('/', (req, res) => {
  const locations = db.prepare('SELECT * FROM locations WHERE active = 1 ORDER BY city, name').all();
  res.send(publicLayout({
    title: 'Find parking',
    body: `
<section class="hero">
  <h1>Park with PCA</h1>
  <p>Scan the QR code posted at any Parking Company of America lot or garage to pay in seconds — no app, no meter, no hassle. Or reserve your spot ahead of time.</p>
</section>
<section class="loc-list">
  <h2>Our locations</h2>
  ${locations.map((l) => `
  <a class="loc-card" href="/p/${esc(l.code)}">
    <div>
      <div class="loc-name">${esc(l.name)}</div>
      <div class="loc-addr">${esc(l.address)}, ${esc(l.city)}, ${esc(l.state)}</div>
      ${l.monthly_rate > 0 ? `<div class="loc-badges"><span class="badge">Monthly ${money(l.monthly_rate)}</span></div>` : ''}
    </div>
    <div class="loc-rate">${money(l.hourly_rate)}<span>/hr</span></div>
  </a>`).join('') || '<p>No locations available right now.</p>'}
</section>`,
  }));
});

// ---------------- payment page (QR target) ----------------

router.get('/p/:code', (req, res) => {
  const l = getLocationByCode(req.params.code);
  if (!l) {
    return res.status(404).send(publicLayout({
      title: 'Location not found',
      body: `<section class="pay-card"><h1>Location not found</h1><p>We couldn't find a parking location for this code. Please check the sign or visit our <a href="/">location list</a>.</p></section>`,
    }));
  }
  if (!l.active) {
    return res.status(410).send(publicLayout({
      title: l.name,
      body: `<section class="pay-card"><h1>${esc(l.name)}</h1><p>This location is temporarily closed for online payment. Please see posted signage for instructions.</p></section>`,
    }));
  }

  const stripeMode = stripe.enabled();
  const durations = [1, 2, 3, 4, 6, 8, 12, 24];
  const today = localToday(l.timezone);
  const maxDate = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
  const maxPassDate = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
  // Default reservation start: half an hour from now (location time), rounded up to :00/:30.
  const soon = localParts(new Date(Math.ceil((Date.now() + 30 * 60_000) / (30 * 60_000)) * 30 * 60_000), l.timezone);
  const defaultTime = `${String(Math.floor(soon.minutes / 60)).padStart(2, '0')}:${String(soon.minutes % 60).padStart(2, '0')}`;
  const err = req.query.err ? `<div class="quote-err" style="margin-bottom:14px">${esc(req.query.err)}</div>` : '';

  const cardFields = stripeMode ? '' : `
    <h2 class="step-pay">Payment</h2>
    <div class="cardbox">
      <label>Card number<input name="card_number" inputmode="numeric" required placeholder="4242 4242 4242 4242" maxlength="19"></label>
      <div class="card-row">
        <label>Expiry<input name="card_exp" required placeholder="MM/YY" maxlength="5"></label>
        <label>CVC<input name="card_cvc" inputmode="numeric" required placeholder="123" maxlength="4"></label>
      </div>
    </div>`;

  const payNote = stripeMode
    ? '<p class="fine">You\'ll be taken to our secure Stripe checkout to complete payment.</p>'
    : '';

  const durationGrid = (prefix) => `
    <div class="duration-grid">
      ${durations.map((h, i) => `<label class="duration ${i === 1 ? 'selected' : ''}">
        <input type="radio" name="hours" value="${h}" ${i === 1 ? 'checked' : ''}>
        <span class="d-hours">${h}h</span>
      </label>`).join('')}
    </div>`;

  const quoteBox = (id) => `
    <div class="quote-box" data-quote="${id}">
      <div class="quote-row"><span>Parking</span><span data-q="base">—</span></div>
      <div class="quote-row quote-discount hidden" data-q="discount-row"><span>Discount</span><span data-q="discount">—</span></div>
      <div class="quote-row quote-total"><span>Total due</span><span data-q="total">—</span></div>
      <div class="quote-notes" data-q="notes"></div>
      <div class="quote-err hidden" data-q="err"></div>
      <input type="hidden" name="expected_total" data-q="expected">
    </div>`;

  res.send(publicLayout({
    title: `Pay at ${l.name}`,
    body: `
<section class="pay-card">
  <div class="pay-loc">
    <h1>${esc(l.name)}</h1>
    <p class="pay-addr">${esc(l.address)}, ${esc(l.city)}, ${esc(l.state)} ${esc(l.zip)}</p>
    ${l.description ? `<p class="pay-desc">${esc(l.description)}</p>` : ''}
    <p class="pay-rates">Base rate <strong>${money(l.hourly_rate)}/hour</strong>${l.daily_max ? ` · Daily max <strong>${money(l.daily_max)}</strong>` : ''}${l.monthly_rate > 0 ? ` · Monthly <strong>${money(l.monthly_rate)}</strong>` : ''}</p>
  </div>
  ${err}
  <div class="tabs" role="tablist">
    <button class="tab active" data-tab="now" type="button">Park now</button>
    <button class="tab" data-tab="reserve" type="button">Reserve ahead</button>
    ${l.monthly_rate > 0 ? '<button class="tab" data-tab="monthly" type="button">Monthly pass</button>' : ''}
  </div>

  <!-- PARK NOW -->
  <form id="tab-now" class="tab-panel" method="post" action="/p/${esc(l.code)}/checkout" autocomplete="on">
    <input type="hidden" name="mode" value="now">
    <h2>Your vehicle</h2>
    <label>License plate<input name="plate" required maxlength="10" placeholder="ABC1234" style="text-transform:uppercase" autocomplete="off"></label>
    <label>Email for receipt <span class="opt">(optional)</span><input name="email" type="email" placeholder="you@example.com"></label>
    <h2>How long are you parking?</h2>
    ${durationGrid('now')}
    <label>Promo code <span class="opt">(optional)</span><input name="promo" placeholder="WELCOME20" style="text-transform:uppercase" autocomplete="off"></label>
    ${quoteBox('now')}
    ${cardFields}
    <button class="btn-pay" type="submit">Pay <span data-q="btn-total"></span></button>
    ${payNote}
    <p class="fine">Your parking session starts immediately and covers the selected duration.</p>
  </form>

  <!-- RESERVE AHEAD -->
  <form id="tab-reserve" class="tab-panel hidden" method="post" action="/p/${esc(l.code)}/checkout" autocomplete="on">
    <input type="hidden" name="mode" value="reserve">
    <h2>When do you arrive?</h2>
    <div class="card-row">
      <label>Date<input name="start_date" type="date" required value="${soon.date}" min="${today}" max="${maxDate}"></label>
      <label>Time<input name="start_time" type="time" required value="${defaultTime}"></label>
    </div>
    <h2>How long will you stay?</h2>
    ${durationGrid('reserve')}
    <h2>Your vehicle</h2>
    <label>License plate<input name="plate" required maxlength="10" placeholder="ABC1234" style="text-transform:uppercase" autocomplete="off"></label>
    <label>Email for confirmation <span class="opt">(optional)</span><input name="email" type="email" placeholder="you@example.com"></label>
    <label>Promo code <span class="opt">(optional)</span><input name="promo" placeholder="WELCOME20" style="text-transform:uppercase" autocomplete="off"></label>
    ${quoteBox('reserve')}
    ${cardFields}
    <button class="btn-pay" type="submit">Reserve &amp; pay <span data-q="btn-total"></span></button>
    ${payNote}
    <p class="fine">Free cancellation any time before your reservation starts — full refund.</p>
  </form>

  ${l.monthly_rate > 0 ? `
  <!-- MONTHLY PASS -->
  <form id="tab-monthly" class="tab-panel hidden" method="post" action="/p/${esc(l.code)}/monthly" autocomplete="on">
    <h2>Monthly parking pass</h2>
    <p class="pay-desc">Unlimited in-and-out parking at ${esc(l.name)} for <strong>${money(l.monthly_rate)}/month</strong>. Enforcement recognizes your plate automatically.</p>
    <label>Full name<input name="holder_name" required placeholder="Jane Driver"></label>
    <label>License plate<input name="plate" required maxlength="10" placeholder="ABC1234" style="text-transform:uppercase" autocomplete="off"></label>
    <label>Email <span class="opt">(for your pass &amp; renewals)</span><input name="email" type="email" required placeholder="you@example.com"></label>
    <label>Start date<input name="start_date" type="date" required value="${today}" min="${today}" max="${maxPassDate}"></label>
    <div class="quote-box">
      <div class="quote-row quote-total"><span>Total due today</span><span>${money(l.monthly_rate)}</span></div>
      <div class="quote-notes">Covers one month from your start date. Renew from your pass page.</div>
    </div>
    ${cardFields}
    <button class="btn-pay" type="submit">Buy pass · ${money(l.monthly_rate)}</button>
    ${payNote}
  </form>` : ''}
</section>
<script>
(function () {
  // tab switching
  document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + btn.dataset.tab));
  }));

  // live quotes for the two hourly forms
  ['now', 'reserve'].forEach((mode) => {
    const form = document.getElementById('tab-' + mode);
    if (!form) return;
    let timer = null;
    async function refresh() {
      const body = {
        code: ${JSON.stringify(l.code)},
        hours: Number(form.querySelector('input[name="hours"]:checked').value),
        promo: (form.querySelector('input[name="promo"]') || {}).value || ''
      };
      if (mode === 'reserve') {
        body.start_date = form.querySelector('input[name="start_date"]').value;
        body.start_time = form.querySelector('input[name="start_time"]').value;
        if (!body.start_date || !body.start_time) return;
      }
      try {
        const r = await fetch('/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const q = await r.json();
        if (!r.ok) throw new Error(q.error || 'quote failed');
        const el = (name) => form.querySelector('[data-q="' + name + '"]');
        el('base').textContent = q.baseFormatted;
        el('total').textContent = q.totalFormatted;
        el('btn-total').textContent = q.totalFormatted;
        el('expected').value = q.totalAmount;
        if (q.discountAmount > 0) { el('discount-row').classList.remove('hidden'); el('discount').textContent = '−' + q.discountFormatted; }
        else el('discount-row').classList.add('hidden');
        const notes = (q.notes || []).slice();
        if (q.spotsLeft != null && q.spotsLeft <= 10) notes.push(q.spotsLeft > 0 ? ('Only ' + q.spotsLeft + ' spots left') : 'Sold out for this time');
        el('notes').textContent = notes.join(' · ');
        const err = el('err');
        if (q.promoError) { err.textContent = q.promoError; err.classList.remove('hidden'); }
        else err.classList.add('hidden');
        form.querySelector('.btn-pay').disabled = q.spotsLeft != null && q.spotsLeft <= 0;
      } catch (e) { /* keep last good quote */ }
    }
    form.querySelectorAll('input[name="hours"]').forEach((elm) => elm.addEventListener('change', () => {
      form.querySelectorAll('.duration').forEach((d) => d.classList.toggle('selected', d.querySelector('input').checked));
      refresh();
    }));
    ['promo', 'start_date', 'start_time'].forEach((n) => {
      const elm = form.querySelector('input[name="' + n + '"]');
      if (elm) elm.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 400); });
    });
    refresh();
  });
})();
</script>`,
  }));
});

// ---------------- quote API ----------------

router.post('/api/quote', (req, res) => {
  const l = getLocationByCode(req.body.code);
  if (!l || !l.active) return res.status(404).json({ error: 'Unknown location' });
  const hours = Math.max(1, Math.min(168, Math.floor(Number(req.body.hours) || 1)));

  let start = new Date();
  if (req.body.start_date && req.body.start_time) {
    const parsed = zonedTimeToUtc(req.body.start_date, req.body.start_time, l.timezone);
    if (parsed) start = parsed;
  }
  const end = new Date(start.getTime() + hours * 3600_000);
  const q = quote(l, start, hours, req.body.promo);
  res.json({
    ...q,
    spotsLeft: Math.max(0, spotsLeft(l, start.toISOString(), end.toISOString())),
    baseFormatted: money(q.baseAmount),
    discountFormatted: money(q.discountAmount),
    totalFormatted: money(q.totalAmount),
  });
});

// ---------------- checkout (drive-up & reservations) ----------------

// Demo card processor used when Stripe isn't configured: validates format only
// (Luhn), never stores card data, and approves valid-format cards.
function chargeCard({ number, exp, cvc, amountCents }) {
  const digits = String(number || '').replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return { ok: false, error: 'Card number looks invalid.' };
  if (!/^\d{2}\/\d{2}$/.test(String(exp || ''))) return { ok: false, error: 'Expiry must be MM/YY.' };
  if (!/^\d{3,4}$/.test(String(cvc || ''))) return { ok: false, error: 'CVC looks invalid.' };
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  if (sum % 10 !== 0) return { ok: false, error: 'Card number failed validation.' };
  if (amountCents <= 0) return { ok: false, error: 'Nothing to charge.' };
  return { ok: true };
}

function payFail(res, location, msg) {
  return res.redirect(`/p/${encodeURIComponent(location.code)}?err=${encodeURIComponent(msg)}`);
}

router.post('/p/:code/checkout', async (req, res, next) => {
  try {
    const l = getLocationByCode(req.params.code);
    if (!l || !l.active) return res.status(404).send('Unknown location');

    const plate = cleanPlate(req.body.plate);
    const hours = Math.max(1, Math.min(168, parseInt(req.body.hours, 10) || 0));
    const email = String(req.body.email || '').trim().slice(0, 200);
    if (!plate) return payFail(res, l, 'Please enter your license plate.');

    const resolved = resolveStart(l, req.body);
    if (resolved.error) return payFail(res, l, resolved.error);
    const { start, kind } = resolved;
    const end = new Date(start.getTime() + hours * 3600_000);

    if (spotsLeft(l, start.toISOString(), end.toISOString()) <= 0) {
      return payFail(res, l, kind === 'reservation'
        ? 'Sorry — this location is sold out for that time window.'
        : 'Sorry — this location is currently full.');
    }

    // Recompute the price server-side — never trust a client-side total.
    const q = quote(l, start, hours, req.body.promo);
    if (req.body.promo && String(req.body.promo).trim() && q.promoError) return payFail(res, l, q.promoError);

    // If the price moved since the quote the driver saw (rate boundary crossed,
    // promo cap reached), send them back to review rather than charging silently.
    if (req.body.expected_total !== undefined && req.body.expected_total !== ''
        && Number(req.body.expected_total) !== q.totalAmount) {
      return payFail(res, l, `The price is now ${money(q.totalAmount)} (it changed since your quote) — please review and try again.`);
    }

    const ref = newReceiptRef();
    const insert = db.prepare(`INSERT INTO sessions
      (ref, location_id, plate, email, kind, start_ts, end_ts, hours, base_amount, discount_amount,
       total_amount, promo_code, campaign_id, payment_method, status, stripe_session_id, pricing_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    // Fully discounted stay: nothing to charge, record it directly.
    if (q.totalAmount === 0) {
      insert.run(ref, l.id, plate, email, kind, start.toISOString(), end.toISOString(), hours,
        q.baseAmount, q.discountAmount, 0, q.promoCode, q.campaignId,
        'comp', 'paid', null, q.notes.join('; '));
      countRedemption(q.campaignId);
      return res.redirect(`/r/${ref}`);
    }

    if (stripe.enabled()) {
      const label = kind === 'reservation'
        ? `Reservation at ${l.name} — ${hours}h`
        : `Parking at ${l.name} — ${hours}h`;
      const checkout = await stripe.createCheckoutSession({
        productName: label,
        description: `${l.address}, ${l.city}, ${l.state} · Plate ${plate}`,
        amountCents: q.totalAmount,
        ref,
        kind: 'session',
        successUrl: `${baseUrl(req)}/stripe/return?cs={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl(req)}/pay/cancelled?ref=${ref}`,
        customerEmail: email || undefined,
      });
      // Re-check capacity after the await: another request may have taken the
      // last spot while the Stripe call was in flight. The check and insert
      // run in one synchronous block, so they can't interleave.
      if (spotsLeft(l, start.toISOString(), end.toISOString()) <= 0) {
        return payFail(res, l, 'Sorry — the last spot was taken while starting your checkout. Please try another time.');
      }
      insert.run(ref, l.id, plate, email, kind, start.toISOString(), end.toISOString(), hours,
        q.baseAmount, q.discountAmount, q.totalAmount, q.promoCode, q.campaignId,
        'stripe', 'pending', checkout.id, q.notes.join('; '));
      return res.redirect(303, checkout.url);
    }

    const charge = chargeCard({
      number: req.body.card_number, exp: req.body.card_exp, cvc: req.body.card_cvc,
      amountCents: q.totalAmount,
    });
    if (!charge.ok) return payFail(res, l, charge.error);

    insert.run(ref, l.id, plate, email, kind, start.toISOString(), end.toISOString(), hours,
      q.baseAmount, q.discountAmount, q.totalAmount, q.promoCode, q.campaignId,
      'demo', 'paid', null, q.notes.join('; '));
    countRedemption(q.campaignId);
    res.redirect(`/r/${ref}`);
  } catch (err) {
    next(err);
  }
});

// ---------------- monthly passes ----------------

router.post('/p/:code/monthly', async (req, res, next) => {
  try {
    const l = getLocationByCode(req.params.code);
    if (!l || !l.active || !(l.monthly_rate > 0)) return res.status(404).send('Monthly parking is not offered here.');

    const plate = cleanPlate(req.body.plate);
    const holder = String(req.body.holder_name || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().slice(0, 200);
    if (!plate) return payFail(res, l, 'Please enter your license plate.');
    if (!holder) return payFail(res, l, 'Please enter the pass holder\'s name.');

    const today = localToday(l.timezone);
    const startsOn = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.start_date || '')) ? req.body.start_date : today;
    if (startsOn < today) return payFail(res, l, 'Pass start date can\'t be in the past.');
    const maxStart = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
    if (startsOn > maxStart) return payFail(res, l, 'Passes can start at most 60 days ahead.');
    const endsOn = addOneMonth(startsOn);

    const ref = newReceiptRef();
    const insert = db.prepare(`INSERT INTO passes
      (ref, location_id, plate, holder_name, email, amount, starts_on, ends_on, status, payment_method, stripe_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    if (stripe.enabled()) {
      const checkout = await stripe.createCheckoutSession({
        productName: `Monthly parking pass — ${l.name}`,
        description: `${startsOn} to ${endsOn} · Plate ${plate}`,
        amountCents: l.monthly_rate,
        ref,
        kind: 'pass',
        successUrl: `${baseUrl(req)}/stripe/return?cs={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl(req)}/pass/cancelled?ref=${ref}`,
        customerEmail: email || undefined,
      });
      insert.run(ref, l.id, plate, holder, email, l.monthly_rate, startsOn, endsOn, 'pending', 'stripe', checkout.id);
      return res.redirect(303, checkout.url);
    }

    const charge = chargeCard({
      number: req.body.card_number, exp: req.body.card_exp, cvc: req.body.card_cvc,
      amountCents: l.monthly_rate,
    });
    if (!charge.ok) return payFail(res, l, charge.error);

    insert.run(ref, l.id, plate, holder, email, l.monthly_rate, startsOn, endsOn, 'paid', 'demo', null);
    res.redirect(`/pass/${ref}`);
  } catch (err) {
    next(err);
  }
});

// NOTE: registered before /pass/:ref so "cancelled" isn't captured as a ref.
router.get('/pass/cancelled', (req, res) => {
  const p = db.prepare(`SELECT p.*, l.code AS location_code FROM passes p JOIN locations l ON l.id = p.location_id WHERE p.ref = ?`)
    .get(String(req.query.ref || '').toUpperCase());
  if (p && p.status === 'pending') db.prepare("UPDATE passes SET status = 'void' WHERE id = ? AND status = 'pending'").run(p.id);
  cancelledPage(res, p ? `/p/${p.location_code}` : '/', 'pass');
});

// Pass page: status, period, renewal.
router.get('/pass/:ref', (req, res) => {
  const p = db.prepare(`SELECT p.*, l.name AS location_name, l.address, l.city, l.state, l.timezone, l.monthly_rate, l.active AS location_active
    FROM passes p JOIN locations l ON l.id = p.location_id WHERE p.ref = ?`).get(String(req.params.ref || '').toUpperCase());
  if (!p) return res.status(404).send(publicLayout({ title: 'Pass not found', body: '<section class="pay-card"><h1>Pass not found</h1></section>' }));

  const today = localToday(p.timezone);
  const isActive = p.status === 'paid' && p.starts_on <= today && p.ends_on > today;
  const isFuture = p.status === 'paid' && p.starts_on > today;
  const statusLabel = p.status !== 'paid' ? p.status.toUpperCase()
    : isActive ? '✓ PASS ACTIVE'
    : isFuture ? `STARTS ${p.starts_on}`
    : 'EXPIRED';
  const canRenew = p.status === 'paid' && p.location_active && p.monthly_rate > 0;
  const err = req.query.err ? `<div class="quote-err" style="margin:12px 0">${esc(req.query.err)}</div>` : '';

  res.send(publicLayout({
    title: `Pass ${p.ref}`,
    body: `
<section class="pay-card receipt">
  <div class="receipt-status ${isActive ? 'active' : 'inactive'}">${esc(statusLabel)}</div>
  <h1>${esc(p.location_name)}</h1>
  <p class="pay-addr">${esc(p.address)}, ${esc(p.city)}, ${esc(p.state)}</p>
  <dl class="receipt-dl">
    <dt>Pass</dt><dd class="mono">${esc(p.ref)}</dd>
    <dt>Holder</dt><dd>${esc(p.holder_name)}</dd>
    <dt>Plate</dt><dd class="mono">${esc(p.plate)}</dd>
    <dt>Valid from</dt><dd>${esc(p.starts_on)}</dd>
    <dt>Valid through</dt><dd><strong>${esc(inclusiveEnd(p.ends_on))}</strong> (all day)</dd>
    <dt>Paid</dt><dd><strong>${money(p.amount)}</strong></dd>
  </dl>
  ${err}
  ${canRenew ? `
  <form method="post" action="/pass/${esc(p.ref)}/renew">
    <h2 style="font-size:13px;color:#e8272b;text-transform:uppercase;letter-spacing:.07em;margin:18px 0 10px">Renew for another month</h2>
    <p class="fine">Adds one month to this plate's coverage at ${money(p.monthly_rate)} — starting when your current coverage ends.</p>
    ${stripe.enabled() ? '' : `
    <div class="cardbox">
      <label>Card number<input name="card_number" inputmode="numeric" required placeholder="4242 4242 4242 4242" maxlength="19"></label>
      <div class="card-row">
        <label>Expiry<input name="card_exp" required placeholder="MM/YY" maxlength="5"></label>
        <label>CVC<input name="card_cvc" inputmode="numeric" required placeholder="123" maxlength="4"></label>
      </div>
    </div>`}
    <button class="btn-pay" type="submit">Renew · ${money(p.monthly_rate)}</button>
  </form>` : ''}
  <p class="fine">Keep this page bookmarked — your pass reference is <strong class="mono">${esc(p.ref)}</strong>.</p>
</section>`,
  }));
});

router.post('/pass/:ref/renew', async (req, res, next) => {
  try {
    const p = db.prepare(`SELECT p.*, l.name AS location_name, l.address, l.city, l.state, l.timezone,
        l.monthly_rate, l.active AS location_active, l.code AS location_code
      FROM passes p JOIN locations l ON l.id = p.location_id WHERE p.ref = ?`).get(String(req.params.ref || '').toUpperCase());
    if (!p) return res.status(404).send('Pass not found');
    if (p.status !== 'paid' || !p.location_active || !(p.monthly_rate > 0)) {
      return res.redirect(`/pass/${p ? p.ref : ''}?err=${encodeURIComponent('This pass can\'t be renewed online. Contact PCA support.')}`);
    }

    // Anchor the renewal to the plate's LATEST paid coverage at this location
    // (not this particular pass row), so renewing an old pass can't double-sell
    // a month that a newer pass already covers.
    const today = localToday(p.timezone);
    const latestEnd = db.prepare(`SELECT MAX(ends_on) m FROM passes
      WHERE location_id = ? AND plate = ? AND status = 'paid'`).get(p.location_id, p.plate).m;
    const startsOn = latestEnd && latestEnd > today ? latestEnd : today;
    const endsOn = addOneMonth(startsOn);
    const ref = newReceiptRef();
    const insert = db.prepare(`INSERT INTO passes
      (ref, location_id, plate, holder_name, email, amount, starts_on, ends_on, status, payment_method, stripe_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    if (stripe.enabled()) {
      const checkout = await stripe.createCheckoutSession({
        productName: `Pass renewal — ${p.location_name}`,
        description: `${startsOn} to ${endsOn} · Plate ${p.plate}`,
        amountCents: p.monthly_rate,
        ref,
        kind: 'pass',
        successUrl: `${baseUrl(req)}/stripe/return?cs={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl(req)}/pass/cancelled?ref=${ref}`,
        customerEmail: p.email || undefined,
      });
      insert.run(ref, p.location_id, p.plate, p.holder_name, p.email, p.monthly_rate, startsOn, endsOn, 'pending', 'stripe', checkout.id);
      return res.redirect(303, checkout.url);
    }

    const charge = chargeCard({
      number: req.body.card_number, exp: req.body.card_exp, cvc: req.body.card_cvc,
      amountCents: p.monthly_rate,
    });
    if (!charge.ok) return res.redirect(`/pass/${p.ref}?err=${encodeURIComponent(charge.error)}`);

    insert.run(ref, p.location_id, p.plate, p.holder_name, p.email, p.monthly_rate, startsOn, endsOn, 'paid', 'demo', null);
    res.redirect(`/pass/${ref}`);
  } catch (err) {
    next(err);
  }
});

// ---------------- Stripe return, cancel, webhook ----------------

/**
 * Refund a captured payment and mark the row refunded. Used when money arrives
 * for a row we can no longer honor (checkout was cancelled locally, or the lot
 * filled while the driver was paying). If the refund API call fails, the
 * payment intent is still recorded so an operator can refund manually.
 */
async function refundOrphanedPayment(table, row, pi, reason) {
  try {
    if (pi) await stripe.refundPaymentIntent(pi);
    db.prepare(`UPDATE ${table} SET status = 'refunded', stripe_payment_intent = ? WHERE id = ?`).run(pi, row.id);
    console.warn(`[stripe] auto-refunded ${table} ${row.ref}: ${reason}`);
  } catch (e) {
    db.prepare(`UPDATE ${table} SET stripe_payment_intent = ? WHERE id = ?`).run(pi, row.id);
    console.error(`[stripe] REFUND FAILED for ${table} ${row.ref} (${pi}): ${e.message} — refund manually in the Stripe dashboard`);
  }
}

/**
 * Reconcile a Stripe checkout that reports payment_status='paid' (idempotent —
 * reached from both the driver's return trip and the webhook).
 * Returns { path, err? } for a redirect, or null if the checkout is unknown.
 */
async function completeStripeCheckout(checkoutSession) {
  if (checkoutSession.payment_status !== 'paid') return null;
  const pi = typeof checkoutSession.payment_intent === 'string'
    ? checkoutSession.payment_intent
    : checkoutSession.payment_intent?.id || null;

  const s = db.prepare('SELECT * FROM sessions WHERE stripe_session_id = ?').get(checkoutSession.id);
  if (s) {
    if (s.status === 'pending') {
      // The capacity hold may have lapsed while the driver was on Stripe's page —
      // never flip to paid if honoring it would oversell the window.
      const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(s.location_id);
      const othersOverlapping = db.prepare(`
        SELECT COUNT(*) n FROM sessions
        WHERE location_id = ? AND id != ?
          AND (status = 'paid' OR (status = 'pending' AND created_at >= datetime('now','-30 minutes')))
          AND start_ts < ? AND end_ts > ?`).get(s.location_id, s.id, s.end_ts, s.start_ts).n;
      if (othersOverlapping >= l.capacity) {
        await refundOrphanedPayment('sessions', s, pi, 'lot filled before payment completed');
        return { path: `/r/${s.ref}`, err: 'The lot filled up while your payment was processing — your card has been refunded in full.' };
      }
      const updated = db.prepare("UPDATE sessions SET status = 'paid', stripe_payment_intent = ? WHERE id = ? AND status = 'pending'").run(pi, s.id);
      if (updated.changes === 1) countRedemption(s.campaign_id);
    } else if (s.status === 'void') {
      // Checkout was cancelled locally but the driver paid the still-open Stripe
      // page anyway — money arrived for a dead row, so send it straight back.
      await refundOrphanedPayment('sessions', s, pi, 'payment landed on a cancelled checkout');
      return { path: `/r/${s.ref}`, err: 'This checkout was cancelled, so your payment has been refunded in full. Start a new session if you still need parking.' };
    }
    return { path: `/r/${s.ref}` };
  }

  const p = db.prepare('SELECT * FROM passes WHERE stripe_session_id = ?').get(checkoutSession.id);
  if (p) {
    if (p.status === 'pending') {
      db.prepare("UPDATE passes SET status = 'paid', stripe_payment_intent = ? WHERE id = ? AND status = 'pending'").run(pi, p.id);
    } else if (p.status === 'void') {
      await refundOrphanedPayment('passes', p, pi, 'payment landed on a cancelled pass checkout');
      return { path: `/pass/${p.ref}`, err: 'This checkout was cancelled, so your payment has been refunded in full.' };
    }
    return { path: `/pass/${p.ref}` };
  }
  return null;
}

router.get('/stripe/return', async (req, res, next) => {
  try {
    if (!stripe.enabled() || !req.query.cs) return res.redirect('/');
    const checkout = await stripe.getCheckoutSession(String(req.query.cs));
    const dest = await completeStripeCheckout(checkout);
    if (dest) return res.redirect(dest.err ? `${dest.path}?err=${encodeURIComponent(dest.err)}` : dest.path);
    res.status(402).send(publicLayout({
      title: 'Payment incomplete',
      body: `<section class="pay-card"><h1>Payment not completed</h1>
        <p>Your payment hasn't gone through yet. If you were charged, your receipt will activate automatically — otherwise please try again.</p>
        <p><a class="btn-pay btn-link" href="/">← Back to locations</a></p></section>`,
    }));
  } catch (err) {
    next(err);
  }
});

function cancelledPage(res, backUrl, what) {
  res.send(publicLayout({
    title: 'Checkout cancelled',
    body: `<section class="pay-card"><h1>Checkout cancelled</h1>
      <p>No charge was made. Your ${what} was not created.</p>
      <p><a class="btn-pay btn-link" href="${esc(backUrl)}">← Try again</a></p></section>`,
  }));
}

router.get('/pay/cancelled', (req, res) => {
  const s = db.prepare(`SELECT s.*, l.code AS location_code FROM sessions s JOIN locations l ON l.id = s.location_id WHERE s.ref = ?`)
    .get(String(req.query.ref || '').toUpperCase());
  if (s && s.status === 'pending') db.prepare("UPDATE sessions SET status = 'void' WHERE id = ? AND status = 'pending'").run(s.id);
  cancelledPage(res, s ? `/p/${s.location_code}` : '/', 'parking session');
});

// Webhook backstop: completes payment even if the driver never returns from Stripe.
// Mounted with express.raw() in server.js so the signature can be verified.
router.post('/webhooks/stripe', async (req, res, next) => {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(400).json({ error: 'STRIPE_WEBHOOK_SECRET not configured' });
    const event = stripe.verifyWebhook(req.body, req.headers['stripe-signature'], secret);
    if (!event) return res.status(400).json({ error: 'Invalid signature' });

    if (event.type === 'checkout.session.completed') {
      await completeStripeCheckout(event.data.object);
    } else if (event.type === 'checkout.session.expired') {
      const id = event.data.object.id;
      db.prepare("UPDATE sessions SET status = 'void' WHERE stripe_session_id = ? AND status = 'pending'").run(id);
      db.prepare("UPDATE passes SET status = 'void' WHERE stripe_session_id = ? AND status = 'pending'").run(id);
    }
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});

// ---------------- receipt / reservation management ----------------

router.get('/r/:ref', (req, res) => {
  const s = db.prepare(`SELECT s.*, l.name AS location_name, l.address, l.city, l.state, l.timezone
    FROM sessions s JOIN locations l ON l.id = s.location_id WHERE s.ref = ?`).get(String(req.params.ref || '').toUpperCase());
  if (!s) return res.status(404).send(publicLayout({ title: 'Receipt not found', body: '<section class="pay-card"><h1>Receipt not found</h1></section>' }));

  const fmt = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: s.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const isFuture = new Date(s.start_ts) > now;
  const activeNow = s.status === 'paid' && new Date(s.start_ts) <= now && new Date(s.end_ts) > now;
  const statusLabel = s.status === 'pending' ? 'AWAITING PAYMENT'
    : s.status !== 'paid' ? s.status.toUpperCase()
    : activeNow ? '✓ PARKING ACTIVE'
    : isFuture ? `✓ RESERVED — STARTS ${fmt(s.start_ts).toUpperCase()}`
    : 'SESSION ENDED';
  const canCancel = s.kind === 'reservation' && s.status === 'paid' && isFuture;
  const err = req.query.err ? `<div class="quote-err" style="margin:12px 0">${esc(req.query.err)}</div>` : '';

  res.send(publicLayout({
    title: `Receipt ${s.ref}`,
    body: `
<section class="pay-card receipt">
  <div class="receipt-status ${activeNow || (s.status === 'paid' && isFuture) ? 'active' : 'inactive'}">${esc(statusLabel)}</div>
  <h1>${esc(s.location_name)}</h1>
  <p class="pay-addr">${esc(s.address)}, ${esc(s.city)}, ${esc(s.state)}</p>
  <dl class="receipt-dl">
    <dt>${s.kind === 'reservation' ? 'Reservation' : 'Receipt'}</dt><dd class="mono">${esc(s.ref)}</dd>
    <dt>Plate</dt><dd class="mono">${esc(s.plate)}</dd>
    <dt>Valid from</dt><dd>${fmt(s.start_ts)}</dd>
    <dt>Valid until</dt><dd><strong>${fmt(s.end_ts)}</strong></dd>
    <dt>Parking</dt><dd>${money(s.base_amount)}</dd>
    ${s.discount_amount ? `<dt>Discount${s.promo_code ? ` (${esc(s.promo_code)})` : ''}</dt><dd>−${money(s.discount_amount)}</dd>` : ''}
    <dt>Total paid</dt><dd><strong>${money(s.total_amount)}</strong></dd>
  </dl>
  ${err}
  ${canCancel ? `
  <form method="post" action="/r/${esc(s.ref)}/cancel" onsubmit="return confirm('Cancel this reservation? You will receive a full refund of ${money(s.total_amount)}.')">
    <button class="btn-pay btn-cancel" type="submit">Cancel reservation — full refund</button>
  </form>` : ''}
  ${s.pricing_notes ? `<p class="fine">${esc(s.pricing_notes)}</p>` : ''}
  <p class="fine">Keep this page or note your reference. Enforcement checks by license plate — no dashboard display needed.</p>
</section>`,
  }));
});

router.post('/r/:ref/cancel', async (req, res, next) => {
  try {
    const s = db.prepare('SELECT * FROM sessions WHERE ref = ?').get(String(req.params.ref || '').toUpperCase());
    if (!s) return res.status(404).send('Not found');
    const isFuture = new Date(s.start_ts) > new Date();
    if (!(s.kind === 'reservation' && s.status === 'paid' && isFuture)) {
      return res.redirect(`/r/${s.ref}?err=${encodeURIComponent('This reservation can no longer be cancelled online.')}`);
    }
    if (s.payment_method === 'stripe' && s.stripe_payment_intent) {
      try {
        await stripe.refundPaymentIntent(s.stripe_payment_intent);
      } catch (e) {
        return res.redirect(`/r/${s.ref}?err=${encodeURIComponent(`Refund failed: ${e.message}. Please contact PCA support.`)}`);
      }
    }
    const updated = db.prepare("UPDATE sessions SET status = 'refunded' WHERE id = ? AND status = 'paid'").run(s.id);
    if (updated.changes === 1) releaseRedemption(s.campaign_id);
    res.redirect(`/r/${s.ref}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
