'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { db } = require('../db');
const { uniqueLocationCode } = require('../db');
const { login, setSessionCookie, clearSessionCookie, requireAdmin } = require('../auth');
const { esc, adminLayout, LOGO_SVG } = require('../views/layout');
const { money } = require('../pricing');

const router = express.Router();

function baseUrl(req) {
  return (process.env.PCA_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function payUrl(req, location) {
  return `${baseUrl(req)}/p/${location.code}`;
}

function flashFromQuery(req) {
  if (req.query.ok) return { type: 'ok', msg: req.query.ok };
  if (req.query.err) return { type: 'err', msg: req.query.err };
  return null;
}

function page(req, res, opts) {
  res.send(adminLayout({ admin: req.admin, flash: flashFromQuery(req), ...opts }));
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dowLabel(csv) {
  const days = String(csv).split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  if (days.length === 7) return 'Every day';
  return days.map((d) => DOW[d] ?? '?').join(', ');
}

function ruleValueLabel(r) {
  if (r.rule_type === 'multiplier') return `× ${r.value}`;
  if (r.rule_type === 'override') return `${money(Math.round(r.value))}/hr`;
  return `${money(Math.round(r.value))} flat${r.max_hours ? ` (≤ ${r.max_hours}h)` : ''}`;
}

function locationOptions(selectedId, { includeAll = true, allLabel = 'All locations' } = {}) {
  const locs = db.prepare('SELECT id, name FROM locations ORDER BY name').all();
  const opts = locs.map((l) =>
    `<option value="${l.id}" ${Number(selectedId) === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  return (includeAll ? `<option value="">${esc(allLabel)}</option>` : '') + opts;
}

// ---------------- auth ----------------

router.get('/login', (req, res) => {
  res.send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · PCA Admin</title>
<link rel="stylesheet" href="/assets/admin.css">
</head><body class="login-body">
<div class="login-card">
  <div class="login-brand">${LOGO_SVG}<div><strong>Parking Company of America</strong><br><span class="muted">Operations Console</span></div></div>
  ${req.query.err ? `<div class="flash flash-err">${esc(req.query.err)}</div>` : ''}
  <form method="post" action="/admin/login">
    <label>Email<input type="email" name="email" required autofocus placeholder="admin@parkwithpca.com"></label>
    <label>Password<input type="password" name="password" required></label>
    <button class="btn btn-primary btn-block" type="submit">Sign in</button>
  </form>
</div>
</body></html>`);
});

router.post('/login', (req, res) => {
  const user = login(req.body.email, req.body.password);
  if (!user) return res.redirect('/admin/login?err=' + encodeURIComponent('Invalid email or password.'));
  setSessionCookie(res, user);
  res.redirect('/admin');
});

router.get('/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/admin/login');
});

// Everything below requires an authenticated admin.
router.use(requireAdmin);

// ---------------- dashboard ----------------

router.get('/', (req, res) => {
  const now = new Date().toISOString();
  const stats = {
    today: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) amt FROM sessions
                       WHERE status='paid' AND date(created_at)=date('now')`).get(),
    week: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) amt FROM sessions
                      WHERE status='paid' AND created_at >= datetime('now','-7 days')`).get(),
    all: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) amt FROM sessions WHERE status='paid'`).get(),
    active: db.prepare(`SELECT COUNT(*) n FROM sessions WHERE status='paid' AND start_ts <= ? AND end_ts > ?`).get(now, now),
  };
  const occupancy = db.prepare(`
    SELECT l.id, l.name, l.capacity, l.active,
      (SELECT COUNT(*) FROM sessions s WHERE s.location_id = l.id AND s.status='paid' AND s.start_ts <= ? AND s.end_ts > ?) AS occupied
    FROM locations l ORDER BY l.name`).all(now, now);
  const recent = db.prepare(`
    SELECT s.*, l.name AS location_name FROM sessions s JOIN locations l ON l.id = s.location_id
    ORDER BY s.id DESC LIMIT 10`).all();

  page(req, res, {
    title: 'Dashboard', active: 'dashboard',
    body: `
<h1>Dashboard</h1>
<div class="stat-grid">
  <div class="stat"><div class="stat-label">Revenue today</div><div class="stat-value">${money(stats.today.amt)}</div><div class="stat-sub">${stats.today.n} sessions</div></div>
  <div class="stat"><div class="stat-label">Revenue (7 days)</div><div class="stat-value">${money(stats.week.amt)}</div><div class="stat-sub">${stats.week.n} sessions</div></div>
  <div class="stat"><div class="stat-label">All-time revenue</div><div class="stat-value">${money(stats.all.amt)}</div><div class="stat-sub">${stats.all.n} sessions</div></div>
  <div class="stat"><div class="stat-label">Cars parked now</div><div class="stat-value">${stats.active.n}</div><div class="stat-sub">across ${occupancy.length} locations</div></div>
</div>

