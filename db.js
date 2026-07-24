'use strict';
const { Pool } = require('pg');

const connectionString = process.env.SUPABASE_DATABASE_URL;

if (!connectionString) {
  console.warn('[db] SUPABASE_DATABASE_URL no está definida — la base de datos no funcionará.');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('[db] error inesperado en el pool:', err.message));

// ---------- Esquema (idempotente) ----------
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id           BIGSERIAL PRIMARY KEY,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      name         TEXT NOT NULL DEFAULT '',
      email        TEXT NOT NULL DEFAULT '',
      phone        TEXT,
      message      TEXT,
      source       TEXT NOT NULL DEFAULT 'web',
      source_page  TEXT,
      ip           TEXT,
      user_agent   TEXT,
      emailed      BOOLEAN NOT NULL DEFAULT false,
      scheduled    BOOLEAN NOT NULL DEFAULT false,
      scheduled_at TIMESTAMPTZ,
      calendar_ref TEXT,
      raw          JSONB
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);`);
  // Migraciones suaves por si la tabla ya existía sin estas columnas.
  for (const col of [
    "ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web'",
    "ADD COLUMN IF NOT EXISTS scheduled BOOLEAN NOT NULL DEFAULT false",
    "ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ",
    "ADD COLUMN IF NOT EXISTS calendar_ref TEXT",
    "ADD COLUMN IF NOT EXISTS raw JSONB",
  ]) {
    try { await pool.query(`ALTER TABLE leads ${col};`); } catch (e) { /* noop */ }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGSERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      email         TEXT NOT NULL UNIQUE,
      name          TEXT,
      role          TEXT NOT NULL DEFAULT 'editor',
      password_hash TEXT NOT NULL,
      active         BOOLEAN NOT NULL DEFAULT true,
      last_login_at TIMESTAMPTZ
    );
  `);
  console.log('[db] tablas leads y users verificadas');
}

// ---------- Leads ----------
async function insertLead(lead) {
  const { name, email, phone, message, source, source_page, ip, user_agent, emailed, raw } = lead;
  const { rows } = await pool.query(
    `INSERT INTO leads (name, email, phone, message, source, source_page, ip, user_agent, emailed, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
    [name || '', email || '', phone || null, message || null, source || 'web',
     source_page || null, ip || null, user_agent || null, !!emailed, raw ? JSON.stringify(raw) : null]
  );
  return rows[0];
}

async function listLeads({ limit = 500, source } = {}) {
  const params = [];
  let where = '';
  if (source) { params.push(source); where = `WHERE source = $${params.length}`; }
  params.push(Math.min(Number(limit) || 500, 2000));
  const { rows } = await pool.query(
    `SELECT id, created_at, name, email, phone, message, source, source_page, emailed, scheduled, scheduled_at, calendar_ref
     FROM leads ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function markEmailed(id) {
  await pool.query(`UPDATE leads SET emailed = true WHERE id = $1`, [id]);
}

async function findLeadByEmail(email) {
  const { rows } = await pool.query(
    `SELECT * FROM leads WHERE lower(email) = lower($1) ORDER BY created_at DESC LIMIT 1`, [email]);
  return rows[0] || null;
}

async function markScheduled(id, scheduledAt, calendarRef) {
  await pool.query(
    `UPDATE leads SET scheduled = true, scheduled_at = $2, calendar_ref = $3 WHERE id = $1`,
    [id, scheduledAt || null, calendarRef || null]);
}

async function leadsStats() {
  const { rows } = await pool.query(`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE source='web')::int AS web,
      count(*) FILTER (WHERE source='whatsapp')::int AS whatsapp,
      count(*) FILTER (WHERE scheduled)::int AS agendados
    FROM leads`);
  return rows[0];
}

// ---------- Users ----------
async function findUserByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
  return rows[0] || null;
}

async function listUsers() {
  const { rows } = await pool.query(
    `SELECT id, created_at, email, name, role, active, last_login_at FROM users ORDER BY created_at ASC`);
  return rows;
}

async function upsertUser({ email, name, role, password_hash }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name),
       role = EXCLUDED.role, password_hash = EXCLUDED.password_hash
     RETURNING id, email, name, role, active`,
    [email.toLowerCase(), name || null, role || 'editor', password_hash]);
  return rows[0];
}

async function setUserActive(id, active) {
  await pool.query(`UPDATE users SET active = $2 WHERE id = $1`, [id, !!active]);
}

async function deleteUser(id) {
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
}

async function touchLogin(id) {
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
}

async function countUsers() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users`);
  return rows[0].n;
}

module.exports = {
  pool, init,
  insertLead, listLeads, markEmailed, findLeadByEmail, markScheduled, leadsStats,
  findUserByEmail, listUsers, upsertUser, setUserActive, deleteUser, touchLogin, countUsers,
};
