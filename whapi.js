'use strict';
const db = require('./db');

// Integración con Whapi (WhatsApp). Se completa cuando Eduardo entregue la API key.
// Requiere en Render: WHAPI_API_KEY (y opcional WHAPI_BASE, WHAPI_WEBHOOK_SECRET).
const WHAPI_API_KEY = process.env.WHAPI_API_KEY || '';
const WHAPI_BASE = process.env.WHAPI_BASE || 'https://gate.whapi.cloud';
const WEBHOOK_SECRET = process.env.WHAPI_WEBHOOK_SECRET || '';

function isConfigured() { return !!WHAPI_API_KEY; }

function normalizePhone(p) {
  return String(p || '').replace(/[^\d+]/g, '');
}

// Registra un lead de origen WhatsApp (usado por el click del botón y por el webhook).
async function registerWhatsappLead({ name, phone, email, message, source_page, raw }) {
  return db.insertLead({
    name: name || '',
    email: email || '',
    phone: normalizePhone(phone),
    message: message || null,
    source: 'whatsapp',
    source_page: source_page || null,
    emailed: false,
    raw: raw || null,
  });
}

// Procesa el payload de webhook de Whapi (mensajes entrantes → leads).
async function handleWebhook(body) {
  const messages = (body && (body.messages || body.message || [])) || [];
  const arr = Array.isArray(messages) ? messages : [messages];
  let created = 0;
  for (const m of arr) {
    if (!m || m.from_me) continue;
    const phone = m.from || (m.chat_id ? String(m.chat_id).split('@')[0] : '');
    const name = (m.from_name) || (m.contact && m.contact.name) || '';
    const text = (m.text && (m.text.body || m.text)) || m.body || '';
    if (!phone) continue;
    await registerWhatsappLead({ name, phone, message: text, source_page: 'whatsapp', raw: m });
    created++;
  }
  return { ok: true, created };
}

// Verifica el secreto del webhook (si está configurado).
function verifyWebhook(req) {
  if (!WEBHOOK_SECRET) return true;
  const got = req.query.secret || req.headers['x-webhook-secret'];
  return got === WEBHOOK_SECRET;
}

module.exports = { isConfigured, registerWhatsappLead, handleWebhook, verifyWebhook, WHAPI_BASE };
