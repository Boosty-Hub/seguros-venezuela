# Bitácora del proyecto

Registro de qué se hizo, dónde quedó y qué falta. **Leer esto primero** al
retomar el trabajo.

> **Regla para actualizar esta bitácora** (aplica a cualquier sesión, humana o
> agente): antes de escribir, **leer el archivo completo**. Al actualizar,
> **fusionar** la info nueva con lo existente — nunca agregar una sección
> nueva que repita o contradiga una vieja. Si un dato cambió, **reemplazar**
> el valor viejo, no dejar los dos. Mantener todo **conciso**: esto ya lleva
> varias sesiones: cuanto más larga, menos se lee. Estado puntual (cifras,
> IDs) va arriba en "Estado actual"; lo demás (trampas, comandos, arquitectura)
> no se repite salvo que cambie de verdad.

- **Repo:** `Boosty-Hub/seguros-venezuela` (público), rama `main`
- **Supabase:** proyecto `lwqqnnefywsjaatuyjma` · `seguros venezuela Project`
- **Kommo:** `segurosvenezuelait.kommo.com` (cuenta 36827351)
- **Dashboard del agente de IA:** https://segurosvenezuela.netlify.app (Next.js,
  Netlify, sitio `segurosvenezuela`, deploy automático desde `main`; también
  corre local con `pnpm dev` en `web/`)
- **Dashboard del pipeline Zoho:** vive dentro del dashboard del agente, en
  `/pipeline` (GitHub Pages del repo se dio de baja el 2026-08-15)

---

## Estado actual (al 2026-08-19)

**Pipeline Zoho → Kommo:** funcionando, automatizado por GitHub Actions
(`sync.yml`, `node sync.mjs incremental`, ~cada hora real aunque el cron dice
`*/5`). Para cifras vivas: `select * from public.estado_general` en Supabase
SQL Editor (no copiar números acá, quedan viejos).

**Agente de IA "Asesora Sofi" (Kommo, WhatsApp/Instagram):** ✅ **activo end
to end**, verificado con mensajes reales el 2026-08-19:
- Managed Agent + 2 Memory Stores creados en Anthropic (`agent_013cULz...`,
  `sv-master`, `sv-leads`) — el bloqueo de crédito de la sesión anterior se
  resolvió, ya hay saldo.
- Clasificador (Haiku 4.5, con contexto de conversación previa vía
  `fetchLeadHistory`) → agente de respuesta (Haiku 4.5, sesión CMA con
  `search_kb`) probados de punta a punta con mensajes sintéticos: clasifica
  bien, responde en tuteo venezolano, usa la KB.
- **Sigue en modo sombra**: `publishing_enabled=false` — nada se envía a un
  cliente real todavía, los drafts quedan en `/inbox` para revisar. Falta
  decidir el criterio de salida de este modo.
- **Sin revisión humana bloqueando nada** (a propósito, para poder chequear
  cómo responde el agente a TODO mientras está en sombra): `bypass_review=true`
  y las 11 verticales con `requires_review=false`/`auto_reply=true`. Se
  descubrió y arregló una invariante rota: `bypass_review` ya NO depende de
  `publishing_enabled` (antes solo tenía efecto si publicación estaba
  encendida) — son dos interruptores independientes: bypass decide si la
  revisión bloquea la GENERACIÓN, publishing decide si sale de verdad a
  Kommo. Ver `/api/agent/publish`.
- **Emoji seguros para Kommo/WhatsApp**: los simples de un símbolo (👋 👍 ❤️)
  pasan bien; las secuencias compuestas (ZWJ, tono de piel, banderas) se
  rompen. Dos capas: regla en el prompt + saneador de código en
  `generate-response` (`sanitizeEmojiForKommo`) que las limpia siempre, pase
  lo que pase el modelo.
