'use strict';

// Parking Company of America logo. The artwork lives at public/logo.png —
// replace that file with updated brand art any time and every page, sign,
// and favicon picks it up (no code changes needed).

const LOGO_HTML = '<img class="pca-logo" src="/assets/logo.png" alt="Parking Company of America">';
const FAVICON_HTML = '<link rel="icon" type="image/png" href="/assets/logo.png">';

const PCA_RED = '#e8272b';
const PCA_BLUE = '#1a5cdb';

module.exports = { LOGO_HTML, FAVICON_HTML, PCA_RED, PCA_BLUE };
