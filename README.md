# Seguros Venezuela · Pipeline de Ventas

> 📓 **[BITACORA.md](BITACORA.md)** — estado actual, qué falta y las trampas ya
> diagnosticadas. Leerlo antes de retomar el trabajo.

Dashboard tipo **embudo de ventas / pipeline** con todos los tickets de **Zoho Desk**
(departamento *Administración de Pólizas*), sincronizados a **Supabase** y
visualizados en una web con **actualización automática**.

```
Zoho Desk  ──(sync)──▶  Supabase (Postgres + RLS + Realtime)  ──▶  Dashboard web
                ▲                                                      (login)
                └── GitHub Actions (cada 5 min)  /  Edge Function (webhook instantáneo)
```

## Componentes

| Carpeta | Qué es |
|---|---|
| `db/schema.sql` | Tablas, vistas agregadas (embudo, KPIs, tendencia), índices y **RLS**. |
| `sync/` | Script Node (sin dependencias) que trae los tickets de Zoho y hace *upsert* en Supabase. |
| `dashboard/` | Web estática (HTML/CSS/JS + Supabase JS). Embudo, kanban, KPIs, tendencia y tabla. |
| `supabase/functions/zoho-sync/` | Edge Function para actualización **instantánea** vía webhook de Zoho. |
| `.github/workflows/` | `sync.yml` (cron de sincronización) y `pages.yml` (publica el dashboard). |
| `docs/auto-actualizacion.md` | Las 3 formas de mantener el dashboard al día y cuál usar. |

## El dashboard muestra

- **KPIs**: total de tickets, pipeline activo (conteo + prima), ganados, perdidos, conversión, nuevos 7 días.
- **Embudo por etapa** con prima estimada y % de conversión entre etapas.
- **Pipeline kanban**: oportunidades abiertas por etapa (tarjetas por ticket).
- **Análisis**: por canal, por asesor/agente, por plan (HCM) y tendencia diaria (90 días).
- **Tabla** de todos los tickets con búsqueda y filtros (etapa, canal), paginada.
- **Tiempo real**: cuando entra o cambia un ticket, el tablero se refresca solo y muestra un aviso.

## Datos y volumen

- ~**12.900 tickets** (histórico desde 2025-07-10).
- Etapas del embudo: `Cotización enviada → Pendiente por recaudos → Respuesta Recaudos → En análisis → En proceso → Emitida/Cerrado (ganado) → Anulada/Rechazada (perdido)`.
- Campos de negocio (`customFields`): monto de prima, plan HCM, asesor, titular, edad, etc.

## Seguridad

Los tickets contienen **datos personales** (nombres, cédulas, teléfonos, montos).
Por eso:

- **RLS activo**: la tabla `tickets` y las vistas **solo** son legibles con una sesión **autenticada**.
- La clave `anon` (que va en el frontend) **no** puede leer datos por sí sola.
- El dashboard exige **login** (Supabase Auth, email + contraseña).
- Las escrituras las hace el proceso de sync con la `service_role key` (nunca en el frontend).

### Acceso al dashboard

- **Usuario:** `pipeline@segurosvenezuela.com`
- **Contraseña:** se entrega aparte (cámbiala en Supabase → Authentication → Users).

## Puesta en marcha (ya realizada)

1. Esquema aplicado en Supabase (`db/schema.sql`).
2. Carga inicial: `cd sync && node --env-file=.env sync.mjs full` y luego `enrich`.
3. Secrets configurados en GitHub Actions.
4. Dashboard publicado en GitHub Pages.

## Uso del sync (manual)

```bash
cd sync
cp ../.env.example .env      # y completar credenciales
node --env-file=.env sync.mjs full         # carga completa (núcleo)
node --env-file=.env sync.mjs enrich open  # rellena montos/plan del pipeline activo
node --env-file=.env sync.mjs incremental  # solo lo modificado desde el último sync
```

## Kommo CRM (leads)

Cada ticket nuevo de Zoho se crea como **lead** en Kommo, en la misma corrida del
sync incremental.

| Destino | Valor |
|---|---|
| Cuenta | `segurosvenezuelait.kommo.com` (id 36827351) |
| Embudo | **VENTAS** (`14251835`) |
| Etapa | **cliente por atender** (`110051287`) |
| Etiqueta | `ZohoDesk` |

El embudo y la etapa se resuelven **por nombre** en cada corrida, así que
renombrar o reordenar etapas en Kommo no rompe nada (se pueden forzar con
`KOMMO_PIPELINE_ID` / `KOMMO_STATUS_ID`).

Cada lead lleva el contacto del ticket (Kommo fusiona si ya existe) y una **nota**
con número de ticket, etapa en Zoho, canal, asesor, plan y enlace directo al
ticket.

### Corte e idempotencia

- `sync_state.kommo_since` es el **corte**: no se envían tickets creados antes.
  Actualmente **2026-08-01** — el histórico previo (~12.250 tickets) no se migra.
- `tickets.kommo_lead_id` guarda el lead creado. Un ticket con lead **nunca** se
  reenvía, así que el sync puede correr las veces que sea sin duplicar.