<div class="grid-2">
  <section class="card">
    <h2>Occupancy by location</h2>
    <table>
      <thead><tr><th>Location</th><th>Occupied</th><th>Capacity</th><th></th></tr></thead>
      <tbody>
      ${occupancy.map((o) => {
        const pct = o.capacity ? Math.min(100, Math.round((o.occupied / o.capacity) * 100)) : 0;
        return `<tr>
          <td><a href="/admin/locations/${o.id}">${esc(o.name)}</a>${o.active ? '' : ' <span class="pill pill-off">inactive</span>'}</td>
          <td>${o.occupied}</td><td>${o.capacity}</td>
          <td class="w40"><div class="bar"><div class="bar-fill ${pct > 85 ? 'bar-hot' : ''}" style="width:${pct}%"></div></div><span class="muted">${pct}%</span></td>
        </tr>`;
      }).join('') || '<tr><td colspan="4" class="muted">No locations yet.</td></tr>'}
      </tbody>
    </table>
  </section>
  <section class="card">
    <h2>Recent transactions</h2>
    <table>
      <thead><tr><th>Ref</th><th>Location</th><th>Plate</th><th>Total</th><th>Status</th></tr></thead>
      <tbody>
      ${recent.map((s) => `<tr>
        <td class="mono">${esc(s.ref)}</td><td>${esc(s.location_name)}</td><td class="mono">${esc(s.plate)}</td>
        <td>${money(s.total_amount)}</td><td><span class="pill pill-${s.status === 'paid' ? 'ok' : 'off'}">${s.status}</span></td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No transactions yet.</td></tr>'}
      </tbody>
    </table>
    <p><a href="/admin/transactions">View all transactions →</a></p>
  </section>
</div>`,
  });
});

// ---------------- locations ----------------

router.get('/locations', (req, res) => {
  const now = new Date().toISOString();
  const locations = db.prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM sessions s WHERE s.location_id=l.id AND s.status='paid' AND s.start_ts<=? AND s.end_ts>?) AS occupied,
      (SELECT COALESCE(SUM(total_amount),0) FROM sessions s WHERE s.location_id=l.id AND s.status='paid') AS revenue
    FROM locations l ORDER BY l.name`).all(now, now);
  page(req, res, {
    title: 'Locations', active: 'locations',
    body: `
<div class="page-head"><h1>Locations</h1><a class="btn btn-primary" href="/admin/locations/new">+ Add location</a></div>
<section class="card">
<table>
  <thead><tr><th>Name</th><th>QR code</th><th>Address</th><th>Base rate</th><th>Occupied</th><th>Revenue</th><th>Status</th></tr></thead>
  <tbody>
  ${locations.map((l) => `<tr>
    <td><a href="/admin/locations/${l.id}"><strong>${esc(l.name)}</strong></a></td>
    <td class="mono">${esc(l.code)}</td>
    <td>${esc(l.address)}, ${esc(l.city)}, ${esc(l.state)}</td>
    <td>${money(l.hourly_rate)}/hr${l.daily_max ? ` · ${money(l.daily_max)} max` : ''}</td>
    <td>${l.occupied}/${l.capacity}</td>
    <td>${money(l.revenue)}</td>
    <td><span class="pill pill-${l.active ? 'ok' : 'off'}">${l.active ? 'active' : 'inactive'}</span></td>
  </tr>`).join('') || '<tr><td colspan="7" class="muted">No locations yet — add your first lot or garage.</td></tr>'}
  </tbody>
</table>
</section>`,
  });
});

function locationForm(l = {}, action, submitLabel) {
  return `<form method="post" action="${action}" class="form-grid">
  <label>Name<input name="name" required value="${esc(l.name || '')}" placeholder="Downtown Garage"></label>
  <label>Capacity (spaces)<input name="capacity" type="number" min="1" required value="${esc(l.capacity ?? 50)}"></label>
  <label>Street address<input name="address" required value="${esc(l.address || '')}"></label>
  <label>City<input name="city" required value="${esc(l.city || '')}"></label>
  <label>State<input name="state" required maxlength="2" value="${esc(l.state || '')}" placeholder="NC"></label>
  <label>ZIP<input name="zip" value="${esc(l.zip || '')}"></label>
  <label>Base hourly rate ($)<input name="hourly_rate" type="number" step="0.01" min="0" required value="${((l.hourly_rate ?? 300) / 100).toFixed(2)}"></label>
  <label>Daily maximum ($, 0 = none)<input name="daily_max" type="number" step="0.01" min="0" required value="${((l.daily_max ?? 2400) / 100).toFixed(2)}"></label>
  <label>Timezone
    <select name="timezone">
      ${['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles']
        .map((tz) => `<option ${((l.timezone || 'America/New_York') === tz) ? 'selected' : ''}>${tz}</option>`).join('')}
    </select>
  </label>
  <label class="span-2">Description (shown to drivers on the payment page)
    <textarea name="description" rows="3">${esc(l.description || '')}</textarea>
  </label>
  <div class="span-2"><button class="btn btn-primary" type="submit">${submitLabel}</button></div>
</form>`;
}

router.get('/locations/new', (req, res) => {
  page(req, res, {
    title: 'Add location', active: 'locations',
    body: `<h1>Add location</h1><section class="card">${locationForm({}, '/admin/locations', 'Create location')}</section>`,
  });
});

function locationFromBody(body) {
  return {
    name: String(body.name || '').trim(),
    address: String(body.address || '').trim(),
    city: String(body.city || '').trim(),
    state: String(body.state || '').trim().toUpperCase(),
    zip: String(body.zip || '').trim(),
    description: String(body.description || '').trim(),
    capacity: Math.max(1, parseInt(body.capacity, 10) || 1),
    hourly_rate: Math.max(0, Math.round(parseFloat(body.hourly_rate || '0') * 100)),
    daily_max: Math.max(0, Math.round(parseFloat(body.daily_max || '0') * 100)),
    timezone: String(body.timezone || 'America/New_York'),
  };
}

router.post('/locations', (req, res) => {
  const l = locationFromBody(req.body);
  if (!l.name || !l.address) return res.redirect('/admin/locations/new?err=' + encodeURIComponent('Name and address are required.'));
  const info = db.prepare(`INSERT INTO locations (code, name, address, city, state, zip, description, capacity, hourly_rate, daily_max, timezone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uniqueLocationCode(), l.name, l.address, l.city, l.state, l.zip, l.description, l.capacity, l.hourly_rate, l.daily_max, l.timezone);
  res.redirect(`/admin/locations/${info.lastInsertRowid}?ok=` + encodeURIComponent('Location created. Its QR code is ready below — print the sign and post it at the lot.'));
});

