'use strict';

const express = require('express');
const { db, newReceiptRef } = require('../db');
const { esc, publicLayout } = require('../views/layout');
const { quote, money } = require('../pricing');

const router = express.Router();

function getLocationByCode(code) {
  return db.prepare('SELECT * FROM locations WHERE code = ? COLLATE NOCASE').get(String(code || '').trim());
}

// Landing page — find a PCA location.
router.get('/', (req, res) => {
  const locations = db.prepare('SELECT * FROM locations WHERE active = 1 ORDER BY city, name').all();
  res.send(publicLayout({
    title: 'Find parking',
    body: `
<section class="hero">
  <h1>Park with PCA</h1>
  <p>Scan the QR code posted at any Parking Company of America lot or garage to pay in seconds — no app, no meter, no hassle.</p>
</section>
<section class="loc-list">
  <h2>Our locations</h2>
  ${locations.map((l) => `
  <a class="loc-card" href="/p/${esc(l.code)}">
    <div>
      <div class="loc-name">${esc(l.name)}</div>
      <div class="loc-addr">${esc(l.address)}, ${esc(l.city)}, ${esc(l.state)}</div>
    </div>
    <div class="loc-rate">${money(l.hourly_rate)}<span>/hr</span></div>
  </a>`).join('') || '<p>No locations available right now.</p>'}
</section>`,
  }));
});

// Payment page for one location — this is where each location's QR code points.
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
  const durations = [1, 2, 3, 4, 6, 8, 12, 24];
  res.send(publicLayout({
    title: `Pay at ${l.name}`,
    body: `
<section class="pay-card">
  <div class="pay-loc">
    <h1>${esc(l.name)}</h1>
    <p class="pay-addr">${esc(l.address)}, ${esc(l.city)}, ${esc(l.state)} ${esc(l.zip)}</p>
    ${l.description ? `<p class="pay-desc">${esc(l.description)}</p>` : ''}
    <p class="pay-rates">Base rate <strong>${money(l.hourly_rate)}/hour</strong>${l.daily_max ? ` · Daily max <strong>${money(l.daily_max)}</strong>` : ''}</p>
  </div>

  <form id="payform" method="post" action="/p/${esc(l.code)}/checkout" autocomplete="on">
    <h2>1 · Your vehicle</h2>
    <label>License plate
      <input name="plate" id="plate" required maxlength="10" placeholder="ABC1234" style="text-transform:uppercase" autocomplete="off">
    </label>
    <label>Email for receipt <span class="opt">(optional)</span>
      <input name="email" type="email" placeholder="you@example.com">
    </label>

    <h2>2 · How long are you parking?</h2>
    <div class="duration-grid" id="durations">
      ${durations.map((h, i) => `<label class="duration ${i === 1 ? 'selected' : ''}">
        <input type="radio" name="hours" value="${h}" ${i === 1 ? 'checked' : ''}>
        <span class="d-hours">${h < 24 ? `${h}h` : '24h'}</span>
      </label>`).join('')}
    </div>

    <label>Promo code <span class="opt">(optional)</span>
      <input name="promo" id="promo" placeholder="WELCOME20" style="text-transform:uppercase" autocomplete="off">
    </label>

    <div class="quote-box" id="quotebox">
      <div class="quote-row"><span>Parking</span><span id="q-base">—</span></div>
      <div class="quote-row quote-discount hidden" id="q-discount-row"><span>Discount</span><span id="q-discount">—</span></div>
      <div class="quote-row quote-total"><span>Total due</span><span id="q-total">—</span></div>
      <div class="quote-notes" id="q-notes"></div>
      <div class="quote-err hidden" id="q-err"></div>
    </div>

    <h2>3 · Payment</h2>
    <div class="cardbox">
      <label>Card number<input name="card_number" inputmode="numeric" required placeholder="4242 4242 4242 4242" maxlength="19"></label>
      <div class="card-row">
        <label>Expiry<input name="card_exp" required placeholder="MM/YY" maxlength="5"></label>
        <label>CVC<input name="card_cvc" inputmode="numeric" required placeholder="123" maxlength="4"></label>
      </div>
    </div>

    <button class="btn-pay" type="submit" id="paybtn">Pay <span id="btn-total"></span></button>
    <p class="fine">Your parking session starts immediately and covers the selected duration. Receipt reference will be shown after payment.</p>
  </form>
</section>
<script>
(function () {
  const form = document.getElementById('payform');
  const promoEl = document.getElementById('promo');
  let timer = null;

  async function refreshQuote() {
    const hours = form.querySelector('input[name="hours"]:checked').value;
    const promo = promoEl.value.trim();
    try {
      const r = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ${JSON.stringify(l.code)}, hours: Number(hours), promo })
      });
      const q = await r.json();
      if (!r.ok) throw new Error(q.error || 'quote failed');
      document.getElementById('q-base').textContent = q.baseFormatted;
      document.getElementById('q-total').textContent = q.totalFormatted;
      document.getElementById('btn-total').textContent = q.totalFormatted;
      const dRow = document.getElementById('q-discount-row');
      if (q.discountAmount > 0) {
        dRow.classList.remove('hidden');
        document.getElementById('q-discount').textContent = '−' + q.discountFormatted;
      } else dRow.classList.add('hidden');
      document.getElementById('q-notes').textContent = (q.notes || []).join(' · ');
      const err = document.getElementById('q-err');
      if (q.promoError) { err.textContent = q.promoError; err.classList.remove('hidden'); }
      else err.classList.add('hidden');
    } catch (e) { /* leave last good quote in place */ }
  }

  form.querySelectorAll('input[name="hours"]').forEach((el) => el.addEventListener('change', () => {
    form.querySelectorAll('.duration').forEach((d) => d.classList.toggle('selected', d.querySelector('input').checked));
    refreshQuote();
  }));
  promoEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refreshQuote, 400); });
  refreshQuote();
})();
</script>`,
  }));
});

