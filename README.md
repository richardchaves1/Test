# PCA Parking Platform

A self-hosted parking sales and management platform for **Parking Company of America** — in the spirit of ParkMobile / SpotHero / ParkWhiz, but branded and operated by PCA.

Drivers scan a **QR code posted at each location**, which opens that location's own mobile payment page. They enter their plate, pick a duration, apply a promo code, and pay — no app required. Operators manage everything from a branded admin console.

## Features

### Driver experience (public)
- **`/` Landing page** — list of active PCA locations with rates.
- **`/p/<CODE>` Payment page per location** — this is where each location's QR code points. Mobile-first: plate → duration → live price quote (with promo codes) → card payment → receipt.
- **`/r/<REF>` Receipt page** — shows PARKING ACTIVE status, validity window, and full price breakdown.

### Operator console (`/admin`)
- **Dashboard** — revenue today / 7-day / all-time, cars parked now, occupancy bars per location, recent transactions.
- **Locations** — add/edit lots and garages (capacity, base hourly rate, daily max, timezone, description). Every location automatically gets:
  - a unique short code (e.g. `PCA-E7YC`) and payment URL,
  - a downloadable **QR code** (PNG + SVG),
  - a **printable branded "SCAN TO PAY" sign** ready to post at the lot.
- **Pricing rules** — a rule engine layered on each location's base rate. Highest priority wins:
  - `flat` — one price for the whole stay when it *starts* in the window (early bird, evening flat), optionally capped to a max stay length,
  - `override` — replace the hourly rate in a window (e.g. weekend $2.50/hr),
  - `multiplier` — surge or discount the hourly rate (e.g. ×2.0 on game days),
  - each rule scopes to one location or all, by day-of-week, time window, and optional date range (for events). Daily max caps every 24-hour block.
- **Marketing campaigns** — create campaigns per channel (signage/email/social/SMS) with headline + copy, optionally attached to a **promo code**: percent or fixed discount, start/end dates, redemption caps, per-location targeting. Tracks redemptions, revenue driven, and discounts given per campaign.
- **Transactions** — full ledger with filters and one-click refunds.
- **Enforcement** — attendants look up a plate and get an instant **PAID / NOT PAID** answer.

## Quick start

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
npm install
npm start        # http://localhost:3000
```

- Driver pages: `http://localhost:3000/`
- Admin console: `http://localhost:3000/admin`
  - Default login: `admin@parkwithpca.com` / `ChangeMe!PCA2026` (change via env vars below before going live).

On first boot the app seeds the admin user plus sample locations, pricing rules, and campaigns (`WELCOME20`, `FLYPCA`) so you can click around immediately. Set `PCA_SKIP_SEED=1` to start empty.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PCA_BASE_URL` | request host | **Set this in production** (e.g. `https://pay.parkwithpca.com`) so QR codes encode your public domain |
| `PCA_ADMIN_EMAIL` | `admin@parkwithpca.com` | Seeded admin login |
| `PCA_ADMIN_PASSWORD` | `ChangeMe!PCA2026` | Seeded admin password |
| `PCA_SESSION_SECRET` | generated & persisted | HMAC secret for admin session cookies |
| `PCA_DATA_DIR` | `./data` | Where the SQLite database lives |
| `PCA_SKIP_SEED` | off | `1` = don't create sample data |

## QR codes in production

QR codes are generated on the fly from `PCA_BASE_URL + /p/ + location code`. Deploy the app behind your public domain, set `PCA_BASE_URL`, then print each location's sign from its detail page (`Locations → location → Printable sign`). Reprinting is never needed when rates change — the QR points at the live payment page.

## Payments

Checkout ships with a **built-in demo card processor**: it validates card format (Luhn), never stores card data, and approves valid-format cards — perfect for pilots and demos. Use test card `4242 4242 4242 4242`, any future `MM/YY`, any CVC.

For production, swap the `chargeCard()` function in `src/routes/public.js` with a real gateway (Stripe Payment Intents, Adyen, Square). The rest of the flow — server-side price recomputation, session creation, promo redemption counting, receipts, refunds — is gateway-agnostic and already in place.

## Architecture

```
server.js               Express app entry
src/db.js               SQLite schema, seed data (node:sqlite, WAL mode)
src/pricing.js          Quote engine: flat/override/multiplier rules, daily max, promo codes
src/auth.js             Admin login, HMAC-signed session cookies
src/routes/admin.js     Operator console (dashboard, locations, QR/signs, pricing, marketing, transactions, enforcement)
src/routes/public.js    Driver pages (landing, pay, quote API, checkout, receipt)
src/views/layout.js     Branded HTML layouts (PCA navy/red)
public/                 Stylesheets
data/pca.db             SQLite database (created at runtime, git-ignored)
```

No build step, two runtime dependencies (`express`, `qrcode`).

## Security notes for going live

- Change the admin password (`PCA_ADMIN_PASSWORD`) and set `PCA_SESSION_SECRET`.
- Terminate TLS in front of the app (QR payment pages must be HTTPS).
- Replace the demo card processor with a PCI-compliant gateway before taking real cards.
