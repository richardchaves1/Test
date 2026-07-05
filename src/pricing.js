'use strict';

const { db } = require('./db');

// ---------- timezone helpers ----------

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dowMap[parts.weekday],
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    hhmm: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
  };
}

function parseHHMM(s) {
  const [h, m] = String(s).split(':').map(Number);
  return (h * 60) + (m || 0);
}

// ---------- rule matching ----------

function activeRulesFor(locationId) {
  return db.prepare(`
    SELECT * FROM pricing_rules
    WHERE active = 1 AND (location_id IS NULL OR location_id = ?)
    ORDER BY priority DESC, id ASC
  `).all(locationId);
}

function ruleMatchesInstant(rule, parts) {
  const days = String(rule.days_of_week).split(',').map((s) => Number(s.trim()));
  if (!days.includes(parts.dow)) return false;
  const start = parseHHMM(rule.start_time);
  const end = parseHHMM(rule.end_time);
  if (!(parts.minutes >= start && parts.minutes < end)) return false;
  if (rule.start_date && parts.date < rule.start_date) return false;
  if (rule.end_date && parts.date > rule.end_date) return false;
  return true;
}

// ---------- quote ----------

/**
 * Compute a price quote.
 * @param {object} location  locations row
 * @param {Date}   startDate stay start (instant)
 * @param {number} hours     stay length in whole hours (1..168)
 * @param {string} [promoCode]
 * @returns {{ baseAmount:number, discountAmount:number, totalAmount:number,
 *            campaignId:number|null, promoCode:string|null, notes:string[], promoError:string|null }}
 */
function quote(location, startDate, hours, promoCode) {
  hours = Math.max(1, Math.min(168, Math.floor(hours)));
  const rules = activeRulesFor(location.id);
  const startParts = localParts(startDate, location.timezone);
  const notes = [];

  let baseAmount = null;

  // 1) Flat rules keyed off the stay start time (early bird, evening flat...)
  const flat = rules.find((r) =>
    r.rule_type === 'flat' &&
    ruleMatchesInstant(r, startParts) &&
    (r.max_hours == null || hours <= r.max_hours));
  if (flat) {
    baseAmount = Math.round(flat.value);
    notes.push(`Flat rate applied: ${flat.name}`);
  }

  // 2) Otherwise integrate hourly with override/multiplier rules, capped by daily max per 24h block.
  if (baseAmount == null) {
    const hourlyCharges = [];
    const appliedRules = new Set();
    for (let i = 0; i < hours; i++) {
      const parts = localParts(new Date(startDate.getTime() + i * 3600_000), location.timezone);
      const rule = rules.find((r) => r.rule_type !== 'flat' && ruleMatchesInstant(r, parts));
      let rate = location.hourly_rate;
      if (rule) {
        rate = rule.rule_type === 'override' ? Math.round(rule.value) : Math.round(location.hourly_rate * rule.value);
        appliedRules.add(rule.name);
      }
      hourlyCharges.push(rate);
    }
    baseAmount = 0;
    for (let i = 0; i < hourlyCharges.length; i += 24) {
      let block = hourlyCharges.slice(i, i + 24).reduce((a, b) => a + b, 0);
      if (location.daily_max > 0 && block > location.daily_max) {
        block = location.daily_max;
        notes.push('Daily maximum applied');
      }
      baseAmount += block;
    }
    for (const name of appliedRules) notes.push(`Rate rule applied: ${name}`);
  }

  // 3) Promo code from marketing campaigns.
  let discountAmount = 0;
  let campaignId = null;
  let appliedPromo = null;
  let promoError = null;
  if (promoCode && promoCode.trim()) {
    const code = promoCode.trim().toUpperCase();
    const c = db.prepare('SELECT * FROM campaigns WHERE promo_code = ? COLLATE NOCASE').get(code);
    const today = startParts.date;
    if (!c || !c.active) promoError = 'Promo code not recognized.';
    else if (c.starts_at && today < c.starts_at) promoError = 'Promo code is not active yet.';
    else if (c.ends_at && today > c.ends_at) promoError = 'Promo code has expired.';
    else if (c.max_redemptions != null && c.redemptions >= c.max_redemptions) promoError = 'Promo code redemption limit reached.';
    else if (c.location_id != null && c.location_id !== location.id) promoError = 'Promo code is not valid at this location.';
    else {
      discountAmount = c.discount_type === 'percent'
        ? Math.round(baseAmount * (c.discount_value / 100))
        : Math.round(c.discount_value);
      discountAmount = Math.min(discountAmount, baseAmount);
      campaignId = c.id;
      appliedPromo = c.promo_code;
      notes.push(`Promo ${c.promo_code} applied (${c.discount_type === 'percent' ? `${c.discount_value}% off` : `$${(c.discount_value / 100).toFixed(2)} off`})`);
    }
  }

  return {
    baseAmount,
    discountAmount,
    totalAmount: baseAmount - discountAmount,
    campaignId,
    promoCode: appliedPromo,
    notes,
    promoError,
  };
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = { quote, money, localParts };
