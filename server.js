'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { sendLeadEmail } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Orígenes permitidos para los formularios del sitio.
const ALLOWED_ORIGINS = [
  'https://orientacionvocacional.cl',
  'https://www.orientacionvocacional.cl',
  'https://orientacion-mirror.onrender.com',
];

app.set('trust proxy', 1);
app.use(cors({
  origin: (origin, cb) => {
    // Permite requests sin origin (curl, health checks) y los del sitio.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

// ---------- Salud ----------
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'orientacion-cms' }));

// ---------- Endpoint de contacto (formularios del sitio) ----------
app.post('/api/contact', async (req, res) => {
  try {
    const b = req.body || {};
    // Honeypot: si viene relleno, es bot → responde ok sin hacer nada.
    if (b.hp) return res.json({ ok: true });

    const name = (b.name || '').toString().trim();
    const email = (b.email || '').toString().trim();
    const message = (b.message || '').toString().trim();
    const phone = (b.phone || '').toString().trim();
    const source_page = (b.source_page || '').toString().trim().slice(0, 500);

    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Nombre y email válido son obligatorios.' });
    }

    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const user_agent = (req.headers['user-agent'] || '').toString().slice(0, 400);

    const lead = { name, email, phone, message, source_page, ip, user_agent };

    let saved = null;
    try {
      saved = await db.insertLead({ ...lead, emailed: false });
    } catch (e) {
      console.error('[contact] error guardando en DB:', e.message);
    }

    const mail = await sendLeadEmail(lead);
    if (mail.ok && saved) {
      db.markEmailed(saved.id).catch(() => {});
    }
    if (!mail.ok) {
      console.error('[contact] error enviando correo:', mail.error);
    }

    // El lead quedó guardado y/o enviado. Si ambos fallan, error.
    if (!saved && !mail.ok) {
      return res.status(500).json({ ok: false, error: 'No se pudo procesar el mensaje.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[contact] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

// ---------- Auth básica para el panel/admin ----------
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN no configurado.' });
  }
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Basic ')) {
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    const pass = decoded.split(':').slice(1).join(':');
    if (pass === ADMIN_TOKEN) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Orientacion CMS"');
  return res.status(401).json({ ok: false, error: 'No autorizado.' });
}

// ---------- API del CMS (leads) ----------
app.get('/api/leads', requireAdmin, async (req, res) => {
  try {
    const rows = await db.listLeads(req.query.limit);
    res.json({ ok: true, leads: rows });
  } catch (err) {
    console.error('[leads] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Panel admin (HTML estático protegido) ----------
app.use('/admin', requireAdmin, express.static(path.join(__dirname, 'public', 'admin')));
app.get('/admin', requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'))
);

// ---------- Home del CMS ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

async function start() {
  try {
    await db.init();
  } catch (e) {
    console.error('[start] no se pudo inicializar la DB (el servicio sigue arriba):', e.message);
  }
  app.listen(PORT, () => console.log(`[orientacion-cms] escuchando en :${PORT}`));
}

start();
