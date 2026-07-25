'use strict';
// Módulo de carreras/instituciones para el buscador de orientacionvocacional.cl
// Migra el dataset (Mi Futuro) que hoy vive incrustado (~2,5 MB) en la página del
// buscador hacia Supabase, y expone búsqueda server-side para aligerar la página.
const { pool } = require('./db');

// Fuente del dataset actual (se lee del sitio en vivo para no versionar 2,5 MB en el repo).
const DATASET_URL = process.env.CAREERS_DATASET_URL
  || 'https://orientacion-mirror.onrender.com/buscador-carreras-instituciones/';

// ---------- utilidades ----------
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .toLowerCase().trim().replace(/\s+/g, ' ');
}
function arancelToInt(s) {
  const digits = String(s || '').replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

// ---------- esquema (idempotente) ----------
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS instituciones (
      id                BIGSERIAL PRIMARY KEY,
      nombre            TEXT NOT NULL UNIQUE,
      tipo              TEXT NOT NULL,
      sigla             TEXT,
      sitio_web         TEXT,
      acreditacion      TEXT,
      anos_acreditacion INT,
      logo_url          TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS programas (
      id             BIGSERIAL PRIMARY KEY,
      ficha          TEXT NOT NULL UNIQUE,
      institucion_id BIGINT REFERENCES instituciones(id),
      institucion    TEXT NOT NULL,
      tipo           TEXT NOT NULL,
      area           TEXT,
      carrera        TEXT NOT NULL,
      sede           TEXT,
      region         TEXT,
      jornada        TEXT,
      duracion       TEXT,
      arancel_texto  TEXT,
      arancel_valor  INT,
      search_text    TEXT,
      carrera_norm   TEXT,
      empleabilidad     NUMERIC,
      ingreso_promedio  INT,
      puntaje_corte     INT,
      link_oficial      TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Migración suave: columnas que pueden faltar si la tabla ya existía.
  try { await pool.query(`ALTER TABLE programas ADD COLUMN IF NOT EXISTS carrera_norm TEXT;`); } catch (e) { /* noop */ }
  // Clasificación de instituciones: dependencia (estatal | g9 | privada) y gratuidad.
  for (const col of [
    'ADD COLUMN IF NOT EXISTS dependencia TEXT',
    'ADD COLUMN IF NOT EXISTS gratuidad BOOLEAN',
  ]) {
    try { await pool.query(`ALTER TABLE instituciones ${col};`); } catch (e) { /* noop */ }
  }
  try { await pool.query(`CREATE INDEX IF NOT EXISTS instituciones_dependencia_idx ON instituciones (dependencia);`); } catch (e) { /* noop */ }
  await pool.query(`CREATE INDEX IF NOT EXISTS programas_institucion_idx ON programas (institucion_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS programas_region_idx ON programas (region);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS programas_tipo_idx ON programas (tipo);`);
  // pg_trgm acelera los ILIKE de búsqueda; si no se puede crear, ILIKE igual funciona.
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS programas_search_trgm ON programas USING gin (search_text gin_trgm_ops);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS programas_carrera_norm_trgm ON programas USING gin (carrera_norm gin_trgm_ops);`);
  } catch (e) { console.warn('[careers] pg_trgm no disponible (búsqueda funciona igual):', e.message); }
  // Contenido editorial por carrera (descripción/beneficios) para el aside dinámico.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carreras_info (
      carrera_norm      TEXT PRIMARY KEY,
      carrera           TEXT,
      descripcion       TEXT,
      duracion_promedio TEXT,
      area_desempeno    TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('[careers] esquema instituciones/programas/carreras_info verificado');
}

// ---------- descarga + parseo del dataset incrustado ----------
async function fetchDataset() {
  const resp = await fetch(DATASET_URL, { headers: { 'User-Agent': 'orientacion-cms-migrator' } });
  if (!resp.ok) throw new Error('fetch dataset HTTP ' + resp.status);
  const html = await resp.text();
  const marker = 'window.ORV_CAREER_ROWS=';
  const i = html.indexOf(marker);
  if (i < 0) throw new Error('no se encontró ORV_CAREER_ROWS en el HTML');
  const start = html.indexOf('[', i);
  let depth = 0, end = -1;
  for (let k = start; k < html.length; k++) {
    const ch = html[k];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  if (end < 0) throw new Error('no se pudo delimitar el array ORV_CAREER_ROWS');
  const rows = JSON.parse(html.slice(start, end));
  if (!Array.isArray(rows) || !rows.length) throw new Error('dataset vacío');
  return rows;
}

// ---------- migración (idempotente vía ON CONFLICT) ----------
async function migrate() {
  const rows = await fetchDataset();

  // 1) instituciones únicas → mapa nombre→id
  const instByName = new Map();
  for (const r of rows) {
    const nombre = (r.institucion || '').trim();
    if (nombre && !instByName.has(nombre)) instByName.set(nombre, (r.tipo || '').trim());
  }
  const idByName = new Map();
  for (const [nombre, tipo] of instByName) {
    const { rows: out } = await pool.query(
      `INSERT INTO instituciones (nombre, tipo) VALUES ($1,$2)
       ON CONFLICT (nombre) DO UPDATE SET tipo = EXCLUDED.tipo
       RETURNING id`, [nombre, tipo || null]);
    idByName.set(nombre, out[0].id);
  }

  // 2) programas por lotes (upsert por ficha) — 14 columnas por fila
  const COLS = 14;
  const BATCH = 400;
  const rowToParams = (r) => {
    const inst = (r.institucion || '').trim();
    return [
      (r.ficha || '').trim(),                 // ficha
      idByName.get(inst) || null,             // institucion_id
      inst,                                   // institucion
      (r.tipo || '').trim(),                  // tipo
      (r.area || '').trim() || null,          // area
      (r.carrera || '').trim(),               // carrera
      (r.sede || '').trim() || null,          // sede
      (r.region || '').trim() || null,        // region
      (r.jornada || '').trim() || null,       // jornada
      (r.duracion || '').trim() || null,      // duracion
      (r.arancel || '').trim() || null,       // arancel_texto
      arancelToInt(r.arancel),                // arancel_valor
      norm(`${r.carrera || ''} ${r.institucion || ''}`), // search_text
      norm(r.carrera),                        // carrera_norm
    ];
  };
  for (let b = 0; b < rows.length; b += BATCH) {
    const chunk = rows.slice(b, b + BATCH);
    const placeholders = chunk.map((_, idx) => {
      const base = idx * COLS;
      return '(' + Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`).join(',') + ')';
    }).join(',');
    const params = chunk.flatMap(rowToParams);
    await pool.query(
      `INSERT INTO programas
         (ficha, institucion_id, institucion, tipo, area, carrera, sede, region, jornada, duracion, arancel_texto, arancel_valor, search_text, carrera_norm)
       VALUES ${placeholders}
       ON CONFLICT (ficha) DO UPDATE SET
         institucion_id = EXCLUDED.institucion_id, institucion = EXCLUDED.institucion,
         tipo = EXCLUDED.tipo, area = EXCLUDED.area, carrera = EXCLUDED.carrera,
         sede = EXCLUDED.sede, region = EXCLUDED.region, jornada = EXCLUDED.jornada,
         duracion = EXCLUDED.duracion, arancel_texto = EXCLUDED.arancel_texto,
         arancel_valor = EXCLUDED.arancel_valor, search_text = EXCLUDED.search_text,
         carrera_norm = EXCLUDED.carrera_norm`,
      params
    );
  }
  const stats = await getStats();
  console.log('[careers] migración OK:', JSON.stringify(stats));
  return { ...stats, source_rows: rows.length };
}

