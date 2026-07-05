'use strict';

/** Escape a value for interpolation into HTML. */
function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const LOGO_SVG = `
<svg class="pca-logo" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="2" y="2" width="40" height="40" rx="8" fill="#0b2545"/>
  <rect x="2" y="2" width="40" height="40" rx="8" fill="none" stroke="#c8102e" stroke-width="2.5"/>
  <text x="22" y="29" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="17" fill="#ffffff">P</text>
  <circle cx="31" cy="13" r="5" fill="#c8102e"/>
  <text x="31" y="16.5" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="9.5" fill="#ffffff">$</text>
</svg>`;

/** Admin console page shell. */
function adminLayout({ title, active, admin, flash, body }) {
  const nav = [
    ['dashboard', '/admin', 'Dashboard'],
    ['locations', '/admin/locations', 'Locations'],
    ['pricing', '/admin/pricing', 'Pricing Rules'],
    ['campaigns', '/admin/campaigns', 'Marketing'],
    ['transactions', '/admin/transactions', 'Transactions'],
    ['enforcement', '/admin/enforcement', 'Enforcement'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · PCA Admin</title>
<link rel="stylesheet" href="/assets/admin.css">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/admin">
    ${LOGO_SVG}
    <span class="brand-name">Parking Company <span>of America</span></span>
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
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}">
${extraHead}
</head>
<body>
<header class="pub-header">
  ${LOGO_SVG}
  <div>
    <div class="pub-brand">Parking Company of America</div>
    <div class="pub-tag">Easy parking. Scan. Pay. Done.</div>
  </div>
</header>
<main class="pub-main">
${body}
</main>
<footer class="pub-footer">© ${new Date().getFullYear()} Parking Company of America</footer>
</body>
</html>`;
}

module.exports = { esc, adminLayout, publicLayout, LOGO_SVG };
