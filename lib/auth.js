'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const SESSION_DAYS = 90;

function ensureAdminUser() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const password = process.env.ADMIN_PASSWORD || 'admin';
    db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run(
      'admin',
      bcrypt.hashSync(password, 10)
    );
    console.log(
      `[auth] Admin-Benutzer "admin" angelegt (Passwort: ${process.env.ADMIN_PASSWORD ? 'aus ADMIN_PASSWORD' : '"admin" – bitte im Adminportal aendern!'})`
    );
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function getSessionUser(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)session=([a-f0-9]{64})/);
  if (!match) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.is_admin, s.token FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(match[1]);
  return row || null;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Nicht angemeldet' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Nicht angemeldet' });
  if (!user.is_admin) return res.status(403).json({ error: 'Keine Admin-Rechte' });
  req.user = user;
  next();
}

function verifyLogin(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  return bcrypt.compareSync(password, user.password_hash) ? user : null;
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

module.exports = {
  ensureAdminUser,
  createSession,
  destroySession,
  getSessionUser,
  requireAuth,
  requireAdmin,
  verifyLogin,
  setSessionCookie,
  clearSessionCookie,
  hashPassword: (pw) => bcrypt.hashSync(pw, 10),
};
