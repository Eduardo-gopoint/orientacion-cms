'use strict';
const db = require('./db');

// Integración con el Google Calendar de contacto@orientacionvocacional.cl vía el
// gateway de Maton (patrón https://gateway.maton.ai/{app}/{ruta}, Bearer key).
// Requiere en Render: MATON_API_KEY y (opcional) CALENDAR_ID.
const MATON_API_KEY = process.env.MATON_API_KEY || process.env.MATON_EDUARDO_API_KEY || '';
const CALENDAR_ID = process.env.CALENDAR_ID || 'contacto@orientacionvocacional.cl';
const GATEWAY = process.env.MATON_GATEWAY || 'https://gateway.maton.ai';
// App/ruta del gateway para Google Calendar (ajustable si Maton usa otro slug).
const CAL_APP = process.env.MATON_CALENDAR_APP || 'google-calendar';

function isConfigured() {
  return !!MATON_API_KEY;
}

async function listEvents({ daysBack = 30, daysFwd = 90 } = {}) {
  const timeMin = new Date(Date.now() - daysBack * 864e5).toISOString();
  const timeMax = new Date(Date.now() + daysFwd * 864e5).toISOString();
  const url = `${GATEWAY}/${CAL_APP}/calendars/${encodeURIComponent(CALENDAR_ID)}/events`
    + `?singleEvents=true&orderBy=startTime&maxResults=250`
    + `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${MATON_API_KEY}`, 'Accept': 'application/json' },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${resp.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
}

// Extrae correos de un evento (organizer/attendees/descripción).
function emailsFromEvent(ev) {
  const set = new Set();
  if (ev.creator && ev.creator.email) set.add(ev.creator.email.toLowerCase());
  (ev.attendees || []).forEach((a) => { if (a.email) set.add(a.email.toLowerCase()); });
  const blob = `${ev.description || ''} ${ev.summary || ''}`;
  (blob.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).forEach((e) => set.add(e.toLowerCase()));
  return [...set].filter((e) => !e.endsWith('@orientacionvocacional.cl'));
}

// Cruza los eventos del calendario con los leads y marca los que se agendaron.
async function syncScheduled(opts = {}) {
  if (!isConfigured()) return { ok: false, error: 'MATON_API_KEY no configurada.' };
  let events;
  try { events = await listEvents(opts); }
  catch (e) { return { ok: false, error: e.message }; }

  let matched = 0, scanned = 0;
  for (const ev of events) {
    scanned++;
    const start = (ev.start && (ev.start.dateTime || ev.start.date)) || null;
    const emails = emailsFromEvent(ev);
    for (const email of emails) {
      const lead = await db.findLeadByEmail(email);
      if (lead && !lead.scheduled) {
        await db.markScheduled(lead.id, start, ev.id || ev.htmlLink || null);
        matched++;
      }
    }
  }
  return { ok: true, scanned, matched };
}

module.exports = { isConfigured, listEvents, syncScheduled, CALENDAR_ID };
