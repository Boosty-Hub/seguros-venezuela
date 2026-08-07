# Seguros Venezuela · Pipeline de Ventas

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

## Auto-actualización

Ver [`docs/auto-actualizacion.md`](docs/auto-actualizacion.md). Resumen:

- ✅ **GitHub Actions** (`sync.yml`) corre `incremental` **cada 5 minutos** — activo y sin depender de accesos extra.
- ⚡ **Edge Function + webhook de Zoho** — actualización **instantánea** (requiere que el equipo de Zoho configure el webhook).
- 🕒 **pg_cron dentro de Supabase** — alternativa 100% Supabase que invoca la Edge Function.
