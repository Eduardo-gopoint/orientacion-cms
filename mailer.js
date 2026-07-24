'use strict';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'Orientación Vocacional <contacto@orientacionvocacional.cl>';
const MAIL_TO = process.env.MAIL_TO || 'contacto@orientacionvocacional.cl';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Envía el correo del lead vía la API HTTP de Resend. Devuelve {ok, id?, error?}.
async function sendLeadEmail(lead) {
  if (!RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY no configurada' };
  }

  const subject = `Nuevo contacto desde el sitio — ${lead.name || 'sin nombre'}`;
  const html = `
    <h2>Nuevo mensaje desde orientacionvocacional.cl</h2>
    <p><strong>Nombre:</strong> ${esc(lead.name)}</p>
    <p><strong>Email:</strong> ${esc(lead.email)}</p>
    <p><strong>Teléfono:</strong> ${esc(lead.phone) || '—'}</p>
    <p><strong>Mensaje:</strong><br>${esc(lead.message).replace(/\n/g, '<br>') || '—'}</p>
    <hr>
    <p style="color:#888;font-size:12px">Página: ${esc(lead.source_page) || '—'}<br>
    Recibido: ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}</p>
  `;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [MAIL_TO],
        reply_to: lead.email,
        subject,
        html,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, error: data && data.message ? data.message : `HTTP ${resp.status}` };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendLeadEmail, MAIL_FROM, MAIL_TO };
