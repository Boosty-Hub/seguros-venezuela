# Bitácora del proyecto

Registro de qué se hizo, dónde quedó y qué falta. **Leer esto primero** al
retomar el trabajo.

- **Repo:** `Boosty-Hub/seguros-venezuela-pipeline` (privado), rama `main`
- **Supabase:** proyecto `lwqqnnefywsjaatuyjma` · `seguros venezuela Project`
- **Kommo:** `segurosvenezuelait.kommo.com` (cuenta 36827351)
- **Dashboard del pipeline:** https://boosty-hub.github.io/seguros-venezuela-pipeline/
- **Dashboard del agente de IA:** `web/` (Next.js), local por ahora en `pnpm dev` (localhost:3000)

---

## Agente de IA en Kommo (Sofi) — Estado al 2026-08-15

Se integró en este mismo repo la maquinaria del template `Boosty-Hub/Template-Agent-kommo`
(carpetas `web/`, `agent/`, `supabase/functions/*`, `supabase/migrations/*`) para
construir un agente de IA (Claude) que responde mensajes entrantes de Kommo
(WhatsApp/Instagram). Documentación de referencia del template en `agent-docs/`.

**Hecho:**
- 48 migraciones aplicadas + 9 Edge Functions desplegadas (`verify_jwt=false`) +
  8 cron jobs activos, en el mismo proyecto Supabase del pipeline (sin choque de
  tablas: `leads/messages/drafts/verticals/...` vs `tickets/meta_leads/sync_log`).
- `pgvector`, `pg_cron`, `pg_net` habilitados.
- Webhook de Kommo creado (id `47441283`) → `kommo-webhook`, eventos
  `add_lead`/`update_lead`/`add_message`, protegido con `KOMMO_WEBHOOK_SECRET`
  (guardado como secret de Supabase, no en texto plano en el repo).
- `runtime_config` cargado: identidad (operador **"Asesora Sofi"**), modelo
  **claude-haiku-4-5** para clasificador Y agente de respuesta, credenciales de
  Kommo (mismo token que ya usa `sync/`, tiene los scopes de mensajería
  `send_external_messages`/`list_external_messages`).
- **8 verticales de negocio** sembradas en la tabla `verticals` (salud
  individual/colectiva, vida, patrimonial, automóvil, empresarial, mascotas,
  siniestro/reclamo) + las 3 universales del template (`general`,
  `engagement_social`, `hate_sarcasmo`). Todas con `requires_review=true` salvo
  `engagement_social` (modo sombra conservador).
- System prompt inicial escrito en `agent/system-prompt.md` (gitignored, es
  identidad de negocio) usando contexto real de segurosvenezuela.com (70+ años,
  "Más que una compañía, somos compañía", productos por línea, call center
  `0501 SV INFORMA`). El bot "Sofi" del sitio real corre en una plataforma
  externa (Aivo/AgentBot) sin relación con este agente — no se pudo interactuar
  con él (requiere navegador, no hay tool de browsing en esta sesión).
- **Limpieza de voseo**: el template completo (~100 archivos: UI del dashboard,
  prompts reales de `process-inbound`/`generate-response`/`dreams-run`, tools
  en `agent_tools`, docs) traía voseo rioplatense. Se convirtió TODO a tuteo
  venezolano/latinoamericano — incluye el `CORE_SCAFFOLD` (el prompt fijo que
  se envía a Claude en cada sesión) y los prompts del clasificador.
- `kommo_publish_config`: `agent_enabled=true`, **`publishing_enabled=false`**
  (modo sombra por defecto — genera pero no envía), `bypass_review=false`.
  Tools de CRM/Shopify/BCV quedan desactivadas por gate hasta que se decida
  activarlas (Fase de tools del plan).

