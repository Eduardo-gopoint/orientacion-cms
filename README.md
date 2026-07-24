# orientacion-cms

CMS y backend de formularios para **orientacionvocacional.cl** (Node/Express + Supabase + Resend + WhatsApp/Whapi + Google Calendar/Maton).

Web service en Render que centraliza los leads del sitio y su gestión.

## Módulos

- **Formularios** — todos los envíos del sitio quedan en la BBDD (Supabase). Se ven, filtran (web/WhatsApp), buscan y exportan a CSV en `/admin`.
- **WhatsApp** — el click del botón de WhatsApp en la web registra un lead con `source = whatsapp`; webhook de Whapi para mensajes entrantes.
- **Agenda** — cruza el Google Calendar de `contacto@orientacionvocacional.cl` (vía Maton) con los leads para marcar quién se agendó.
- **Usuarios** — login por correo/contraseña (hash bcrypt, sesión JWT en cookie httpOnly). Roles `admin` / `editor`.

## Endpoints

| Método | Ruta                     | Auth   | Descripción                                  |
|--------|--------------------------|--------|----------------------------------------------|
| GET    | `/healthz`               | —      | Estado                                        |
| POST   | `/api/contact`           | —      | Lead desde formulario web                     |
| POST   | `/api/whatsapp`          | —      | Lead desde click del botón de WhatsApp        |
| POST   | `/api/whapi/webhook`     | secret | Mensajes entrantes de Whapi                    |
| POST   | `/api/login` `/api/logout` | —    | Sesión                                        |
| GET    | `/api/me`                | cookie | Usuario actual                                 |
| GET    | `/api/leads`             | cookie | Listado de leads + stats                       |
| GET/POST | `/api/calendar/status\|sync` | cookie | Estado y sincronización de agenda        |
| GET/POST/DELETE | `/api/users`    | admin  | Gestión de usuarios                            |

## Variables de entorno

| Variable | Uso |
|----------|-----|
| `SUPABASE_DATABASE_URL` | Postgres (Supabase) |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_TO` | Envío de correos |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Admin inicial (se crea/actualiza al arrancar) |
| `JWT_SECRET` | Firma de sesión |
| `WHAPI_API_KEY`, `WHAPI_BASE`, `WHAPI_WEBHOOK_SECRET` | Integración Whapi (WhatsApp) |
| `MATON_API_KEY`, `CALENDAR_ID` | Integración Google Calendar vía Maton |
| `SUPABASE_ANON_KEY`, `SUPABASE_ROL_KEY` | Reservadas para futuras integraciones |
