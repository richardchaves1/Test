'use strict';

const crypto = require('node:crypto');
const { db, hashPassword } = require('./db');

const SECRET = process.env.PCA_SESSION_SECRET || (() => {
  // Persist a generated secret so admin sessions survive restarts.
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('session_secret');
  if (row) return row.value;
  const s = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('session_secret', s);
  return s;
})();

const COOKIE = 'pca_admin';
const MAX_AGE_S = 60 * 60 * 12; // 12h

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const body = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function login(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email || '').trim());
  if (!user) return null;
  const hash = hashPassword(String(password || ''), user.salt);
  const a = Buffer.from(hash);
  const b = Buffer.from(user.password_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return user;
}

function setSessionCookie(req, res, user) {
  const token = sign({ uid: user.id, email: user.email, name: user.name, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S });
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Express middleware: require an authenticated admin, else redirect to /admin/login. */
function requireAdmin(req, res, next) {
  const payload = verify(parseCookies(req)[COOKIE]);
  if (!payload) return res.redirect('/admin/login');
  req.admin = payload;
  next();
}

module.exports = { login, setSessionCookie, clearSessionCookie, requireAdmin };