// Carga automática en arranque si la tabla está vacía (no bloquea el boot).
async function ensureLoaded() {
  try {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM programas`);
    if (rows[0].n > 0) { console.log('[careers] ya cargado:', rows[0].n, 'programas'); return; }
    console.log('[careers] tabla vacía → cargando dataset en segundo plano…');
    const out = await migrate();
    console.log('[careers] carga inicial completa:', JSON.stringify(out));
  } catch (e) { console.error('[careers] ensureLoaded falló:', e.message); }
}

// ---------- consultas ----------
async function getStats() {
  const { rows } = await pool.query(`
    SELECT (SELECT count(*)::int FROM programas)                 AS programas,
           (SELECT count(*)::int FROM instituciones)            AS instituciones,
           (SELECT count(DISTINCT carrera)::int FROM programas) AS carreras,
           (SELECT count(DISTINCT region)::int FROM programas)  AS regiones`);
  return rows[0];
}

async function search({ q, career, tipo, region, area, dependencia, gratuidad, limit } = {}) {
  const params = [];
  const where = [];
  const careerN = norm(career);
  if (careerN) {                 // coincidencia exacta de carrera (al elegir una sugerencia)
    params.push(careerN); where.push(`p.carrera_norm = $${params.length}`);
  } else {
    const qn = norm(q);
    if (qn) { params.push('%' + qn + '%'); where.push(`p.search_text ILIKE $${params.length}`); }
  }
  if (tipo) { params.push(tipo); where.push(`p.tipo = $${params.length}`); }
  if (region) { params.push(region); where.push(`p.region = $${params.length}`); }
  if (area) { params.push(area); where.push(`p.area = $${params.length}`); }
  // Filtros por clasificación de la institución. `dependencia` acepta varias
  // separadas por coma (estatal,g9,privada); `gratuidad=1` restringe a adscritas.
  const deps = String(dependencia || '').split(',').map((d) => d.trim().toLowerCase())
    .filter((d) => ['estatal', 'g9', 'privada'].includes(d));
  if (deps.length) { params.push(deps); where.push(`i.dependencia = ANY($${params.length})`); }
  if (gratuidad === true || gratuidad === '1' || gratuidad === 'true') {
    where.push(`i.gratuidad IS TRUE`);
  }
  const lim = Math.min(Number(limit) || 800, 2000);
  params.push(lim);
  const sql = `
    SELECT p.area, p.carrera, p.institucion, p.tipo, p.sede, p.region, p.jornada,
           p.arancel_texto AS arancel, p.duracion, p.ficha,
           i.dependencia, i.gratuidad
    FROM programas p
    LEFT JOIN instituciones i ON i.id = p.institucion_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.institucion, p.carrera
    LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Carga/actualiza la clasificación de instituciones (dependencia + gratuidad).
async function setClasificacion(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('items requerido');
  let updated = 0, missing = [];
  for (const it of items) {
    const nombre = (it.nombre || '').trim();
    if (!nombre) continue;
    const dep = ['estatal', 'g9', 'privada'].includes(String(it.dependencia || '').toLowerCase())
      ? String(it.dependencia).toLowerCase() : null;
    const { rowCount } = await pool.query(
      `UPDATE instituciones SET dependencia = $2, gratuidad = $3 WHERE nombre = $1`,
      [nombre, dep, it.gratuidad === true]);
    if (rowCount) updated += rowCount; else missing.push(nombre);
  }
  const { rows } = await pool.query(
    `SELECT dependencia, count(*)::int AS n, count(*) FILTER (WHERE gratuidad)::int AS con_gratuidad
     FROM instituciones WHERE tipo = 'Universidad' GROUP BY dependencia ORDER BY dependencia`);
  return { updated, missing, resumen: rows };
}

// Sugerencias de carreras (autocompletado) — agregadas por carrera normalizada.
async function suggest({ q, tipo, region } = {}) {
  const qn = norm(q);
  if (qn.length < 2) return [];
  const params = ['%' + qn + '%'];
  const where = [`carrera_norm ILIKE $1`];
  if (tipo) { params.push(tipo); where.push(`tipo = $${params.length}`); }
  if (region) { params.push(region); where.push(`region = $${params.length}`); }
  params.push(qn); const pExact = '$' + params.length;
  params.push(qn + '%'); const pPrefix = '$' + params.length;
  const sql = `
    SELECT carrera_norm AS key, min(carrera) AS career,
           count(*)::int AS count,
           count(DISTINCT institucion)::int AS institution_count,
           array_agg(DISTINCT tipo) AS types
    FROM programas
    WHERE ${where.join(' AND ')}
    GROUP BY carrera_norm
    ORDER BY CASE WHEN carrera_norm = ${pExact} THEN 0
                  WHEN carrera_norm LIKE ${pPrefix} THEN 1 ELSE 2 END,
             min(carrera)
    LIMIT 8`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => ({
    key: r.key, career: r.career, count: r.count, institutionCount: r.institution_count,
    typeList: ['Universidad', 'IP', 'CFT'].filter((t) => (r.types || []).includes(t)),
  }));
}

// ---------- Contenido editorial dinámico por carrera ----------
// Palabras que no distinguen una carrera de otra (conectores y genéricos): se ignoran
// al comparar, para que "pedagogía básica" calce con "Pedagogía en Educación Básica".
const GENERIC_TOKENS = new Set(['en', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'a',
  'con', 'para', 'carrera', 'licenciatura', 'bachillerato', 'mencion', 'menciones',
  'plan', 'especial', 'educacion']);

// Abreviaturas frecuentes al escribir el nombre de una carrera.
const ABBREV = { ing: 'ingenieria', ingr: 'ingenieria', ped: 'pedagogia', tec: 'tecnico', tns: 'tecnico' };

function keyTokens(s) {
  return norm(s).split(/[^a-z0-9ñ]+/)
    .map((t) => ABBREV[t] || t)
    .filter((t) => t && !GENERIC_TOKENS.has(t));
}

// Cache en memoria: la tabla es pequeña y se consulta en cada búsqueda.
let infoCache = { rows: null, at: 0 };
const INFO_TTL_MS = 60 * 1000;

async function loadInfoRows() {
  const now = Date.now();
  if (infoCache.rows && (now - infoCache.at) < INFO_TTL_MS) return infoCache.rows;
  const { rows } = await pool.query(
    `SELECT carrera_norm, carrera, descripcion, duracion_promedio, area_desempeno FROM carreras_info`);
  infoCache = { rows, at: now };
  return rows;
}

const publicInfo = (r) => ({
  carrera: r.carrera, descripcion: r.descripcion,
  duracion_promedio: r.duracion_promedio, area_desempeno: r.area_desempeno,
});

async function getInfo(career) {
  const cn = norm(career);
  if (!cn) return null;
  const rows = await loadInfoRows();
  if (!rows.length) return null;

  // 1) Coincidencia exacta: siempre gana.
  const exact = rows.find((r) => r.carrera_norm === cn);
  if (exact) return publicInfo(exact);

  // 2) Coincidencia flexible por palabras clave.
  const qt = keyTokens(career);
  if (!qt.length) return null;
  const qset = new Set(qt);
  let best = null, bestScore = 0;
  for (const r of rows) {
    const kset = new Set(keyTokens(r.carrera || r.carrera_norm));
    if (!kset.size) continue;
    const inter = [...kset].filter((t) => qset.has(t)).length;
    if (!inter) continue;
    const union = new Set([...kset, ...qset]).size;
    const jaccard = inter / union;
    const keyCovered = inter === kset.size;   // "Nutrición" ⊂ "nutrición y dietética"
    const queryCovered = inter === qset.size; // "veterinaria" ⊂ "Medicina Veterinaria"
    let score = 0;
    if (keyCovered) score = 0.9 + jaccard * 0.1;
    else if (queryCovered) score = 0.7 + jaccard * 0.1;
    else if (jaccard >= 0.6) score = jaccard;
    else continue;
    score -= Math.abs(kset.size - qset.size) * 0.001; // desempate: nombre más cercano
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best ? publicInfo(best) : null;
}

async function upsertInfo({ career, descripcion, duracion_promedio, area_desempeno } = {}) {
  const cn = norm(career);
  if (!cn) throw new Error('career requerido');
  const { rows } = await pool.query(
    `INSERT INTO carreras_info (carrera_norm, carrera, descripcion, duracion_promedio, area_desempeno, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (carrera_norm) DO UPDATE SET
       carrera = EXCLUDED.carrera, descripcion = EXCLUDED.descripcion,
       duracion_promedio = EXCLUDED.duracion_promedio, area_desempeno = EXCLUDED.area_desempeno,
       updated_at = now()
     RETURNING carrera_norm`,
    [cn, career, descripcion || null, duracion_promedio || null, area_desempeno || null]);
  infoCache = { rows: null, at: 0 }; // el contenido nuevo debe verse de inmediato
  return rows[0];
}

module.exports = { initSchema, migrate, ensureLoaded, getStats, search, suggest, getInfo, upsertInfo, setClasificacion, DATASET_URL };