- **Tope de consumo diario/mensual** (`/consumo`, panel "Tope de consumo"):
  configurable en USD (`runtime_config.USAGE_DAILY_CAP_USD` /
  `USAGE_MONTHLY_CAP_USD`, vacío = sin tope). `alerts-scan` (cada 5 min) lo
  revisa; si se supera, apaga `kommo_publish_config.agent_enabled=false` — el
  agente para POR COMPLETO (ni clasifica, ver trampa #10) — y crea una alerta
  crítica. No se reactiva solo: un humano debe prenderlo de nuevo. Probado en
  vivo con un tope artificial de $0.01.
- **Torre de control**: campana 🔔 en el header (sidebar desktop, header
  mobile, embed) que abre un panel deslizable desde la derecha
  (`control-tower.tsx` + `/api/control-tower`) con alertas activas, estado
  del agente, consumo vs. tope y revisiones pendientes, todo con botones para
  actuar sin salir del panel (reactivar agente, marcar alertas vistas). La
  página `/alerts` sigue existiendo para el historial completo.
- **KB ahora es por vertical** (antes era global): cada documento subido
  tiene `vertical_id` obligatorio (`kb_documents.vertical_id NOT NULL`);
  `search_kb` solo trae resultados de la vertical activa. Se sube desde
  `/verticales`, entrando a cada vertical. Sin documentos reales cargados
  todavía (pendiente).
- **Módulo "Contenido" (voz + KB general) eliminado.** La voz/identidad vive
  entera en el system prompt (`/agent`, pestaña Identidad); ya no existe el
  concepto de "documento de KB sin vertical" (el agente siempre responde
  dentro de una vertical).
- **Dashboard unificado**: Agente + Kommo + Herramientas + Seguimiento +
  Ajustes son ahora pestañas de una sola página (`/agent`, "Configuración").
  Usuarios sigue aparte. Auditado sin duplicación de funciones entre pestañas
  (cada campo se edita en un solo lugar).
- **Dreams** (aprendizajes automáticos): cron dinámico — el intervalo real
  del cron (`dreams-run`) cambia con el dropdown de `/dreams` (daily/3d/7d/
  15d), ya no hay due-check interno. Un cron aparte, mensual
  (`dreams-consolidate-monthly`), relee todos los dreams activos y los
  consolida en un digest único (`runtime_config.DREAMS_DIGEST`, acotado a 900
  palabras) — eso es lo que el agente realmente lee, no los archivos sueltos.
  Modelo de Dreams: Haiku (antes Sonnet).
- **System prompt real vs editable**: lo editable en `/agent` es solo la voz
  del operador; Anthropic tiene ADEMÁS una maquinaria fija (formato de
  respuesta, prioridades, seguridad) que se ve de solo lectura en el mismo
  `/agent` ("Ver el system prompt completo"), leída en vivo de Anthropic. Esa
  maquinaria vive en un único archivo (`web/src/lib/agent-prompt-core.mjs`),
  compartido entre el dashboard y `scripts/provision-agent.mjs` (antes había
  una copia duplicada en el script; ya no).

## PENDIENTE

**Pipeline Zoho/Kommo:**
1. Borrar a mano en la interfaz de Kommo los 172 leads etiquetados
   `duplicado` (la API no permite `DELETE /leads`, ver trampa #2).
2. Restringir la hoja de Google de Meta Ads (hoy `anyone: commenter`, expone
   PII) — pedir a `alessandra.publithink@gmail.com` compartirla con cuenta de
   servicio y apuntar `META_SHEET_CSV_URL`.
3. Decidir si el contacto del lead debe ser el asesor (hoy) o el asegurado
   (`titular`).
4. Decidir qué hacer con los 205 leads `revisar-asesor` (filtrar por etiqueta
   en Kommo, borrar o destaggear a mano).
5. Leer todas las pestañas de la hoja de Drive (hoy solo la primera).

**Agente de IA:**
6. Cargar documentos reales de KB en cada vertical (tarifarios, condiciones,
   FAQs de las aseguradoras) — hoy no hay ninguno.
7. Probar el pipeline completo con mensajes reales de clientes en `/inbox`
   antes de decidir salir de modo sombra.
8. Decidir criterio de salida de modo sombra y activar `publishing_enabled`.
9. La próxima vez que se edite el prompt en `/agent` y se guarde, el system
   prompt en Anthropic se resincroniza solo (recoge la limpieza del scaffold
   de esta sesión) — no requiere acción aparte.
10. Definir topes de consumo reales en `/consumo` (hoy sin tope puesto —
    quedó probado y limpiado tras la prueba en vivo).

### Vencimientos

- **Token de Kommo: 2027-10-30.** Ese día deja de crearse cualquier lead.
- Refresh token de Zoho: sin caducidad conocida, pero se puede revocar.

---

## Cómo saber el estado ahora mismo

```sql
select * from public.estado_general;      -- foto completa: totales, cortes, fallos 24h
select * from public.bitacora_reciente;   -- una fila por corrida del sync
```

`sync_log` graba **cada ejecución** (local o GitHub Actions); no depende de
los logs de Actions (caducan a los 90 días).

Otras vistas: `kommo_sync_status` (Zoho→Kommo), `meta_sync_status`
(Drive→Kommo), `kommo_duplicados` (debe estar vacía).

---

## Cómo funciona la automatización del pipeline

Un único workflow, `.github/workflows/sync.yml`, ejecuta `node sync.mjs
incremental`, tres etapas en cadena:

```
GitHub Actions        1. Zoho Desk   ──▶  Supabase (tickets)
cada ~1 hora   ──────▶2. Supabase    ──▶  Kommo   [ZohoDesk]
                      3. Hoja Drive  ──▶  Supabase (meta_leads) ──▶ Kommo [MetaAds]
```

Etapa 3 en `try/catch`: si la hoja falla, sigue el sync de Zoho
(`sync_state.meta_last_error`).

**Zoho es incremental** (watermark = `max(created_time)`, pagina hasta topar
con lo guardado; detalle por ticket nuevo porque el listado no trae
`customFields`; refresca 200 tickets abiertos por corrida). **Drive se relee
completo** cada vez (así una corrección en la hoja se propaga).

**Anti-duplicados:** `kommo_lead_id is not null` = ya enviado. Más:
`tickets_ya_en_kommo()` (equivalente ya tiene lead), dedupe dentro del lote,
`meta_leads_solapados()` (misma persona por Zoho). Clave: `asunto + contacto +
titular` (`ticket_dedup_key()`).

**Filtro de Asesor** (desde 2026-08-15): solo migran a Kommo tickets con
`Asesor` = "No tengo"/"Sin Asesor"/"Sin Asesor (KG)" (`ilike`, tolerante a
mayúsculas/espacios). Asesor con nombre real o campo vacío no entra.

**Cadencia real:** el cron dice `*/5 * * * *` pero GitHub ejecuta cada
**45–70 min** (throttling de GitHub). Forzar a mano: Actions → *Sync Zoho →
Supabase* → *Run workflow* (`incremental`/`full`/`enrich`/`kommo`/`meta`).

---

## Comandos

```bash
cd sync                       # requiere sync/.env (no versionado)

node --env-file=.env sync.mjs incremental        # el ciclo completo
node --env-file=.env sync.mjs kommo --dry-run    # ver payloads, no escribe
node --env-file=.env sync.mjs meta --dry-run
node --env-file=.env sync.mjs kommo-init 2026-08-01T00:00:00Z   # mover el corte
node --env-file=.env sync.mjs meta-init  2026-08-01T00:00:00Z

node --env-file=.env limpiar-kommo.mjs --dry-run  # etiquetar dups, arreglar tels
```

Migraciones en `db/` (pipeline) aplican en orden y son idempotentes:
`schema.sql`, `kommo.sql`, `meta_leads.sql`, `dedup.sql`, `bitacora.sql`.

Migraciones del agente de IA en `supabase/migrations/` (0001…0056), aplicadas
directo contra Supabase vía Management API (no CLI local todavía). Deploy de
Edge Functions: `node --env-file=.env.local scripts/deploy-agent-functions.mjs
[slug]`. Aprovisionar/actualizar el Managed Agent de Anthropic: `node
--env-file=.env.local --env-file=sync/.env scripts/provision-agent.mjs`
(idempotente, no duplica lo ya creado, no reconfigura un agente existente —
eso se hace desde `/agent` en el dashboard).

---

## Trampas encontradas (no repetir el diagnóstico)

**Pipeline Zoho/Kommo:**
1. **Zoho no devuelve `modifiedTime` en el listado** de `/tickets` → el
   watermark es `createdTime`, no `modifiedTime` (`sortBy=-modifiedTime` no
   ordena de forma útil).
2. **La API de Kommo no borra leads** (`Allow: GET,POST,PATCH`). Limpiar =
   etiquetar y borrar desde la interfaz.
3. **`filter[tags][0][name]` de Kommo no filtra fiable** (devolvió 1231 leads
   cuando solo 782 tenían la etiqueta) — filtrar por `filter[id][]=` o llevar
   el inventario en Supabase.
4. **Cédulas placeholder** (`C.I: V-00000000`) repetidas entre personas
   distintas → la clave de dedupe incluye `titular`, no solo asunto+contacto.
5. **Teléfonos en formatos mezclados** (Zoho `04241333536`, hoja
   `p:+584241398741`/`p:0414-6222161`/`p:1`) → todo pasa por
   `lib/telefono.mjs`; lo que no encaja en un patrón venezolano se deja crudo
   a propósito.
6. **El `id` de Meta (`l:...`) es la mejor clave de idempotencia** — 0
   repetidos, vs. 28% de duplicados en Zoho.

**Agente de IA:**
7. `process-inbound` **NO lee el body del POST**: procesa `inbound_queue`
   (encolado por `kommo-webhook`), no el payload de la request. Para simular
   un mensaje de prueba hay que insertar en `inbound_queue` y luego invocar
   `process-inbound` para que drene.
8. Migraciones con `net.http_post(url := '${SUPABASE_URL}/...')`: el
   placeholder queda literal en el `.sql` (se sustituye en runtime al
   aprovisionar un cliente nuevo desde el wizard). Al aplicar una migración
   así a **este** proyecto a mano, sustituir `${SUPABASE_URL}` por la URL real
   antes de mandar el SQL — si no, el cron llama a una URL que no existe.
9. `pg_cron` no tiene "cada N días desde una fecha ancla": se aproxima con
   `*/N` en el campo día-del-mes (se resetea en el borde de mes). El hueco
   real desde la última corrida (`DREAMS_LAST_RUN`) compensa para no perder
   días.
10. El kill switch `agent_enabled` (usado por el tope de consumo) solo lo
    chequeaba `generate-response` — `process-inbound` seguía clasificando
    (gastando Haiku) aunque el agente estuviera "apagado". Ahora
    `process-inbound` también lo chequea (mismo campo, `kommo_publish_config
    .agent_enabled`) y no clasifica nada si está en false.

---

## Cronología (resumen)

- **2026-08-07** — Pipeline inicial: `db/schema.sql`, sync Zoho→Supabase,
  dashboard con embudo/kanban/KPIs, GitHub Actions + Pages.
- **2026-08-10** — Login del dashboard, Kommo conectado, sync de Zoho
  arreglado (trampa #1), hoja de Drive integrada, limpieza de duplicados y
  teléfonos, bitácora (`sync_log`) creada.
- **2026-08-15** — Filtro de Asesor en la migración Zoho→Kommo. Se integró la
  maquinaria del template `Template-Agent-kommo` (agente de IA "Sofi"):
  migraciones + Edge Functions + cron desplegados, 11 verticales sembradas,
  system prompt inicial, limpieza de voseo→tuteo en todo el template.
  Bloqueado por falta de crédito de Anthropic. Dashboard del agente publicado
  en Netlify; módulo `/pipeline` agregado ahí mismo.
- **2026-08-19** — Crédito de Anthropic resuelto: Managed Agent + Memory
  Stores creados, pipeline completo (clasificar → responder) verificado con
  mensajes reales, en modo sombra. KB pasó de global a por-vertical
  (`kb_documents.vertical_id NOT NULL`). Dreams: cron dinámico por
  frecuencia + consolidación mensual separada, modelo Haiku. Eliminados:
  módulo "voz" y concepto de "documento de KB sin vertical" (identidad ya
  vive en el system prompt; KB siempre por vertical). Deduplicado
  `CORE_SCAFFOLD`/`composeSystem` (antes vivía copiado en dos archivos, ahora
  uno solo: `agent-prompt-core.mjs`). Unificados en un solo módulo de
  Configuración (`/agent`, 7 pestañas) los 5 módulos que antes eran rutas
  separadas: Agente, Kommo, Herramientas, Seguimiento, Ajustes — auditado sin
  duplicación de funciones entre ellos. Usuarios queda aparte. Después, en la
  misma fecha: publicación a Kommo confirmada apagada; revisión humana
  desactivada del todo (`bypass_review=true` + verticales sin
  `requires_review`), arreglando de paso la invariante que ataba bypass a
  publishing; saneador de emoji para Kommo/WhatsApp (dos capas: prompt +
  código); tope de consumo diario/mensual configurable en `/consumo` que
  apaga el agente completo (clasificación incluida) al superarse; Torre de
  Control (campana en el header, panel deslizable con alertas/estado/consumo/
  revisiones pendientes).