// Live price quote used by the payment page.
router.post('/api/quote', (req, res) => {
  const l = getLocationByCode(req.body.code);
  if (!l || !l.active) return res.status(404).json({ error: 'Unknown location' });
  const hours = Number(req.body.hours) || 1;
  const q = quote(l, new Date(), hours, req.body.promo);
  res.json({
    ...q,
    baseFormatted: money(q.baseAmount),
    discountFormatted: money(q.discountAmount),
    totalFormatted: money(q.totalAmount),
  });
});

// Checkout — charge the card and open a parking session.
// Card handling here is a built-in demo processor: it validates format only and never
// stores card data. Swap `chargeCard` with a Stripe/Adyen/etc. integration for production.
function chargeCard({ number, exp, cvc, amountCents }) {
  const digits = String(number || '').replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return { ok: false, error: 'Card number looks invalid.' };
  if (!/^\d{2}\/\d{2}$/.test(String(exp || ''))) return { ok: false, error: 'Expiry must be MM/YY.' };
  if (!/^\d{3,4}$/.test(String(cvc || ''))) return { ok: false, error: 'CVC looks invalid.' };
  // Luhn check
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

router.post('/p/:code/checkout', (req, res) => {
  const l = getLocationByCode(req.params.code);
  if (!l || !l.active) return res.status(404).send('Unknown location');

  const plate = String(req.body.plate || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const hours = Math.max(1, Math.min(168, parseInt(req.body.hours, 10) || 0));
  const email = String(req.body.email || '').trim();

  const fail = (msg) => res.status(400).send(publicLayout({
    title: 'Payment problem',
    body: `<section class="pay-card"><h1>We couldn't complete your payment</h1>
      <div class="quote-err">${esc(msg)}</div>
      <p><a class="btn-pay btn-link" href="/p/${esc(l.code)}">← Try again</a></p></section>`,
  }));

  if (!plate) return fail('Please enter your license plate.');
  if (!hours) return fail('Please choose a parking duration.');

  // Recompute the price server-side — never trust a client-side total.
  const q = quote(l, new Date(), hours, req.body.promo);
  if (req.body.promo && String(req.body.promo).trim() && q.promoError) return fail(q.promoError);

  const charge = chargeCard({
    number: req.body.card_number,
    exp: req.body.card_exp,
    cvc: req.body.card_cvc,
    amountCents: q.totalAmount,
  });
  if (!charge.ok) return fail(charge.error);

  const start = new Date();
  const end = new Date(start.getTime() + hours * 3600_000);
  const ref = newReceiptRef();

  const insert = db.prepare(`INSERT INTO sessions
    (ref, location_id, plate, email, start_ts, end_ts, hours, base_amount, discount_amount, total_amount, promo_code, campaign_id, payment_method, pricing_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'card', ?)`);
  insert.run(ref, l.id, plate, email, start.toISOString(), end.toISOString(), hours,
    q.baseAmount, q.discountAmount, q.totalAmount, q.promoCode, q.campaignId, q.notes.join('; '));
  if (q.campaignId) db.prepare('UPDATE campaigns SET redemptions = redemptions + 1 WHERE id = ?').run(q.campaignId);

  res.redirect(`/r/${ref}`);
});

// Receipt / active session confirmation.
router.get('/r/:ref', (req, res) => {
  const s = db.prepare(`SELECT s.*, l.name AS location_name, l.address, l.city, l.state, l.timezone
    FROM sessions s JOIN locations l ON l.id = s.location_id WHERE s.ref = ?`).get(String(req.params.ref || '').toUpperCase());
  if (!s) return res.status(404).send(publicLayout({ title: 'Receipt not found', body: '<section class="pay-card"><h1>Receipt not found</h1></section>' }));
  const fmt = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: s.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const activeNow = s.status === 'paid' && new Date(s.start_ts) <= new Date() && new Date(s.end_ts) > new Date();
  res.send(publicLayout({
    title: `Receipt ${s.ref}`,
    body: `
<section class="pay-card receipt">
  <div class="receipt-status ${activeNow ? 'active' : 'inactive'}">${activeNow ? '✓ PARKING ACTIVE' : (s.status === 'paid' ? 'SESSION ENDED' : s.status.toUpperCase())}</div>
  <h1>${esc(s.location_name)}</h1>
  <p class="pay-addr">${esc(s.address)}, ${esc(s.city)}, ${esc(s.state)}</p>
  <dl class="receipt-dl">
    <dt>Receipt</dt><dd class="mono">${esc(s.ref)}</dd>
    <dt>Plate</dt><dd class="mono">${esc(s.plate)}</dd>
    <dt>Valid from</dt><dd>${fmt(s.start_ts)}</dd>
    <dt>Valid until</dt><dd><strong>${fmt(s.end_ts)}</strong></dd>
    <dt>Parking</dt><dd>${money(s.base_amount)}</dd>
    ${s.discount_amount ? `<dt>Discount${s.promo_code ? ` (${esc(s.promo_code)})` : ''}</dt><dd>−${money(s.discount_amount)}</dd>` : ''}
    <dt>Total paid</dt><dd><strong>${money(s.total_amount)}</strong></dd>
  </dl>
  ${s.pricing_notes ? `<p class="fine">${esc(s.pricing_notes)}</p>` : ''}
  <p class="fine">Keep this page or note your receipt reference. Enforcement checks by license plate — no dashboard display needed.</p>
</section>`,
  }));
});

module.exports = router;
