# orientacion-cms

CMS ligero y backend de formularios para **orientacionvocacional.cl**.

Web service en Render (Node/Express) que:

- Recibe los envíos de los formularios del sitio en `POST /api/contact`,
  los guarda en **Supabase** (Postgres) y envía el correo vía **Resend**.
- Expone un panel protegido en `/admin` para ver, buscar y exportar los leads.

## Endpoints

| Método | Ruta            | Descripción                                        |
|--------|-----------------|----------------------------------------------------|
| GET    | `/healthz`      | Estado del servicio                                |
| POST   | `/api/contact`  | Recibe leads del sitio `{name,email,phone,message,hp,source_page}` |
| GET    | `/api/leads`    | Lista de leads (requiere auth básica)              |
| GET    | `/admin`        | Panel de leads (requiere auth básica)              |

## Variables de entorno

| Variable                | Uso                                                        |
|-------------------------|------------------------------------------------------------|
| `SUPABASE_DATABASE_URL` | Conexión Postgres (Supabase) para guardar leads            |
| `RESEND_API_KEY`        | Envío de correos vía Resend                                |
| `MAIL_FROM`             | Remitente (default: contacto@orientacionvocacional.cl)     |
| `MAIL_TO`               | Destinatario de los leads (default: contacto@…)            |
| `ADMIN_TOKEN`           | Contraseña del panel `/admin` (usuario: `admin`)           |
| `SUPABASE_ANON_KEY`     | Reservada para futuras integraciones Supabase              |
| `SUPABASE_ROL_KEY`      | Reservada (service role)                                    |

## Uso desde el sitio

```js
await fetch('https://cms.orientacionvocacional.cl/api/contact', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, email, phone, message, source_page: location.pathname })
});
```

## Local

```bash
npm install
SUPABASE_DATABASE_URL=... RESEND_API_KEY=... ADMIN_TOKEN=... npm start
```
