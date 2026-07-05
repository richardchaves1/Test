# PCA Parking Platform

A self-hosted parking sales and management platform for **Parking Company of America** — in the spirit of ParkMobile / SpotHero / ParkWhiz, but branded and operated by PCA.

Drivers scan a **QR code posted at each location**, which opens that location's own mobile payment page. From there they can **park now**, **reserve a spot ahead of time**, or **buy a monthly pass** — no app required. Operators manage everything from a branded admin console. The PCA logo (US-map wordmark) is rendered as inline SVG so it stays crisp on every page, sign, and favicon.

## Features

### Driver experience (public)
- **`/` Landing page** — list of active PCA locations with hourly and monthly rates.
- **`/p/<CODE>` Payment page per location** — where each location's QR code points. Three tabs:
  - **Park now** — plate → duration → live price quote (promo codes apply) → pay.
  - **Reserve ahead** — pick a date/time up to 90 days out, priced by the same rule engine for that future window, with live "spots left" feedback. Free self-service cancellation (full refund, Stripe refund included) any time before the reservation starts.
  - **Monthly pass** — recurring commuters buy a plate-linked pass; enforcement recognizes the plate automatically. Renewable from the pass page; each pass covers one calendar month.
- **`/r/<REF>`** — receipt/reservation page with live status (`PARKING ACTIVE`, `RESERVED — STARTS …`) and cancellation for future reservations.
- **`/pass/<REF>`** — pass status, validity window, and one-click renewal.

### Operator console (`/admin`)
- **Dashboard** — revenue today / 7-day / all-time (sessions + passes), cars parked now, upcoming reservations, active passes, occupancy bars, recent transactions.
- **Locations** — add/edit lots and garages (capacity, base hourly rate, daily max, monthly rate, timezone). Every location automatically gets a unique short code, payment URL, downloadable **QR code** (PNG + SVG), and a **printable branded "SCAN TO PAY" sign**.
- **Pricing rules** — layered on each location's base rate; highest priority wins:
  - `flat` — one price for a stay starting in the window (early bird, evening flat), optional max-stay cap,
  - `override` — replace the hourly rate in a window,
  - `multiplier` — surge or discount the hourly rate (event pricing),
  - scoped per location or global, by day-of-week, time window, and optional date range. Daily max caps every 24-hour block. Reservations are priced with the rules that will apply **at their future start time**.
- **Marketing campaigns** — per channel (signage/email/social/SMS) with headline + copy and optional **promo codes**: percent or fixed discounts, start/end dates, redemption caps, per-location targeting, plus redemption/revenue tracking.
- **Transactions** — full ledger (drive-up vs reservation, payment method) with one-click refunds (issues real Stripe refunds when applicable).
- **Passes** — every monthly pass with holder, plate, validity, and refund/revoke.
- **Enforcement** — attendants look up a plate and get an instant **PAID / NOT PAID** answer across sessions, reservations, *and* monthly passes.

## Quick start

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`).

```bash
npm install
npm start        # http://localhost:3000
```

- Driver pages: `http://localhost:3000/`
- Admin console: `http://localhost:3000/admin`
  - Default login: `admin@parkwithpca.com` / `ChangeMe!PCA2026` (change via env vars below before going live).

On first boot the app seeds the admin user plus sample locations, pricing rules, and campaigns (`WELCOME20`, `FLYPCA`). Set `PCA_SKIP_SEED=1` to start empty.

## Payments: demo mode vs Stripe

**Without Stripe keys** the app runs a built-in demo card processor: it validates card format (Luhn), never stores card data, and approves valid-format cards — ideal for pilots. Test card `4242 4242 4242 4242`, any future `MM/YY`, any CVC.

**With Stripe configured**, card fields disappear and every purchase (drive-up, reservation, pass, renewal) goes through **Stripe Checkout** — PCI compliance stays on Stripe's side:

1. Create a [Stripe](https://dashboard.stripe.com) account and grab your secret key.
2. Set `STRIPE_SECRET_KEY=sk_live_…` (or `sk_test_…` to trial with Stripe test cards).
3. Recommended: add a webhook endpoint in Stripe pointing at `https://<your-domain>/webhooks/stripe` for the `checkout.session.completed` and `checkout.session.expired` events, and set `STRIPE_WEBHOOK_SECRET=whsec_…`. The webhook completes payments even if the driver closes their phone before returning from Stripe; expired checkouts free their held spot.

Flow details: checkout rows are created as `pending`, become `paid` on the Stripe return trip or webhook (idempotently — promo redemptions count exactly once), and abandoned checkouts are voided. Refunds from the admin console or reservation cancellations call Stripe's refund API before updating the ledger.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PCA_BASE_URL` | request host | **Set this in production** (e.g. `https://pay.parkwithpca.com`) so QR codes and Stripe return URLs use your public domain |
| `STRIPE_SECRET_KEY` | unset (demo mode) | Enables Stripe Checkout |
| `STRIPE_WEBHOOK_SECRET` | unset | Enables `/webhooks/stripe` signature verification |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Override for integration tests against a stub |
| `PCA_ADMIN_EMAIL` | `admin@parkwithpca.com` | Seeded admin login |
| `PCA_ADMIN_PASSWORD` | `ChangeMe!PCA2026` | Seeded admin password |
| `PCA_SESSION_SECRET` | generated & persisted | HMAC secret for admin session cookies |
| `PCA_DATA_DIR` | `./data` | Where the SQLite database lives |
| `PCA_SKIP_SEED` | off | `1` = don't create sample data |

## QR codes in production

QR codes are generated on the fly from `PCA_BASE_URL + /p/ + location code`. Deploy behind your public domain, set `PCA_BASE_URL`, then print each location's sign from its detail page. Reprinting is never needed when rates change — the QR points at the live payment page.

## Capacity & reservations

Every purchase checks live capacity for its exact time window: paid sessions and recent pending checkouts that overlap the window count against the location's capacity, so a lot can't be oversold for an event. The payment page shows "Only N spots left" as availability tightens.

## Architecture

```
server.js               Express app entry (raw-body mounting for Stripe webhooks)
src/db.js               SQLite schema, migrations, seed (node:sqlite, WAL mode)
src/pricing.js          Quote engine, timezone helpers (DST-safe), month arithmetic
src/stripe.js           SDK-free Stripe client + webhook signature verification
src/auth.js             Admin login, HMAC-signed session cookies
src/routes/admin.js     Operator console
src/routes/public.js    Driver pages (tabs, quote API, checkout, passes, receipts, Stripe return/webhook)
src/views/logo.js       PCA logo as inline SVG
src/views/layout.js     Branded HTML shells
public/                 Stylesheets
data/pca.db             SQLite database (created at runtime, git-ignored)
```

No build step, two runtime dependencies (`express`, `qrcode`).

## Security notes for going live

- Change the admin password (`PCA_ADMIN_PASSWORD`) and set `PCA_SESSION_SECRET`.
- Terminate TLS in front of the app (QR payment pages must be HTTPS).
- Configure Stripe (`STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`) — never take real cards through the demo processor.
