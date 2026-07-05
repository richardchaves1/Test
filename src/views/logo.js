'use strict';

// Parking Company of America logo — US map silhouette with red/white/blue bands,
// recreated as inline SVG so it stays crisp at any size (headers, signs, favicons).

const PCA_RED = '#e8272b';
const PCA_BLUE = '#1a5cdb';

const US_MAP_PATH = `M 108,148 L 145,115 L 500,95 L 760,85 L 828,90 L 856,118
 L 892,100 L 932,132 L 988,106 L 1045,94 L 1098,82 L 1128,58 L 1150,56 L 1166,102
 L 1150,128 L 1188,162 L 1220,196 L 1250,208 L 1214,234 L 1202,272 L 1188,318
 L 1202,365 L 1178,418 L 1145,462 L 1112,502 L 1095,535 L 1140,628 L 1165,725
 L 1145,780 L 1105,772 L 1060,680 L 1030,615 L 1000,598 L 932,606 L 895,595
 L 860,608 L 855,650 L 826,640 L 800,615 L 770,645 L 736,720 L 716,798 L 666,746
 L 620,686 L 576,650 L 546,640 L 430,622 L 330,608 L 282,597 L 262,562 L 224,468
 L 190,392 L 168,342 L 140,272 L 120,208 Z`;

function logoSvg({ className = 'pca-logo', idSuffix = 'a' } = {}) {
  const clipId = `pca-us-${idSuffix}`;
  return `
<svg class="${className}" viewBox="0 0 1340 860" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Parking Company of America">
  <defs><clipPath id="${clipId}"><path d="${US_MAP_PATH}"/></clipPath></defs>
  <g clip-path="url(#${clipId})">
    <rect x="0" y="0" width="1340" height="335" fill="${PCA_RED}"/>
    <rect x="0" y="335" width="1340" height="185" fill="#ffffff"/>
    <rect x="0" y="520" width="1340" height="340" fill="${PCA_BLUE}"/>
  </g>
  <path d="${US_MAP_PATH}" fill="none" stroke="${PCA_RED}" stroke-width="10" stroke-linejoin="round"/>
  <text x="190" y="492" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="196"
        fill="${PCA_RED}" textLength="890" lengthAdjust="spacingAndGlyphs">PARKING</text>
  <text x="1096" y="400" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="48" fill="${PCA_RED}">&#174;</text>
  <text x="650" y="606" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="78"
        fill="#ffffff" text-anchor="middle" textLength="700" lengthAdjust="spacingAndGlyphs">COMPANY OF AMERICA</text>
</svg>`;
}

const LOGO_SVG = logoSvg();

module.exports = { LOGO_SVG, logoSvg, PCA_RED, PCA_BLUE };
