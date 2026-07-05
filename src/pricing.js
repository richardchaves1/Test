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

/** Wall-clock offset of a timezone at a given UTC instant, in ms. */
function tzOffsetMs(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = {};
  for (const x of fmt.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Convert a local wall-clock date+time in a timezone to a UTC Date.
 * (Two-pass to converge across DST boundaries.)
 */
function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr).split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let utc = wall;
  for (let i = 0; i < 2; i++) utc = wall - tzOffsetMs(utc, timeZone);
  // Nonexistent wall time (spring-forward gap): the round trip lands an hour
  // early — shift forward so the stay never starts before the requested time.
  const check = localParts(new Date(utc), timeZone);
  if (check.date !== String(dateStr) || check.minutes !== hh * 60 + mm) {
    utc += 3600_000;
  }
  return new Date(utc);
}

/** Inclusive display form of an exclusive end date (the day before). */
function inclusiveEnd(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Today's date (YYYY-MM-DD) in a timezone. */
function localToday(timeZone) {
  return localParts(new Date(), timeZone).date;
}

/** Add one calendar month to a YYYY-MM-DD date, clamping to the last day of the target month. */
function addOneMonth(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + 1, d));
  if (target.getUTCMonth() !== (m % 12)) {
    // day overflowed (e.g. Jan 31 → Feb): clamp to last day of the target month
    return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  }
  return target.toISOString().slice(0, 10);
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
  const inWindow = start <= end
    ? parts.minutes >= start && parts.minutes < end
    : parts.minutes >= start || parts.minutes < end; // overnight window, e.g. 22:00–06:00
  if (!inWindow) return false;
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

  // 1) Flat rules keyed off the stay start time (early bird, evening flat...).
  //    "Highest priority wins": a flat rule only applies if no matching
  //    override/multiplier rule outranks it at the stay start.
  const flat = rules.find((r) =>
    r.rule_type === 'flat' &&
    ruleMatchesInstant(r, startParts) &&
    (r.max_hours == null || hours <= r.max_hours));
  const topHourly = rules.find((r) => r.rule_type !== 'flat' && ruleMatchesInstant(r, startParts));
  if (flat && (!topHourly || flat.priority >= topHourly.priority)) {
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
      // Card networks can't charge less than $0.50 — waive sub-minimum remainders.
      if (discountAmount > 0 && baseAmount - discountAmount > 0 && baseAmount - discountAmount < 50) {
        discountAmount = baseAmount;
        notes.push('Remainder under $0.50 waived');
      }
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

module.exports = { quote, money, localParts, zonedTimeToUtc, localToday, addOneMonth, inclusiveEnd };
