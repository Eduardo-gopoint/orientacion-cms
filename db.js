'use strict';
const { Pool } = require('pg');

const connectionString = process.env.SUPABASE_DATABASE_URL;

if (!connectionString) {
  console.warn('[db] SUPABASE_DATABASE_URL no está definida — la base de datos no funcionará.');
}

// Supabase exige SSL. rejectUnauthorized:false porque el pooler usa cert propio.
const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] error inesperado en el pool:', err.message);
});

// Crea la tabla de leads si no existe (idempotente).
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id           BIGSERIAL PRIMARY KEY,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      name         TEXT NOT NULL,
      email        TEXT NOT NULL,
      phone        TEXT,
      message      TEXT,
      source_page  TEXT,
      ip           TEXT,
      user_agent   TEXT,
      emailed      BOOLEAN NOT NULL DEFAULT false
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);`);
  console.log('[db] tabla leads verificada');
}

async function insertLead(lead) {
  const { name, email, phone, message, source_page, ip, user_agent, emailed } = lead;
  const { rows } = await pool.query(
    `INSERT INTO leads (name, email, phone, message, source_page, ip, user_agent, emailed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [name, email, phone || null, message || null, source_page || null, ip || null, user_agent || null, !!emailed]
  );
  return rows[0];
}

async function listLeads(limit = 200) {
  const { rows } = await pool.query(
    `SELECT id, created_at, name, email, phone, message, source_page, emailed
     FROM leads ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Number(limit) || 200, 1000)]
  );
  return rows;
}

async function markEmailed(id) {
  await pool.query(`UPDATE leads SET emailed = true WHERE id = $1`, [id]);
}

module.exports = { pool, init, insertLead, listLeads, markEmailed };