- Estado y auditoría: vista `kommo_sync_status`.

### Control de duplicados

Zoho abre **varios tickets para la misma solicitud**, y sin control cada uno
generaba un lead. Antes de crear nada se aplican dos filtros (`db/dedup.sql`):

1. **Contra lo ya creado** — `tickets_ya_en_kommo()`: si un ticket equivalente
   ya tiene lead, el nuevo se *vincula* a ese lead en vez de crear otro.
2. **Dentro del mismo lote** — si dos tickets nuevos son equivalentes, solo uno
   crea el lead y el resto lo heredan.

La clave de deduplicación es `asunto + contacto + titular`
(`ticket_dedup_key()`). **El titular es imprescindible**: hay asuntos con cédula
placeholder (`V-00000000`) que se repiten entre personas distintas, y agrupar
solo por asunto + contacto fusionaba clientes que no son la misma persona.

Auditoría: la vista `kommo_duplicados` lista los grupos que generaron más de un
lead. **Debe estar vacía.**

### Limpieza (`limpiar-kommo.mjs`)

```bash
node --env-file=.env limpiar-kommo.mjs --dry-run   # informa, no toca nada
node --env-file=.env limpiar-kommo.mjs            # aplica
```

Etiqueta los leads sobrantes como `duplicado`, reapunta sus tickets al lead que
se conserva, normaliza los teléfonos a `+58` y añade `MetaAds` a los leads que
entraron por ambas fuentes.

> ⚠️ **La API de Kommo no permite borrar leads** (`Allow: GET, PATCH` en
> `/api/v4/leads`). El borrado final es manual: filtrar por la etiqueta
> `duplicado` en la interfaz y eliminar. El script deja ese trabajo listo.

```bash
cd sync
node --env-file=.env sync.mjs kommo-init 2026-08-01T00:00:00Z  # fija el corte
node --env-file=.env sync.mjs kommo --dry-run                  # ver payloads, no escribe
node --env-file=.env sync.mjs kommo --limit=1000               # crear leads pendientes
```

Aplicar una vez `db/kommo.sql` (columnas de control + vista). Secrets nuevos:
`KOMMO_SUBDOMAIN`, `KOMMO_LONG_LIVED_TOKEN`.

> El token de larga duración vence el **2027-10-30**. Hay que renovarlo antes.

## Leads de Meta (Instagram/Facebook)

Segunda fuente del pipeline. Marketing recibe los formularios de Meta en una
hoja de Google; el sync la replica en Supabase y crea los leads en Kommo.

```
Meta Lead Ads ──▶ Hoja de Google ──(sync)──▶ Supabase (meta_leads) ──▶ Kommo
```

| | |
|---|---|
| Hoja | `1jUy4z0CPGV3DkF28goP8rqxL9qUZSJPMh3H6MwwPhiE` (dueña: `alessandra.publithink@gmail.com`) |
| Tabla | `public.meta_leads` — **RLS activo**, contiene datos personales |
| Destino | embudo **VENTAS** / etapa **cliente por atender** / etiqueta `MetaAds` |
| Corte | `sync_state.meta_since` = **2026-08-01** |

- Se descarga por el endpoint de exportación a CSV, **sin credenciales**, porque
  la hoja está compartida por enlace. Si se cierra el acceso público, hay que
  compartirla con una cuenta de servicio y apuntar `META_SHEET_CSV_URL`.
- El `id` de Meta (`l:...`) es la clave: garantiza que un lead no se cree dos veces.
- **Anti-duplicado cruzado**: si la persona ya está en Kommo por un ticket de
  Zoho (mismo correo, o mismos últimos 10 dígitos del teléfono), no se crea un
  segundo lead — el registro se vincula al lead existente. Ver la función
  `meta_leads_solapados()`.
- Los teléfonos vienen con prefijo `p:` y en formatos mezclados; se normalizan a
  `+58…` y el original queda en `telefono_raw`.
- La nota del lead lleva la atribución completa: campaña, conjunto, anuncio,
  formulario, plataforma y edad.

```bash
cd sync
node --env-file=.env sync.mjs meta-init 2026-08-01T00:00:00Z  # fija el corte
node --env-file=.env sync.mjs meta --dry-run                  # no escribe
node --env-file=.env sync.mjs meta --limit=1000               # replica + crea
```

Aplicar una vez `db/meta_leads.sql`. Estado: vista `meta_sync_status`.

> ⚠️ La hoja tiene permiso `anyone: commenter`: **cualquiera con el enlace** lee
> nombre, fecha de nacimiento, teléfono y correo de más de mil personas. Conviene
> restringirla y pasar a cuenta de servicio.

## Auto-actualización

Ver [`docs/auto-actualizacion.md`](docs/auto-actualizacion.md). Resumen:

- ✅ **GitHub Actions** (`sync.yml`) corre `incremental` **cada 5 minutos** — activo y sin depender de accesos extra.
- ⚡ **Edge Function + webhook de Zoho** — actualización **instantánea** (requiere que el equipo de Zoho configure el webhook).
- 🕒 **pg_cron dentro de Supabase** — alternativa 100% Supabase que invoca la Edge Function.
