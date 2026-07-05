'use strict';

const { LOGO_HTML, FAVICON_HTML } = require('./logo');

/** Escape a value for interpolation into HTML. */
function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const FAVICON = FAVICON_HTML;

/** Admin console page shell. */
function adminLayout({ title, active, admin, flash, body }) {
  const nav = [
    ['dashboard', '/admin', 'Dashboard'],
    ['locations', '/admin/locations', 'Locations'],
    ['pricing', '/admin/pricing', 'Pricing Rules'],
    ['campaigns', '/admin/campaigns', 'Marketing'],
    ['transactions', '/admin/transactions', 'Transactions'],
    ['passes', '/admin/passes', 'Passes'],
    ['enforcement', '/admin/enforcement', 'Enforcement'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · PCA Admin</title>
<link rel="stylesheet" href="/assets/admin.css">
${FAVICON}
</head>
<body>
<header class="topbar">
  <a class="brand" href="/admin" title="Parking Company of America — Admin">
    ${LOGO_HTML}
    <span class="brand-sub">Operations<br>Console</span>
  </a>
  <nav>
    ${nav.map(([key, href, label]) =>
      `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`).join('')}
  </nav>
  <div class="userbox">
    <span>${esc(admin?.name || '')}</span>
    <a href="/admin/logout" class="btn btn-ghost btn-sm">Sign out</a>
  </div>
</header>
<main class="container">
${flash ? `<div class="flash flash-${esc(flash.type)}">${esc(flash.msg)}</div>` : ''}
${body}
</main>
<footer class="footer">© ${new Date().getFullYear()} Parking Company of America · PCA Parking Platform</footer>
</body>
</html>`;
}

/** Public (driver-facing) page shell — mobile first. */
function publicLayout({ title, body, extraHead = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Parking Company of America</title>
<link rel="stylesheet" href="/assets/public.css">
${FAVICON}
${extraHead}
</head>
<body>
<header class="pub-header">
  <a href="/" aria-label="Parking Company of America home">${LOGO_HTML}</a>
  <div class="pub-tag">Easy parking. Scan. Pay. Done.</div>
</header>
<main class="pub-main">
${body}
</main>
<footer class="pub-footer">© ${new Date().getFullYear()} Parking Company of America</footer>
</body>
</html>`;
}

module.exports = { esc, adminLayout, publicLayout, LOGO_HTML };
