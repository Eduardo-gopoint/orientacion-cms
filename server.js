'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const db = require('./db');
const auth = require('./auth');
const { sendLeadEmail } = require('./mailer');
const calendar = require('./calendar');
const whapi = require('./whapi');
const careers = require('./careers');

const app = express();
const PORT = process.env.PORT || 10000;

const ALLOWED_ORIGINS = [
  'https://orientacionvocacional.cl',
  'https://www.orientacionvocacional.cl',
  'https://orientacion-mirror.onrender.com',
];

app.set('trust proxy', 1);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cookieParser());

const clientIp = (req) => (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

// ==================== Salud ====================
app.get('/healthz', (req, res) => res.json({
  ok: true,
  service: 'orientacion-cms',
  whapi: whapi.isConfigured(),
  calendar: calendar.isConfigured(),
}));

// ==================== Formularios web (público) ====================
app.post('/api/contact', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.hp) return res.json({ ok: true }); // honeypot

    const name = (b.name || '').toString().trim();
    const email = (b.email || '').toString().trim();
    const message = (b.message || '').toString().trim();
    const phone = (b.phone || '').toString().trim();
    const source_page = (b.source_page || '').toString().trim().slice(0, 500);

    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Nombre y email válido son obligatorios.' });
    }

    const lead = { name, email, phone, message, source: 'web', source_page,
      ip: clientIp(req), user_agent: (req.headers['user-agent'] || '').toString().slice(0, 400) };

    let saved = null;
    try { saved = await db.insertLead({ ...lead, emailed: false }); }
    catch (e) { console.error('[contact] DB:', e.message); }

    const mail = await sendLeadEmail(lead);
    if (mail.ok && saved) db.markEmailed(saved.id).catch(() => {});
    if (!mail.ok) console.error('[contact] mail:', mail.error);

    if (!saved && !mail.ok) return res.status(500).json({ ok: false, error: 'No se pudo procesar el mensaje.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[contact]', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

// ==================== WhatsApp (público) ====================
// Click del botón de WhatsApp en la web → registra lead fuente whatsapp.
app.post('/api/whatsapp', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.hp) return res.json({ ok: true });
    const saved = await whapi.registerWhatsappLead({
      name: (b.name || '').toString().trim(),
      phone: (b.phone || '').toString().trim(),
      email: (b.email || '').toString().trim(),
      message: (b.message || 'Click en botón de WhatsApp').toString().slice(0, 1000),
      source_page: (b.source_page || '').toString().trim().slice(0, 500),
      raw: { ip: clientIp(req), ua: (req.headers['user-agent'] || '').slice(0, 300) },
    });
    return res.json({ ok: true, id: saved && saved.id });
  } catch (err) {
    console.error('[whatsapp]', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

// Webhook de Whapi (mensajes entrantes de WhatsApp).
app.post('/api/whapi/webhook', async (req, res) => {
  try {
    if (!whapi.verifyWebhook(req)) return res.status(401).json({ ok: false });
    const out = await whapi.handleWebhook(req.body || {});
    return res.json(out);
  } catch (err) {
    console.error('[whapi webhook]', err.message);
    return res.status(200).json({ ok: false }); // 200 para que Whapi no reintente en loop
  }
});

// ==================== Buscador de carreras (público, lectura) ====================
// Reemplaza el dataset de ~2,5 MB incrustado en la página del buscador: el sitio
// consulta esta API y recibe solo los resultados filtrados.
// Datos públicos de referencia: se sirven con CORS abierto (solo lectura, sin credenciales).
const publicRead = (res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
};

app.get('/api/carreras', async (req, res) => {
  publicRead(res);
  try {
    const rows = await careers.search({
      q: req.query.q, career: req.query.career, tipo: req.query.tipo,
      region: req.query.region, area: req.query.area, limit: req.query.limit,
      dependencia: req.query.dependencia, gratuidad: req.query.gratuidad,
    });
    res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    console.error('[carreras]', err.message);
    res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

app.get('/api/carreras/suggest', async (req, res) => {
  publicRead(res);
  try {
    const items = await careers.suggest({ q: req.query.q, tipo: req.query.tipo, region: req.query.region });
    res.json({ ok: true, items });
  } catch (err) {
    console.error('[carreras/suggest]', err.message);
    res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

app.get('/api/carreras/stats', async (req, res) => {
  publicRead(res);
  try { res.json({ ok: true, stats: await careers.getStats() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Contenido editorial dinámico por carrera ("Beneficios de estudiar…").
app.get('/api/carreras/info', async (req, res) => {
  publicRead(res);
  try { res.json({ ok: true, info: await careers.getInfo(req.query.career) }); }
  catch (err) { console.error('[carreras/info]', err.message); res.status(500).json({ ok: false, error: 'Error interno.' }); }
});

// Carga de la clasificación de instituciones (estatal/G9/privada + gratuidad).
app.post('/api/admin/instituciones-clasificacion', async (req, res) => {
  const token = req.get('x-migrate-token') || (req.query && req.query.token) || '';
  const expected = process.env.MIGRATE_TOKEN || '';
  if (!expected || token !== expected) return res.status(401).json({ ok: false, error: 'Token inválido.' });
  try { res.json({ ok: true, ...(await careers.setClasificacion((req.body || {}).items)) }); }
  catch (err) { console.error('[clasificacion]', err.message); res.status(500).json({ ok: false, error: err.message }); }
});

// Escritura del contenido editorial (protegida por token, para redactar/actualizar).
app.post('/api/admin/carreras-info', async (req, res) => {
  const token = req.get('x-migrate-token') || (req.query && req.query.token) || '';
  const expected = process.env.MIGRATE_TOKEN || '';
  if (!expected || token !== expected) return res.status(401).json({ ok: false, error: 'Token inválido.' });
  try { res.json({ ok: true, ...(await careers.upsertInfo(req.body || {})) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Migración/recarga del dataset → Supabase. Protegida por token (header x-migrate-token
// o ?token=), independiente del login admin para poder ejecutarla en despliegue.
app.post('/api/admin/migrate-careers', async (req, res) => {
  const token = req.get('x-migrate-token') || (req.query && req.query.token) || '';
  const expected = process.env.MIGRATE_TOKEN || '';
  if (!expected || token !== expected) return res.status(401).json({ ok: false, error: 'Token inválido.' });
  try {
    const out = await careers.migrate();
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[migrate-careers]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== Auth ====================
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Faltan credenciales.' });
    const user = await auth.verifyLogin(email, password);
    if (!user) return res.status(401).json({ ok: false, error: 'Correo o contraseña incorrectos.' });
    const token = auth.issueToken(user);
    auth.setSessionCookie(res, token);
    return res.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error('[login]', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

app.post('/api/logout', (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });

app.get('/api/me', auth.requireAuth(), (req, res) =>
  res.json({ ok: true, user: { email: req.user.email, name: req.user.name, role: req.user.role } }));

// ==================== API protegida: Formularios ====================
app.get('/api/leads', auth.requireAuth(), async (req, res) => {
  try {
    const rows = await db.listLeads({ limit: req.query.limit, source: req.query.source });
    const stats = await db.leadsStats();
    res.json({ ok: true, leads: rows, stats });
  } catch (err) {
    console.error('[leads]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== API protegida: Agenda (Google Calendar / Maton) ====================
app.get('/api/calendar/status', auth.requireAuth(), (req, res) =>
  res.json({ ok: true, configured: calendar.isConfigured(), calendarId: calendar.CALENDAR_ID }));

app.post('/api/calendar/sync', auth.requireAuth(), async (req, res) => {
  const out = await calendar.syncScheduled(req.body || {});
  res.status(out.ok ? 200 : 400).json(out);
});

// ==================== API protegida: Usuarios (solo admin) ====================
app.get('/api/users', auth.requireAuth(), auth.requireRole('admin'), async (req, res) => {
  try { res.json({ ok: true, users: await db.listUsers() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/users', auth.requireAuth(), auth.requireRole('admin'), async (req, res) => {
  try {
    const { email, name, role, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email y contraseña obligatorios.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Email inválido.' });
    const password_hash = await auth.hashPassword(password);
    const user = await db.upsertUser({ email, name, role: role === 'admin' ? 'admin' : 'editor', password_hash });
    res.json({ ok: true, user });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/users/:id/active', auth.requireAuth(), auth.requireRole('admin'), async (req, res) => {
  try { await db.setUserActive(req.params.id, !!(req.body && req.body.active)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/users/:id', auth.requireAuth(), auth.requireRole('admin'), async (req, res) => {
  try { await db.deleteUser(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ==================== Páginas ====================
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get(['/admin', '/admin/'], auth.requireAuth({ html: true }), (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Arranque ====================
async function start() {
  try {
    await db.init();
    await careers.initSchema();
    await auth.seedAdmin();
  } catch (e) {
    console.error('[start] init/seed falló (el servicio sigue arriba):', e.message);
  }
  app.listen(PORT, () => {
    console.log(`[orientacion-cms] escuchando en :${PORT}`);
    // Carga inicial del dataset del buscador si la tabla está vacía (no bloquea el arranque).
    careers.ensureLoaded();
  });
}

start();
