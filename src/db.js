'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.PCA_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'pca.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,          -- short code used in QR URL, e.g. PCA-1A2B
  name        TEXT NOT NULL,
  address     TEXT NOT NULL,
  city        TEXT NOT NULL,
  state       TEXT NOT NULL,
  zip         TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  capacity    INTEGER NOT NULL DEFAULT 50,
  hourly_rate INTEGER NOT NULL DEFAULT 300,  -- cents
  daily_max   INTEGER NOT NULL DEFAULT 2400, -- cents, 0 = no cap
  timezone    TEXT NOT NULL DEFAULT 'America/New_York',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id  INTEGER REFERENCES locations(id) ON DELETE CASCADE, -- NULL = all locations
  name         TEXT NOT NULL,
  rule_type    TEXT NOT NULL CHECK (rule_type IN ('multiplier','override','flat')),
  value        REAL NOT NULL,                 -- multiplier factor, or cents for override/flat
  days_of_week TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6', -- 0=Sun
  start_time   TEXT NOT NULL DEFAULT '00:00', -- HH:MM local
  end_time     TEXT NOT NULL DEFAULT '24:00',
  start_date   TEXT,                          -- YYYY-MM-DD inclusive, NULL = always
  end_date     TEXT,
  max_hours    INTEGER,                       -- flat rules: only if stay <= max_hours (NULL = any)
  priority     INTEGER NOT NULL DEFAULT 0,    -- higher wins
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  headline        TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  channel         TEXT NOT NULL DEFAULT 'signage', -- signage | email | social | sms
  location_id     INTEGER REFERENCES locations(id) ON DELETE SET NULL, -- NULL = all
  promo_code      TEXT UNIQUE,                  -- NULL = awareness campaign, no code
  discount_type   TEXT CHECK (discount_type IN ('percent','fixed')),
  discount_value  REAL,                         -- percent (0-100) or cents
  starts_at       TEXT,                         -- YYYY-MM-DD
  ends_at         TEXT,
  max_redemptions INTEGER,                      -- NULL = unlimited
  redemptions     INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT NOT NULL UNIQUE,          -- receipt reference, e.g. PCA-XXXXXXXX
  location_id     INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  plate           TEXT NOT NULL,
  email           TEXT NOT NULL DEFAULT '',
  start_ts        TEXT NOT NULL,                 -- ISO UTC
  end_ts          TEXT NOT NULL,
  hours           REAL NOT NULL,
  base_amount     INTEGER NOT NULL,              -- cents before discount
  discount_amount INTEGER NOT NULL DEFAULT 0,
  total_amount    INTEGER NOT NULL,
  promo_code      TEXT,
  campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  payment_method  TEXT NOT NULL DEFAULT 'card',
  status          TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','refunded','void')),
  pricing_notes   TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_location ON sessions(location_id);
CREATE INDEX IF NOT EXISTS idx_sessions_plate ON sessions(plate);
CREATE INDEX IF NOT EXISTS idx_sessions_end ON sessions(end_ts);
`);

// ---------- helpers ----------

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function newLocationCode() {
  // Short, uppercase, unambiguous code for QR URLs.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return `PCA-${s}`;
}

function uniqueLocationCode() {
  const stmt = db.prepare('SELECT 1 FROM locations WHERE code = ?');
  for (let i = 0; i < 50; i++) {
    const code = newLocationCode();
    if (!stmt.get(code)) return code;
  }
  throw new Error('Could not generate a unique location code');
}

function newReceiptRef() {
  return `PCA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ---------- seed ----------

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    const email = process.env.PCA_ADMIN_EMAIL || 'admin@parkwithpca.com';
    const password = process.env.PCA_ADMIN_PASSWORD || 'ChangeMe!PCA2026';
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (email, name, password_hash, salt) VALUES (?, ?, ?, ?)')
      .run(email, 'PCA Administrator', hashPassword(password, salt), salt);
    console.log(`[seed] Admin user created: ${email} (password: ${process.env.PCA_ADMIN_PASSWORD ? 'from PCA_ADMIN_PASSWORD env' : password})`);
  }

  const locCount = db.prepare('SELECT COUNT(*) AS n FROM locations').get().n;
  if (locCount === 0 && process.env.PCA_SKIP_SEED !== '1') {
    const insertLoc = db.prepare(`INSERT INTO locations
      (code, name, address, city, state, zip, description, capacity, hourly_rate, daily_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const loc1 = insertLoc.run(uniqueLocationCode(), 'Downtown Garage', '101 Main Street', 'Charlotte', 'NC', '28202',
      'Covered garage, 2 blocks from the convention center. Clearance 6\'8".', 220, 400, 2800).lastInsertRowid;
    const loc2 = insertLoc.run(uniqueLocationCode(), 'Airport Economy Lot', '5500 Airport Blvd', 'Charlotte', 'NC', '28208',
      'Open-air economy lot with free shuttle to all terminals every 10 minutes.', 600, 200, 1200).lastInsertRowid;
    const loc3 = insertLoc.run(uniqueLocationCode(), 'Stadium Lot C', '800 South Mint Street', 'Charlotte', 'NC', '28203',
      'Walking distance to the stadium. Event pricing applies on game days.', 350, 300, 2000).lastInsertRowid;

    const insertRule = db.prepare(`INSERT INTO pricing_rules
      (location_id, name, rule_type, value, days_of_week, start_time, end_time, max_hours, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertRule.run(loc1, 'Early Bird (in by 9am, up to 10h)', 'flat', 1200, '1,2,3,4,5', '05:00', '09:00', 10, 10);
    insertRule.run(loc1, 'Evening Flat Rate (after 5pm)', 'flat', 1000, '0,1,2,3,4,5,6', '17:00', '24:00', 8, 5);
    insertRule.run(loc3, 'Game Day Surge (Sat/Sun)', 'multiplier', 2.0, '0,6', '10:00', '20:00', null, 10);
    insertRule.run(null, 'Weekend Discount Hourly', 'override', 250, '0,6', '00:00', '24:00', null, 1);

    const insertCampaign = db.prepare(`INSERT INTO campaigns
      (name, headline, body, channel, location_id, promo_code, discount_type, discount_value, starts_at, ends_at, max_redemptions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertCampaign.run(
      'Grand Opening 20% Off', 'Park downtown for 20% off', 'Scan the QR code at any PCA downtown location and use code WELCOME20 at checkout for 20% off your stay.',
      'signage', null, 'WELCOME20', 'percent', 20, null, null, 500);
    insertCampaign.run(
      'Airport $2 Off', 'Save $2 on airport parking', 'Book your airport parking with PCA and take $2 off with code FLYPCA.',
      'email', loc2, 'FLYPCA', 'fixed', 200, null, null, null);

    console.log('[seed] Sample locations, pricing rules, and campaigns created');
  }
}

seed();

module.exports = { db, hashPassword, uniqueLocationCode, newReceiptRef };