router.get('/locations/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).send('Location not found');
  const now = new Date().toISOString();
  const occupied = db.prepare(`SELECT COUNT(*) n FROM sessions WHERE location_id=? AND status='paid' AND start_ts<=? AND end_ts>?`).get(l.id, now, now).n;
  const revenue = db.prepare(`SELECT COALESCE(SUM(total_amount),0) amt, COUNT(*) n FROM sessions WHERE location_id=? AND status='paid'`).get(l.id);
  const rules = db.prepare(`SELECT * FROM pricing_rules WHERE location_id = ? ORDER BY priority DESC`).all(l.id);
  const url = payUrl(req, l);
  page(req, res, {
    title: l.name, active: 'locations',
    body: `
<div class="page-head">
  <h1>${esc(l.name)} <span class="pill pill-${l.active ? 'ok' : 'off'}">${l.active ? 'active' : 'inactive'}</span></h1>
  <form method="post" action="/admin/locations/${l.id}/toggle">
    <button class="btn btn-ghost" type="submit">${l.active ? 'Deactivate' : 'Activate'}</button>
  </form>
</div>
<div class="grid-2">
  <section class="card">
    <h2>QR code &amp; payment page</h2>
    <div class="qr-row">
      <img src="/admin/locations/${l.id}/qr.png" alt="QR code for ${esc(l.name)}" width="180" height="180" class="qr-img">
      <div>
        <p>Drivers scan this code to open the payment page for <strong>${esc(l.name)}</strong>:</p>
        <p><a href="${esc(url)}" class="mono" target="_blank">${esc(url)}</a></p>
        <p class="muted">Location code: <strong class="mono">${esc(l.code)}</strong></p>
        <p>
          <a class="btn btn-primary" href="/admin/locations/${l.id}/sign" target="_blank">Printable sign</a>
          <a class="btn btn-ghost" href="/admin/locations/${l.id}/qr.png" download="${esc(l.code)}-qr.png">PNG</a>
          <a class="btn btn-ghost" href="/admin/locations/${l.id}/qr.svg" download="${esc(l.code)}-qr.svg">SVG</a>
        </p>
      </div>
    </div>
    <h2>Performance</h2>
    <div class="stat-grid stat-grid-3">
      <div class="stat"><div class="stat-label">Occupied now</div><div class="stat-value">${occupied}/${l.capacity}</div></div>
      <div class="stat"><div class="stat-label">Revenue</div><div class="stat-value">${money(revenue.amt)}</div></div>
      <div class="stat"><div class="stat-label">Sessions</div><div class="stat-value">${revenue.n}</div></div>
    </div>
    <h2>Pricing rules for this location</h2>
    ${rules.length ? `<table><thead><tr><th>Rule</th><th>Type</th><th>Value</th><th>When</th><th>Status</th></tr></thead><tbody>
      ${rules.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.rule_type}</td><td>${ruleValueLabel(r)}</td>
        <td>${dowLabel(r.days_of_week)} ${esc(r.start_time)}–${esc(r.end_time)}</td>
        <td><span class="pill pill-${r.active ? 'ok' : 'off'}">${r.active ? 'active' : 'off'}</span></td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No location-specific rules. The base rate applies (plus any all-location rules).</p>'}
    <p><a href="/admin/pricing?location=${l.id}">Manage pricing rules →</a></p>
  </section>
  <section class="card">
    <h2>Edit location</h2>
    ${locationForm(l, `/admin/locations/${l.id}`, 'Save changes')}
  </section>
</div>`,
  });
});

router.post('/locations/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM locations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).send('Location not found');
  const l = locationFromBody(req.body);
  db.prepare(`UPDATE locations SET name=?, address=?, city=?, state=?, zip=?, description=?, capacity=?, hourly_rate=?, daily_max=?, timezone=? WHERE id=?`)
    .run(l.name, l.address, l.city, l.state, l.zip, l.description, l.capacity, l.hourly_rate, l.daily_max, l.timezone, existing.id);
  res.redirect(`/admin/locations/${existing.id}?ok=` + encodeURIComponent('Location updated.'));
});

router.post('/locations/:id/toggle', (req, res) => {
  db.prepare('UPDATE locations SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect(`/admin/locations/${req.params.id}`);
});

router.get('/locations/:id/qr.png', async (req, res) => {
  const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).send('Not found');
  const png = await QRCode.toBuffer(payUrl(req, l), {
    type: 'png', width: 600, margin: 2,
    color: { dark: '#0b2545', light: '#ffffff' },
  });
  res.type('png').send(png);
});

router.get('/locations/:id/qr.svg', async (req, res) => {
  const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).send('Not found');
  const svg = await QRCode.toString(payUrl(req, l), {
    type: 'svg', margin: 2,
    color: { dark: '#0b2545', light: '#ffffff' },
  });
  res.type('image/svg+xml').send(svg);
});

// Printable branded sign for posting at the lot.
router.get('/locations/:id/sign', async (req, res) => {
  const l = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).send('Not found');
  const url = payUrl(req, l);
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0b2545', light: '#ffffff' } });
  res.send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign · ${esc(l.name)}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: Arial, Helvetica, sans-serif; background: #e9edf2; display: flex; justify-content: center; padding: 24px; }
  .sign { width: 720px; background: #fff; border: 6px solid #0b2545; border-radius: 18px; overflow: hidden; }
  .sign-head { background: #0b2545; color: #fff; padding: 28px 32px; display: flex; align-items: center; gap: 16px; }
  .sign-head .pca-logo { width: 56px; height: 56px; flex: none; }
  .sign-head h1 { font-size: 26px; line-height: 1.2; }
  .sign-head .sub { color: #c9d6e5; font-size: 15px; margin-top: 4px; }
  .sign-body { padding: 32px; text-align: center; }
  .sign-body h2 { font-size: 34px; color: #0b2545; }
  .sign-body .loc { font-size: 20px; color: #444; margin-top: 6px; }
  .qr-wrap { width: 340px; margin: 24px auto; padding: 16px; border: 4px solid #c8102e; border-radius: 14px; }
  .qr-wrap svg { width: 100%; height: auto; display: block; }
  .steps { display: flex; justify-content: center; gap: 28px; margin: 8px 0 18px; color: #0b2545; font-weight: bold; font-size: 17px; }
  .steps span { background: #f2f5f9; border-radius: 999px; padding: 8px 18px; }
  .code { font-size: 15px; color: #666; }
  .code strong { color: #0b2545; font-family: ui-monospace, monospace; }
  .sign-foot { background: #c8102e; color: #fff; text-align: center; padding: 14px; font-size: 15px; letter-spacing: 0.06em; text-transform: uppercase; }
  .toolbar { position: fixed; top: 12px; right: 12px; }
  .toolbar button { padding: 10px 18px; font-size: 15px; border: 0; border-radius: 8px; background: #0b2545; color: #fff; cursor: pointer; }
  @media print { body { background: #fff; padding: 0; } .toolbar { display: none; } .sign { border-radius: 0; width: 100%; } }
</style>
</head><body>
<div class="toolbar"><button onclick="window.print()">Print</button></div>
<div class="sign">
  <div class="sign-head">${LOGO_SVG}
    <div><h1>Parking Company of America</h1><div class="sub">Pay for parking in seconds — no app required</div></div>
  </div>
  <div class="sign-body">
    <h2>SCAN TO PAY</h2>
    <div class="loc">${esc(l.name)} · ${esc(l.address)}, ${esc(l.city)}, ${esc(l.state)}</div>
    <div class="qr-wrap">${qrSvg}</div>
    <div class="steps"><span>1 · Scan</span><span>2 · Enter plate</span><span>3 · Pay</span></div>
    <div class="code">No camera? Visit <strong>${esc(url.replace(/^https?:\/\//, ''))}</strong> · Location code <strong>${esc(l.code)}</strong></div>
  </div>
  <div class="sign-foot">Rates from ${money(l.hourly_rate)}/hour · parkwithpca.com</div>
</div>
</body></html>`);
});