**Bloqueado:**
- **La cuenta de Anthropic no tiene crédito** ("Your credit balance is too
  low"). El Environment ya se creó (`env_01Y4Hq11zwfoZSmaf1deLS1p`), pero
  crear el Managed Agent + los 2 Memory Stores falla hasta que se cargue
  saldo en console.anthropic.com → Plans & Billing.
- Para terminar el aprovisionamiento una vez haya crédito: `node
  --env-file=.env.local --env-file=sync/.env scripts/provision-agent.mjs`
  (crea Environment/Agent/Memory Stores que falten y guarda los IDs en
  `runtime_config`; es idempotente, no duplica lo ya creado).

**Módulo nuevo: `/pipeline`.** El dashboard del agente (`web/`) ahora tiene una
sección "Pipeline Zoho" (menú lateral, grupo Operación) que muestra el mismo
embudo/kanban/KPIs que el dashboard público de siempre (`dashboard/`, sin
tocar) — mismas vistas de Supabase (`v_kpis`, `v_funnel`, `v_channel`,
`v_agent`), sin tablas nuevas. Para no tener que saltar entre dos paneles con
login separado.

**Pendiente después de eso:**
1. Probar el pipeline completo con mensajes reales (modo sombra: revisar
   drafts en `/inbox`, nada se envía al cliente todavía).
2. Cargar `/voz` (ejemplos reales de conversaciones) y `/kb` (tarifarios,
   condiciones, FAQs reales de las aseguradoras).
3. Decidir criterio de salida del modo sombra y activar `publishing_enabled`.
4. Publicar el dashboard en Netlify/Vercel cuando se quiera acceso fuera de
   esta máquina (hoy corre local con `pnpm dev` en `web/`).

### Qué está desplegado de verdad (2026-08-15, fin de sesión)

| Pieza | Estado |
|---|---|
| Supabase (migraciones, Edge Functions, cron, extensiones) | ✅ **en producción**, proyecto `lwqqnnefywsjaatuyjma` |
| Webhook de Kommo → `kommo-webhook` | ✅ **activo** (id `47441283`), protegido con secret |
| `runtime_config` (identidad, Kommo, verticales) | ✅ cargado |
| Anthropic Managed Agent + Memory Stores | ❌ **bloqueado por saldo** — solo el Environment se creó |
| Dashboard `web/` (Next.js) | ⚠️ **solo local**, `pnpm dev` en esta máquina — no está publicado en Netlify/Vercel todavía |
| Repo en GitHub | rama `main`, con todo el código del agente (`web/`, `agent/`, `supabase/functions`, `supabase/migrations`, `scripts/`) |

En corto: el **backend del agente ya corre en producción** (recibe webhooks,
los encola, los cronjobs están vivos), pero **no responde nada todavía**
porque falta crédito de Anthropic, y el **panel de administración solo es
visible desde esta máquina** hasta que se decida desplegarlo.

---

## Cómo saber el estado ahora mismo

Dos consultas en el SQL Editor de Supabase resuelven cualquier duda:

```sql
select * from public.estado_general;      -- foto completa: totales, cortes, fallos 24h
select * from public.bitacora_reciente;   -- una fila por corrida del sync
```

`sync_log` graba **cada ejecución** (local o en GitHub Actions) con lo que creó
y lo que falló. No depende de los logs de Actions, que caducan a los 90 días.

Otras vistas de apoyo:

| Vista | Para qué |
|---|---|
| `kommo_sync_status` | Estado de la integración Zoho → Kommo |
| `meta_sync_status` | Estado de la hoja de Drive → Kommo |
| `kommo_duplicados` | Grupos que generaron más de un lead. **Debe estar vacía** |

---

## Estado al 2026-08-10 (fin de sesión)

Cifras del momento del commit; **para el dato vivo, `select * from
public.estado_general`**. Los totales de tickets y leads crecen solos.

| Pieza | Estado |
|---|---|
| Zoho Desk → Supabase | ✅ funcionando, 13.035 tickets |
| Supabase → Kommo (Zoho) | ✅ 613 leads, etiqueta `ZohoDesk`, corte 2026-08-01 |
| Hoja Drive → Supabase | ✅ 1.093 leads en `meta_leads` |
| `meta_leads` → Kommo | ✅ 458 leads, etiqueta `MetaAds`, corte 2026-08-01 |
| Control de duplicados | ✅ activo en ambas entradas, `kommo_duplicados` en 0 |
| Teléfonos | ✅ 608/608 contactos de Zoho en `+58XXXXXXXXXX` |
| Dashboard | ✅ publicado, login con `gmontiel@spatiumgroup.com` |
| Automatización | ✅ GitHub Actions, un solo workflow hace las 3 etapas |

Leads en Kommo: **1.053 reales** (613 Zoho + 458 Meta − 18 compartidos) más
**172 etiquetados `duplicado`** esperando borrado manual.

---

## Estado al 2026-08-15

**Filtro de Asesor en el ingreso Zoho → Kommo.** Solo migran tickets cuyo
campo `Asesor` (customField de Zoho Desk) valga "No tengo", "Sin Asesor" o
"Sin Asesor (KG)" (variantes de mayúsculas/espacios toleradas vía `ilike`
comodín). El resto — asesor con nombre real o campo vacío — ya no entra al
CRM. Implementado en `sync/lib/supa.mjs` (`FILTRO_SIN_ASESOR`,
`getTicketsPendingKommo`).

Retroactivo: `sync/revisar-asesor-kommo.mjs` etiquetó **205 leads** ya
existentes en Kommo (de 1111 tickets que no cumplían la regla; los otros 906
ya no tenían lead vivo — fusionados o borrados en la limpieza previa) con la
etiqueta `revisar-asesor`, para decidir a mano si se eliminan desde la
interfaz (la API de Kommo no borra, ver trampa nº2).

## PENDIENTE

1. **Borrar los 172 leads etiquetados `duplicado`** en la interfaz de Kommo
   (filtrar por etiqueta → seleccionar todo → eliminar). **La API no permite
   borrar leads**: `DELETE /api/v4/leads` devuelve 405 con
   `Allow: GET,POST,PATCH`. Es la única tarea que requiere manos humanas.
2. **Restringir la hoja de Google.** Tiene permiso `anyone: commenter`:
   cualquiera con el enlace lee nombre, fecha de nacimiento, teléfono y correo
   de 1.093 personas. Al cerrarla, la lectura por CSV público deja de funcionar
   → hay que pedir a `alessandra.publithink@gmail.com` que la comparta con una
   cuenta de servicio y apuntar `META_SHEET_CSV_URL`.
3. **Decidir si el contacto del lead debe ser el asesor o el asegurado.** Hoy es
   el **asesor**: los tickets de Zoho traen el correo del intermediario
   (`asesor@...`) en el campo de contacto, no el del cliente final. Si el
   vendedor espera ver al asegurado, hay que mapear desde `titular`.
4. **Decidir qué hacer con los 205 leads `revisar-asesor`** (ver "Estado al
   2026-08-15" arriba): filtrar por esa etiqueta en Kommo y eliminarlos a mano
   si se confirma que no deben estar, o quitarles la etiqueta si alguno se
   decide conservar.
4. **Latencia real ~1 hora**, no 5 minutos (ver más abajo). Si comercial necesita
   responder en minutos, hace falta el webhook de Zoho.
5. **Leer todas las pestañas de la hoja.** Hoy solo se lee la primera. Con un
   único formulario da igual, pero si marketing añade una pestaña por campaña se
   ignoraría en silencio.

### Vencimientos

- **Token de Kommo: 2027-10-30.** Ese día deja de crearse cualquier lead.
- Refresh token de Zoho: sin caducidad conocida, pero se puede revocar.

---

## Cómo funciona la automatización

Un único workflow, `.github/workflows/sync.yml`, ejecuta `node sync.mjs
incremental`, que hace tres etapas en cadena:

```
GitHub Actions        1. Zoho Desk   ──▶  Supabase (tickets)
cada ~1 hora   ──────▶2. Supabase    ──▶  Kommo   [ZohoDesk]
                      3. Hoja Drive  ──▶  Supabase (meta_leads) ──▶ Kommo [MetaAds]
```

La etapa 3 va en `try/catch`: si la hoja falla, se registra en
`sync_state.meta_last_error` y el sync de Zoho continúa.

**Zoho es incremental.** Watermark = `max(created_time)` en Supabase; pagina
`/tickets?sortBy=-createdTime` hasta topar con lo ya guardado. De cada ticket
nuevo pide el detalle (el listado no trae `customFields`). Además refresca 200
tickets abiertos por corrida para captar cambios de etapa.

**Drive se relee completo cada vez.** La hoja entera (330 KB) por
`/export?format=csv`, upsert de las 1.093 filas por el `id` de Meta. Es
deliberado: así una corrección en la hoja se propaga, cosa que un watermark
impediría.

**Lo que impide duplicados:** `kommo_lead_id is not null` significa "ya enviado,
nunca más". Encima, tres filtros antes de crear:

| Filtro | Cuándo |
|---|---|
| `tickets_ya_en_kommo()` | Un ticket equivalente ya tiene lead → vincula |
| Dentro del lote | Dos tickets nuevos equivalentes → uno crea, resto heredan |
| `meta_leads_solapados()` | La persona ya está por Zoho → vincula |

Clave de equivalencia: `asunto + contacto + titular` (`ticket_dedup_key()`).

### Cadencia real

El cron dice `*/5 * * * *` pero **GitHub ejecuta cada 45–70 min** (verificado en
el historial: 09:50, 11:01, 11:56, 13:27, 14:38, 15:39, 16:33, 17:32, 18:29,
20:21). GitHub estrangula los schedules. Un lead tarda **hasta una hora**.

Forzar a mano: Actions → *Sync Zoho → Supabase* → *Run workflow*, con modo
`incremental`, `full`, `enrich`, `kommo` o `meta`.

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

Migraciones en `db/`, aplicar en orden: `schema.sql`, `kommo.sql`,
`meta_leads.sql`, `dedup.sql`, `bitacora.sql`. Todas son idempotentes.

---

## Trampas encontradas (no repetir el diagnóstico)

1. **Zoho no devuelve `modifiedTime` en el listado** de `/tickets`. El sync
   incremental original comparaba contra `undefined → 0`, así que cortaba en el
   primer ticket y reportaba "0 cambios" **con éxito**. Estuvo 3 días muerto sin
   que nada lo delatara. Por eso el watermark es `createdTime`.
   Además `sortBy=-modifiedTime` no ordena de forma útil.
2. **La API de Kommo no borra leads.** `Allow: GET,POST,PATCH` en `/api/v4/leads`
   y `Allow: GET,PATCH` en `/api/v4/leads/{id}`. `POST /leads/delete` da 404.
   Limpiar = etiquetar y borrar desde la interfaz.
3. **`filter[tags][0][name]` de Kommo no filtra de forma fiable**: devolvió 1231
   leads cuando solo 782 tenían la etiqueta. Filtrar por `filter[id][]=` con ids
   conocidos, o llevar el inventario en Supabase (que es lo que se hace).
4. **Cédulas placeholder.** Hay asuntos con `C.I: V-00000000` que se repiten
   entre personas **distintas**. Agrupar duplicados solo por asunto + contacto
   fusionaba clientes reales: se encontró un grupo con 5 leads y 2 titulares
   diferentes. De ahí que la clave incluya `titular`.
5. **Los teléfonos llegan en formatos mezclados.** Zoho: `04241333536`. La hoja:
   `p:+584241398741`, `p:0414-6222161`, `p:1`. Todo pasa por
   `lib/telefono.mjs`. Los que no encajan en ningún patrón venezolano (números
   de Colombia, Perú, Brasil) se dejan crudos a propósito: mejor un dato visible
   que uno falso bien formateado.
6. **El `id` de Meta (`l:...`) es la mejor clave de idempotencia** del proyecto:
   1.093 filas, 0 repetidos. Los datos de la hoja son mucho más limpios que los
   de Zoho (que tenía 28% de duplicados).

---

## Cronología

### 2026-08-07 — Sesión 1
Pipeline inicial: `db/schema.sql`, sync Zoho → Supabase, dashboard con embudo,
kanban, KPIs y tendencia. Carga completa de 12.870 tickets. GitHub Actions y
Pages configurados. Correcciones al cálculo de conversión del embudo.

### 2026-08-10 — Sesión 2
1. **Login del dashboard.** No era el auth: la única cuenta existente era
   `pipeline@segurosvenezuela.com` con contraseña desconocida. Se creó
   `gmontiel@spatiumgroup.com` (confirmado). Verificado de punta a punta: sesión
   válida, 12.870 tickets legibles, RLS bloqueando al anónimo.
2. **Kommo conectado.** El subdominio no está en el JWT (solo `base_domain`) y
   `api-c.kommo.com` da 401; hizo falta pedirlo. Embudo `VENTAS` (14251835) y
   etapa `cliente por atender` (110051287) resueltos por API.
3. **Sync de Zoho arreglado** (trampa nº1). Recuperó 158 tickets perdidos.
4. **782 leads de Zoho** creados en Kommo (agosto). 200 se crearon sin avisar
   antes del número, por un corte de prueba que quedó activo con el auto-push.
5. **Hoja de Drive integrada.** 1.093 leads a `meta_leads` con RLS; 440 creados
   en Kommo + 18 vinculados a leads que ya existían por Zoho.
6. **Limpieza.** 172 duplicados etiquetados, 780 teléfonos normalizados a `+58`,
   18 leads con doble etiqueta `ZohoDesk` + `MetaAds`. Control preventivo de
   duplicados en ambas entradas, probado desvinculando un duplicado a propósito
   (destapó un `import` faltante que habría roto el cron).
7. **Bitácora** (`sync_log`, `bitacora_reciente`, `estado_general`) y este
   documento.

### Correcciones de rumbo de la sesión 2

Vale la pena saber por qué algunas cifras cambiaron sobre la marcha:

- **Duplicados: 219 → 231 → 156 → 172.** No aparecieron ni desaparecieron: se
  cambió la clave de agrupación al descubrir el problema de las cédulas
  placeholder. **172 es la cifra correcta**, con la clave canónica.
- **Agosto en Meta: 447 → 458.** Diferencia por zona horaria. 447 contando en
  hora de Venezuela, 458 en UTC. Se usa UTC por consistencia con el resto.
- **Solapamiento Meta↔Zoho: 30 filas = 18 personas.** La función devuelve un
  registro por pareja (lead de Meta, ticket), y Zoho tiene varios tickets por
  persona. **18 es el número de personas.**
