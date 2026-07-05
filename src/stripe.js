'use strict';

// Stripe integration without the SDK — plain HTTPS calls to the Stripe API.
// Enabled by setting STRIPE_SECRET_KEY. STRIPE_API_BASE is overridable so the
// integration can be exercised against a local stub in tests.

const crypto = require('node:crypto');

function apiBase() {
  return (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');
}

function secretKey() {
  return process.env.STRIPE_SECRET_KEY || '';
}

function enabled() {
  return Boolean(secretKey());
}

/** Flatten a nested object into Stripe's form encoding: {a:{b:1}} → a[b]=1, arrays → a[0]. */
function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) formEncode(item, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === 'object') {
      formEncode(v, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

async function request(method, path, params) {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
    body: method === 'GET' ? undefined : formEncode(params || {}).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `Stripe API error (HTTP ${res.status})`;
    const err = new Error(msg);
    err.stripe = body?.error;
    throw err;
  }
  return body;
}

/**
 * Create a hosted Checkout Session for a one-off parking charge.
 * Returns { id, url } — redirect the driver to url.
 */
async function createCheckoutSession({ productName, description, amountCents, ref, kind, successUrl, cancelUrl, customerEmail }) {
  return request('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Expire quickly (Stripe minimum is 30 min) so an abandoned checkout can't
    // be paid long after its capacity hold has lapsed.
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    client_reference_id: ref,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: { name: productName, ...(description ? { description } : {}) },
      },
    }],
    metadata: { ref, kind },
  });
}

async function getCheckoutSession(id) {
  return request('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);
}

async function refundPaymentIntent(paymentIntentId) {
  return request('POST', '/v1/refunds', { payment_intent: paymentIntentId });
}

/**
 * Verify a Stripe webhook signature (Stripe-Signature header) against the raw body.
 * Returns the parsed event on success, or null on failure.
 */
function verifyWebhook(rawBody, signatureHeader, secret, toleranceSec = 300) {
  if (!rawBody || !signatureHeader || !secret) return null;
  const parts = {};
  for (const kv of String(signatureHeader).split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) {
      const k = kv.slice(0, i).trim();
      (parts[k] ||= []).push(kv.slice(i + 1).trim());
    }
  }
  const t = Number(parts.t?.[0]);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const match = (parts.v1 || []).some((sig) => {
    const buf = Buffer.from(sig);
    return buf.length === expectedBuf.length && crypto.timingSafeEqual(buf, expectedBuf);
  });
  if (!match) return null;
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { enabled, createCheckoutSession, getCheckoutSession, refundPaymentIntent, verifyWebhook };