// ---------------- pricing rules ----------------

router.get('/pricing', (req, res) => {
  const filter = req.query.location ? Number(req.query.location) : null;
  const rules = filter
    ? db.prepare(`SELECT r.*, l.name AS location_name FROM pricing_rules r LEFT JOIN locations l ON l.id = r.location_id
                  WHERE r.location_id = ? OR r.location_id IS NULL ORDER BY r.priority DESC, r.id`).all(filter)
    : db.prepare(`SELECT r.*, l.name AS location_name FROM pricing_rules r LEFT JOIN locations l ON l.id = r.location_id
                  ORDER BY r.priority DESC, r.id`).all();
  page(req, res, {
    title: 'Pricing rules', active: 'pricing',
    body: `
<div class="page-head"><h1>Pricing rules</h1></div>
<div class="grid-2">
<section class="card">
  <h2>Rules ${filter ? '(filtered)' : ''} <span class="muted">— highest priority wins</span></h2>
  <form method="get" action="/admin/pricing" class="inline-form">
    <select name="location" onchange="this.form.submit()">${locationOptions(filter, { allLabel: 'Show all rules' })}</select>
  </form>
  <table>
    <thead><tr><th>Rule</th><th>Scope</th><th>Type</th><th>Value</th><th>When</th><th>Pri</th><th></th></tr></thead>
    <tbody>
    ${rules.map((r) => `<tr class="${r.active ? '' : 'row-off'}">
      <td>${esc(r.name)}</td>
      <td>${r.location_id ? esc(r.location_name) : '<em>All locations</em>'}</td>
      <td>${r.rule_type}</td>
      <td>${ruleValueLabel(r)}</td>
      <td>${dowLabel(r.days_of_week)}<br><span class="muted">${esc(r.start_time)}–${esc(r.end_time)}${r.start_date ? ` · ${esc(r.start_date)}→${esc(r.end_date || '∞')}` : ''}</span></td>
      <td>${r.priority}</td>
      <td class="actions">
        <form method="post" action="/admin/pricing/${r.id}/toggle"><button class="btn btn-sm btn-ghost">${r.active ? 'Disable' : 'Enable'}</button></form>
        <form method="post" action="/admin/pricing/${r.id}/delete" onsubmit="return confirm('Delete this rule?')"><button class="btn btn-sm btn-danger">Delete</button></form>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No pricing rules yet.</td></tr>'}
    </tbody>
  </table>
</section>
<section class="card">
  <h2>Add a rule</h2>
  <form method="post" action="/admin/pricing" class="form-grid">
    <label>Rule name<input name="name" required placeholder="Early Bird Special"></label>
    <label>Applies to<select name="location_id">${locationOptions(null)}</select></label>
    <label>Rule type
      <select name="rule_type" id="rule_type">
        <option value="flat">Flat rate — one price for the whole stay</option>
        <option value="override">Override — replace the hourly rate</option>
        <option value="multiplier">Multiplier — surge/discount the hourly rate</option>
      </select>
    </label>
    <label>Value <span class="muted">($ for flat/override, factor for multiplier — e.g. 1.5)</span>
      <input name="value" type="number" step="0.01" min="0" required placeholder="12.00">
    </label>
    <fieldset class="span-2"><legend>Days of week</legend>
      ${DOW.map((d, i) => `<label class="inline"><input type="checkbox" name="dow" value="${i}" checked> ${d}</label>`).join('')}
    </fieldset>
    <label>Start time<input name="start_time" type="time" value="00:00" required></label>
    <label>End time <span class="muted">(24:00 = midnight)</span><input name="end_time" value="24:00" required pattern="([01]?\\d|2[0-4]):[0-5]\\d"></label>
    <label>Start date <span class="muted">(optional — for events)</span><input name="start_date" type="date"></label>
    <label>End date <span class="muted">(optional)</span><input name="end_date" type="date"></label>
    <label>Max stay hours <span class="muted">(flat rules only, optional)</span><input name="max_hours" type="number" min="1"></label>
    <label>Priority <span class="muted">(higher wins on overlap)</span><input name="priority" type="number" value="0" required></label>
    <div class="span-2"><button class="btn btn-primary" type="submit">Create rule</button></div>
  </form>
</section>
</div>`,
  });
});

router.post('/pricing', (req, res) => {
  const type = ['multiplier', 'override', 'flat'].includes(req.body.rule_type) ? req.body.rule_type : 'flat';
  const raw = parseFloat(req.body.value || '0');
  const value = type === 'multiplier' ? Math.max(0, raw) : Math.max(0, Math.round(raw * 100));
  const dow = [].concat(req.body.dow || []).map(Number).filter((n) => n >= 0 && n <= 6);
  db.prepare(`INSERT INTO pricing_rules (location_id, name, rule_type, value, days_of_week, start_time, end_time, start_date, end_date, max_hours, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      req.body.location_id ? Number(req.body.location_id) : null,
      String(req.body.name || 'Untitled rule').trim(),
      type, value,
      (dow.length ? dow : [0, 1, 2, 3, 4, 5, 6]).join(','),
      String(req.body.start_time || '00:00'),
      String(req.body.end_time || '24:00'),
      req.body.start_date || null,
      req.body.end_date || null,
      req.body.max_hours ? Number(req.body.max_hours) : null,
      parseInt(req.body.priority, 10) || 0,
    );
  res.redirect('/admin/pricing?ok=' + encodeURIComponent('Pricing rule created.'));
});

router.post('/pricing/:id/toggle', (req, res) => {
  db.prepare('UPDATE pricing_rules SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/pricing');
});

router.post('/pricing/:id/delete', (req, res) => {
  db.prepare('DELETE FROM pricing_rules WHERE id = ?').run(req.params.id);
  res.redirect('/admin/pricing?ok=' + encodeURIComponent('Rule deleted.'));
});

// ---------------- marketing campaigns ----------------

router.get('/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*, l.name AS location_name,
      (SELECT COALESCE(SUM(s.discount_amount),0) FROM sessions s WHERE s.campaign_id = c.id AND s.status='paid') AS discount_given,
      (SELECT COALESCE(SUM(s.total_amount),0)   FROM sessions s WHERE s.campaign_id = c.id AND s.status='paid') AS revenue_driven
    FROM campaigns c LEFT JOIN locations l ON l.id = c.location_id
    ORDER BY c.id DESC`).all();
  page(req, res, {
    title: 'Marketing', active: 'campaigns',
    body: `
<div class="page-head"><h1>Marketing campaigns</h1><a class="btn btn-primary" href="/admin/campaigns/new">+ New campaign</a></div>
<section class="card">
<table>
  <thead><tr><th>Campaign</th><th>Channel</th><th>Scope</th><th>Promo code</th><th>Discount</th><th>Redemptions</th><th>Revenue driven</th><th>Status</th><th></th></tr></thead>
  <tbody>
  ${campaigns.map((c) => `<tr class="${c.active ? '' : 'row-off'}">
    <td><a href="/admin/campaigns/${c.id}"><strong>${esc(c.name)}</strong></a>${c.starts_at || c.ends_at ? `<br><span class="muted">${esc(c.starts_at || '…')} → ${esc(c.ends_at || '…')}</span>` : ''}</td>
    <td>${esc(c.channel)}</td>
    <td>${c.location_id ? esc(c.location_name) : '<em>All locations</em>'}</td>
    <td class="mono">${c.promo_code ? esc(c.promo_code) : '—'}</td>
    <td>${c.promo_code ? (c.discount_type === 'percent' ? `${c.discount_value}%` : money(Math.round(c.discount_value))) : '—'}</td>
    <td>${c.redemptions}${c.max_redemptions ? ` / ${c.max_redemptions}` : ''}</td>
    <td>${money(c.revenue_driven)} <span class="muted">(−${money(c.discount_given)})</span></td>
    <td><span class="pill pill-${c.active ? 'ok' : 'off'}">${c.active ? 'active' : 'off'}</span></td>
    <td class="actions">
      <form method="post" action="/admin/campaigns/${c.id}/toggle"><button class="btn btn-sm btn-ghost">${c.active ? 'Pause' : 'Resume'}</button></form>
    </td>
  </tr>`).join('') || '<tr><td colspan="9" class="muted">No campaigns yet.</td></tr>'}
  </tbody>
</table>
</section>`,
  });
});

router.get('/campaigns/new', (req, res) => {
  page(req, res, {
    title: 'New campaign', active: 'campaigns',
    body: `
<h1>New marketing campaign</h1>
<section class="card">
<form method="post" action="/admin/campaigns" class="form-grid">
  <label>Campaign name<input name="name" required placeholder="Summer Weekend Special"></label>
  <label>Channel
    <select name="channel">
      <option value="signage">Signage / QR</option>
      <option value="email">Email</option>
      <option value="social">Social media</option>
      <option value="sms">SMS</option>
    </select>
  </label>
  <label>Target location<select name="location_id">${locationOptions(null)}</select></label>
  <label>Promo code <span class="muted">(leave blank for awareness-only)</span><input name="promo_code" placeholder="SUMMER25" style="text-transform:uppercase"></label>
  <label>Discount type
    <select name="discount_type"><option value="percent">Percent off</option><option value="fixed">Dollars off</option></select>
  </label>
  <label>Discount value <span class="muted">(% or $)</span><input name="discount_value" type="number" step="0.01" min="0" placeholder="25"></label>
  <label>Starts <span class="muted">(optional)</span><input name="starts_at" type="date"></label>
  <label>Ends <span class="muted">(optional)</span><input name="ends_at" type="date"></label>
  <label>Max redemptions <span class="muted">(optional)</span><input name="max_redemptions" type="number" min="1"></label>
  <label class="span-2">Headline<input name="headline" placeholder="Park all weekend for 25% off"></label>
  <label class="span-2">Marketing copy<textarea name="body" rows="4" placeholder="Use code SUMMER25 when you scan to pay at any PCA location…"></textarea></label>
  <div class="span-2"><button class="btn btn-primary" type="submit">Create campaign</button></div>
</form>
</section>`,
  });
});

router.post('/campaigns', (req, res) => {
  const code = String(req.body.promo_code || '').trim().toUpperCase() || null;
  if (code) {
    const dupe = db.prepare('SELECT id FROM campaigns WHERE promo_code = ? COLLATE NOCASE').get(code);
    if (dupe) return res.redirect('/admin/campaigns/new?err=' + encodeURIComponent(`Promo code ${code} is already used by another campaign.`));
    if (!req.body.discount_value || parseFloat(req.body.discount_value) <= 0) {
      return res.redirect('/admin/campaigns/new?err=' + encodeURIComponent('A promo code needs a discount value greater than zero.'));
    }
  }
  const info = db.prepare(`INSERT INTO campaigns (name, headline, body, channel, location_id, promo_code, discount_type, discount_value, starts_at, ends_at, max_redemptions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      String(req.body.name || 'Untitled campaign').trim(),
      String(req.body.headline || '').trim(),
      String(req.body.body || '').trim(),
      ['signage', 'email', 'social', 'sms'].includes(req.body.channel) ? req.body.channel : 'signage',
      req.body.location_id ? Number(req.body.location_id) : null,
      code,
      code ? (req.body.discount_type === 'fixed' ? 'fixed' : 'percent') : null,
      code ? (req.body.discount_type === 'fixed' ? Math.round(parseFloat(req.body.discount_value) * 100) : parseFloat(req.body.discount_value)) : null,
      req.body.starts_at || null,
      req.body.ends_at || null,
      req.body.max_redemptions ? Number(req.body.max_redemptions) : null,
    );
  res.redirect(`/admin/campaigns/${info.lastInsertRowid}?ok=` + encodeURIComponent('Campaign created.'));
});

router.get('/campaigns/:id', (req, res) => {
  const c = db.prepare(`SELECT c.*, l.name AS location_name FROM campaigns c LEFT JOIN locations l ON l.id = c.location_id WHERE c.id = ?`).get(req.params.id);
  if (!c) return res.status(404).send('Campaign not found');
  const stats = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) revenue, COALESCE(SUM(discount_amount),0) discount
    FROM sessions WHERE campaign_id = ? AND status='paid'`).get(c.id);
  const recent = db.prepare(`SELECT s.*, l.name AS location_name FROM sessions s JOIN locations l ON l.id = s.location_id
    WHERE s.campaign_id = ? ORDER BY s.id DESC LIMIT 15`).all(c.id);
  const discountLabel = c.promo_code
    ? (c.discount_type === 'percent' ? `${c.discount_value}% off` : `${money(Math.round(c.discount_value))} off`)
    : null;
  page(req, res, {
    title: c.name, active: 'campaigns',
    body: `
<div class="page-head">
  <h1>${esc(c.name)} <span class="pill pill-${c.active ? 'ok' : 'off'}">${c.active ? 'active' : 'paused'}</span></h1>
  <div class="actions">
    <form method="post" action="/admin/campaigns/${c.id}/toggle"><button class="btn btn-ghost">${c.active ? 'Pause' : 'Resume'}</button></form>
    <form method="post" action="/admin/campaigns/${c.id}/delete" onsubmit="return confirm('Delete this campaign? Past transactions keep their records.')"><button class="btn btn-danger">Delete</button></form>
  </div>
</div>
<div class="grid-2">
<section class="card">
  <h2>Details</h2>
  <dl class="dl">
    <dt>Channel</dt><dd>${esc(c.channel)}</dd>
    <dt>Scope</dt><dd>${c.location_id ? esc(c.location_name) : 'All locations'}</dd>
    <dt>Promo code</dt><dd class="mono">${c.promo_code ? esc(c.promo_code) : '— (awareness only)'}</dd>
    ${discountLabel ? `<dt>Discount</dt><dd>${discountLabel}</dd>` : ''}
    <dt>Window</dt><dd>${c.starts_at || c.ends_at ? `${esc(c.starts_at || 'now')} → ${esc(c.ends_at || 'no end')}` : 'Always on'}</dd>
    <dt>Redemption cap</dt><dd>${c.max_redemptions ?? 'Unlimited'}</dd>
  </dl>
  <h2>Campaign copy</h2>
  <div class="copy-preview">
    <div class="copy-headline">${esc(c.headline || c.name)}</div>
    <p>${esc(c.body || 'No copy written yet.')}</p>
    ${c.promo_code ? `<p><strong>Use code: <span class="mono">${esc(c.promo_code)}</span>${discountLabel ? ` — ${discountLabel}` : ''}</strong></p>` : ''}
  </div>
</section>
<section class="card">
  <h2>Results</h2>
  <div class="stat-grid stat-grid-3">
    <div class="stat"><div class="stat-label">Redemptions</div><div class="stat-value">${c.redemptions}${c.max_redemptions ? `<span class="stat-sub">/${c.max_redemptions}</span>` : ''}</div></div>
    <div class="stat"><div class="stat-label">Revenue driven</div><div class="stat-value">${money(stats.revenue)}</div></div>
    <div class="stat"><div class="stat-label">Discounts given</div><div class="stat-value">${money(stats.discount)}</div></div>
  </div>
  <h2>Recent redemptions</h2>
  <table>
    <thead><tr><th>Ref</th><th>Location</th><th>Plate</th><th>Total</th><th>Saved</th></tr></thead>
    <tbody>
    ${recent.map((s) => `<tr><td class="mono">${esc(s.ref)}</td><td>${esc(s.location_name)}</td><td class="mono">${esc(s.plate)}</td><td>${money(s.total_amount)}</td><td>−${money(s.discount_amount)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No redemptions yet.</td></tr>'}
    </tbody>
  </table>
</section>
</div>`,
  });
});

