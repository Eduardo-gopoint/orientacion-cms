'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

// Secreto de firma de sesión: usa JWT_SECRET si existe; si no, uno derivado estable
// del ADMIN_TOKEN/DATABASE_URL para no invalidar sesiones en cada arranque.
const JWT_SECRET = process.env.JWT_SECRET
  || crypto.createHash('sha256').update(String(process.env.ADMIN_TOKEN || '') + String(process.env.SUPABASE_DATABASE_URL || 'orientacion-cms')).digest('hex');

const COOKIE = 'orv_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 h

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

// Crea/actualiza el admin semilla desde variables de entorno (no queda en el repo).
async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('[auth] SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD no definidos — no se crea admin semilla.');
    return;
  }
  const password_hash = await hashPassword(password);
  await db.upsertUser({ email, name: 'Administrador', role: 'admin', password_hash });
  console.log('[auth] admin semilla verificado:', email);
}

async function verifyLogin(email, password) {
  const user = await db.findUserByEmail(email);
  if (!user || !user.active) return null;
  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return null;
  db.touchLogin(user.id).catch(() => {});
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

function issueToken(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function readSession(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Middleware: exige sesión válida. Para páginas HTML redirige a /login.
function requireAuth(opts = {}) {
  return (req, res, next) => {
    const sess = readSession(req);
    if (!sess) {
      if (opts.html) return res.redirect('/login');
      return res.status(401).json({ ok: false, error: 'No autenticado.' });
    }
    req.user = sess;
    next();
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || (role === 'admin' && req.user.role !== 'admin')) {
      return res.status(403).json({ ok: false, error: 'Requiere rol admin.' });
    }
    next();
  };
}

module.exports = {
  seedAdmin, verifyLogin, issueToken, setSessionCookie, clearSessionCookie,
  readSession, requireAuth, requireRole, hashPassword, COOKIE,
};