router.post('/campaigns/:id/toggle', (req, res) => {
  db.prepare('UPDATE campaigns SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/campaigns');
});

router.post('/campaigns/:id/delete', (req, res) => {
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.redirect('/admin/campaigns?ok=' + encodeURIComponent('Campaign deleted.'));
});

// ---------------- transactions ----------------

router.get('/transactions', (req, res) => {
  const filter = req.query.location ? Number(req.query.location) : null;
  const rows = filter
    ? db.prepare(`SELECT s.*, l.name AS location_name FROM sessions s JOIN locations l ON l.id = s.location_id WHERE s.location_id = ? ORDER BY s.id DESC LIMIT 200`).all(filter)
    : db.prepare(`SELECT s.*, l.name AS location_name FROM sessions s JOIN locations l ON l.id = s.location_id ORDER BY s.id DESC LIMIT 200`).all();
  page(req, res, {
    title: 'Transactions', active: 'transactions',
    body: `
<div class="page-head"><h1>Transactions</h1>
<form method="get" action="/admin/transactions" class="inline-form">
  <select name="location" onchange="this.form.submit()">${locationOptions(filter)}</select>
</form></div>
<section class="card">
<table>
  <thead><tr><th>Ref</th><th>When</th><th>Location</th><th>Plate</th><th>Stay</th><th>Base</th><th>Discount</th><th>Total</th><th>Promo</th><th>Status</th><th></th></tr></thead>
  <tbody>
  ${rows.map((s) => `<tr>
    <td class="mono">${esc(s.ref)}</td>
    <td>${esc(s.created_at)}</td>
    <td>${esc(s.location_name)}</td>
    <td class="mono">${esc(s.plate)}</td>
    <td>${s.hours}h</td>
    <td>${money(s.base_amount)}</td>
    <td>${s.discount_amount ? `−${money(s.discount_amount)}` : '—'}</td>
    <td><strong>${money(s.total_amount)}</strong></td>
    <td class="mono">${esc(s.promo_code || '—')}</td>
    <td><span class="pill pill-${s.status === 'paid' ? 'ok' : 'off'}">${s.status}</span></td>
    <td>${s.status === 'paid' ? `<form method="post" action="/admin/transactions/${s.id}/refund" onsubmit="return confirm('Refund ${money(s.total_amount)} for ${esc(s.ref)}?')"><button class="btn btn-sm btn-ghost">Refund</button></form>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="11" class="muted">No transactions yet.</td></tr>'}
  </tbody>
</table>
</section>`,
  });
});

router.post('/transactions/:id/refund', (req, res) => {
  db.prepare(`UPDATE sessions SET status = 'refunded' WHERE id = ? AND status = 'paid'`).run(req.params.id);
  res.redirect('/admin/transactions?ok=' + encodeURIComponent('Session refunded.'));
});

// ---------------- enforcement ----------------

router.get('/enforcement', (req, res) => {
  const plate = String(req.query.plate || '').trim().toUpperCase();
  let results = null;
  if (plate) {
    const now = new Date().toISOString();
    results = db.prepare(`
      SELECT s.*, l.name AS location_name,
        CASE WHEN s.start_ts <= ? AND s.end_ts > ? THEN 1 ELSE 0 END AS is_active
      FROM sessions s JOIN locations l ON l.id = s.location_id
      WHERE UPPER(s.plate) = ? AND s.status = 'paid'
      ORDER BY s.end_ts DESC LIMIT 20`).all(now, now, plate);
  }
  page(req, res, {
    title: 'Enforcement', active: 'enforcement',
    body: `
<h1>Enforcement — plate lookup</h1>
<section class="card">
  <form method="get" action="/admin/enforcement" class="inline-form">
    <input name="plate" value="${esc(plate)}" placeholder="License plate, e.g. ABC1234" required style="text-transform:uppercase">
    <button class="btn btn-primary" type="submit">Check plate</button>
  </form>
  ${results === null ? '<p class="muted">Enter a plate to see whether it has an active paid session.</p>' : `
  ${results.some((r) => r.is_active)
    ? '<div class="flash flash-ok">✅ PAID — this vehicle has an active session.</div>'
    : '<div class="flash flash-err">🚫 NOT PAID — no active session found for this plate.</div>'}
  <table>
    <thead><tr><th>Ref</th><th>Location</th><th>Valid from</th><th>Valid until</th><th>Total</th><th>Active</th></tr></thead>
    <tbody>
    ${results.map((s) => `<tr>
      <td class="mono">${esc(s.ref)}</td><td>${esc(s.location_name)}</td>
      <td>${esc(s.start_ts.replace('T', ' ').slice(0, 16))} UTC</td>
      <td>${esc(s.end_ts.replace('T', ' ').slice(0, 16))} UTC</td>
      <td>${money(s.total_amount)}</td>
      <td>${s.is_active ? '<span class="pill pill-ok">active</span>' : '<span class="pill pill-off">expired</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No paid sessions for this plate.</td></tr>'}
    </tbody>
  </table>`}
</section>`,
  });
});

module.exports = router;
