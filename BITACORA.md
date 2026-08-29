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
  `/pipeline`

---

## Estado actual (al 2026-08-29)

**Agente de IA "Asesora Sofi" (Kommo, WhatsApp/Instagram): ✅ EN VIVO,
publicando de verdad.** `publishing_enabled=true`, `bypass_review=true`.
Para apagarlo o pausar mensajes: ver `/agent` → pestaña Agente → interruptor
"Agente activo" (para todo el pipeline: clasificar + responder + publicar) o
"Publicar en Kommo" (solo deja de enviar, sigue generando drafts en `/inbox`).

- **System prompt: NO editable desde el dashboard.** Solo se ve de solo
  lectura en `/agent`. Cualquier cambio de prompt se hace en una sesión como
  esta (edita `runtime_config.SYSTEM_PROMPT` o `agent-prompt-core.mjs` según
  corresponda y sincroniza con Anthropic).
- **Emoji: prohibido TODO emoji, sin excepción.** Comprobado en vivo que
  Kommo trunca/corrompe el campo completo con cualquier emoji, incluso uno
  simple de un solo símbolo (no solo los compuestos, como se creía antes).
  Dos capas: regla en el prompt + `sanitizeEmojiForKommo` en
  `generate-response` (limpia todo el rango Unicode de emoji pase lo que pase
  el modelo).
- **Instagram y WhatsApp SÍ son canales seguros** para que el cliente
  comparta cédula/teléfono/correo/póliza — regla explícita en el prompt tras
  un caso real donde el agente dijo lo contrario.
- **Acciones de CRM (mover_etapa, marcar_perdido, enviar_imagen,
  actualizar_lead/contacto): se ejecutan YA contra Kommo real**, sin importar
  si "Publicar en Kommo" está apagado — ese interruptor solo gobierna el envío
  de MENSAJES, no las acciones de CRM.
- **`marcar_perdido`**: el agente manda a Perdido (status global 143) a quien
  busca empleo, spam o leads errados, con una de las 11 razones de pérdida de
  Kommo. Kommo exige `loss_reason_id` **junto con** `status_id` en el mismo
  PATCH (mandarlo solo da 400).
- **Tono: concreto.** El agente no cierra con preguntas redundantes; al
  escalar dice que un asesor ya tiene el caso y ofrece allanar o cotizar en
  línea, sin volver a preguntar. Clientes molestos van al correo de ATC.
- **Etapas: el agente se auto-sana.** Antes, si se perdía un webhook de
  `leads.status`, `leads.kommo_stage_id` quedaba viejo y el lead dejaba de
  recibir respuesta para siempre. Ahora `process-inbound` consulta la etapa
  viva en Kommo antes de ignorar un lead por etapa.
- **`publish-to-kommo` reintenta** (hasta 3 veces) y **fusiona**
  `agent_metadata` en vez de sobrescribirlo. Antes, cualquier error dejaba el
  draft en `failed` para siempre sin nada que lo reintentara (caso real: lead
  #14764592, un 400 transitorio de Kommo) y se perdían `session_id`/
  `tool_calls`/`model`/`vertical`.
- **Envío de imágenes de trámites** (`enviar_imagen`, tool automática, sin
  esperar instrucción del operador): patchea `image_field_id` + corre
  `image_salesbot_id` en Kommo. Config en `kommo_publish_config`.
- **Trazabilidad completa en `/inbox`**: la conversación del sistema muestra,
  en una sola línea de tiempo, mensajes + cambios de etapa (movidos por el
  agente O hechos a mano en Kommo, vía `lead_stage_events`) + imágenes
  enviadas por el agente (`drafts.agent_metadata.images_sent`). Un cambio de
  etapa sin mensaje nuevo (drag-and-drop humano en Kommo) llega por
  `leads.status`/`leads.update` del webhook y se registra sin tocar
  `last_message_at` (no reordena el inbox).
- **Torre de control**: campana 🔔 en el header abre un panel que **desplaza**
  el contenido (no flota encima) con alertas activas, Dreams pendientes de
  revisar, estado del agente, consumo vs. tope y revisiones pendientes,
  con botones para actuar y links a "dónde pasó". **El módulo `/alerts`
  standalone fue eliminado**: la Torre de Control es la única vista de
  alertas (histórico incluido).
- **Verticales**: 14 activas (las 11 originales + Empleo, Proveedores,
  Intermediarios-apertura-de-código). Cada una tiene su propio prompt
  (`system_prompt`) y ahora SÍ se inyecta al agente (bug corregido: antes se
  guardaba pero nunca se leía en `buildContext`). Intermediarios-apertura-de-
  código: al pedir apertura de código, el agente mueve el lead a la etapa
  "Apertura de códigos" del pipeline Configuraciones (notifica a Operaciones
  Comerciales por el cambio de etapa, no por mensaje aparte).
- **KB por vertical**: subida de documentos arreglada (el bug era 100%
  cliente — el botón "Guardar" quedaba deshabilitado en silencio si faltaba
  el título; ahora se deshabilita visiblemente y el error es prominente).
  **Todo archivo pasa por un validador antes de entrar**: `prepare` extrae con
  visión (PDF como `document` base64, imagen como `image`), `verify` hace que
  un segundo modelo juzgue la extracción contra el original, e `ingest` solo
  guarda si pasa. Si no pasa, **bloquea y avisa** — nunca entra data mala a
  una vertical.
- **Dreams**: fuerza español explícito (system + reglas de extracción; antes
  solo dependía de "igualar el registro de voz" y salían en inglés).
  Frecuencia de análisis configurable desde `/dreams` (daily/3d/7d/15d)
  funciona con cron dinámico. El digest consolidado (`DREAMS_DIGEST`) es
  **rolling**: borrar un dream fuente NO limpia lo ya consolidado en el
  digest — una corrección dura requiere editar el digest directamente.
- **`/inbox`**: cards de header compactas; pestañas "Agente"/"Resto"; filtro
  y badge "Transferido a humano" (se marca cuando el agente mueve el lead a
  una etapa pausada — `leads.transferred_to_human_at/_stage`).
- **`/analitica`**: funnel completo — leads entrando a Kommo, atendidos por el
  agente, transferidos a humano, conversión a "Ganado", desglose por vertical,
  temas más preguntados, canales. Fuente: `analytics_overview(p_since)`.
  El canal sale de `leads.channel` y, si está vacío, del `source` del primer
  mensaje; los leads sin conversación (importados de Zoho) **se excluyen** del
  gráfico en vez de caer en un cajón "Otro" que llegó a ser el 79%. "Temas más
  preguntados" cuenta solo mensajes clasificados con contenido real; lo que
  queda fuera se reporta aparte (`mensajes_sin_clasificar`,
  `fallos_clasificador`, `mensajes_ignorados`, `mensajes_sin_contenido`) en
  vez de esconderse como "(sin clasificar)".
- **Pipeline Zoho → Kommo: automatizado 100% con `pg_cron` de Supabase**
  (ya NO por GitHub Actions — el cron de `.github/workflows/sync.yml` quedó
  solo con `workflow_dispatch`, sin schedule). Dos jobs:
  `zoho-sync-incremental` (Zoho Desk → Supabase, luego push a Kommo) y
  `zoho-kommo-push-safety` (red de seguridad independiente). Flujo inverso
  B2B: leads restantes (corredores reales) migran a `Ventas B2B` → etapa
  "DATA ZOHO DESK".
- **`/pipeline` tiene dos pestañas**: **"B2C / B2B por corredor"** (la que
  abre por defecto, en `/pipeline`) y "Embudo Zoho" (la de siempre, ahora en
  `/pipeline?vista=embudo`). La primera responde a dónde va cada ticket. En Zoho
  entran mezcladas dos cosas: un cliente final pidiendo cotización (va al
  agente, B2C) y un corredor tramitando a SUS clientes (va a B2B). La segunda
  se lee por intermediario: tabla de corredores ordenable por cualquier
  columna, paginada (100/500/1000), y al desplegar uno se ven sus clientes con
  todas sus cotizaciones (colapsados por defecto), con botón de expandir/
  colapsar todo. El botón **Analítica** abre un panel lateral que desplaza el
  contenido a la mitad: plan, rangos de edad, cruce plan×edad, evolución
  mensual, estado, concentración de corredores, repetición por cliente y prima.
  Fuente: `zoho_pipeline_overview()`, `zoho_corredor_detalle()` y
  `zoho_pipeline_analitica()` (migraciones 0064-0066), que leen la vista
  materializada `mv_zoho_clasificacion` (0067): la clasificación de los 14.427
  tickets se precalcula y se refresca por cron un minuto después del sync
  (`zoho-refrescar-clasificacion`, 1s). Sin eso cada carga recalculaba regex
  fila por fila y la página tardaba el doble. Tras enriquecer 9.998
  tickets con el campo Asesor que faltaba: **B2C ~2.500 · B2B ~11.700 · sin
  atribución 113** (99,2% clasificado), ~1.120 corredores y ~8.300 clientes.
  `moneda` y `ramo` están vacías al 100% en Zoho: no se grafican a propósito.
- **Bug de FK ambigua (`drafts`↔`messages`) corregido**: `publish-to-kommo`,
  `evaluate-outcomes` y `alerts-scan` tiraban 500 en cron por tener dos FKs
  entre esas tablas; se resolvió con el hint explícito
  `messages!drafts_message_id_fkey(...)`.

## PENDIENTE

1. Cargar documentos reales de KB en cada vertical (tarifarios, condiciones,
   FAQs) — hoy la mayoría sigue sin ninguno. **Volver a subir "Flyer RCV" y
   "Flyer marcotas"**: se cargaron antes del validador y su texto quedó
   corrupto; los originales ya no están en disco.
2. Borrar a mano en Kommo los leads etiquetados `duplicado` (la API no
   permite `DELETE /leads`, ver trampa #2).
3. Restringir la hoja de Google de Meta Ads (hoy `anyone: commenter`, expone
   PII) — pedir a `alessandra.publithink@gmail.com` compartirla con cuenta de
   servicio y apuntar `META_SHEET_CSV_URL`.
4. Decidir qué hacer con los leads `revisar-asesor` (etiqueta en Kommo).
5. Definir topes de consumo reales en `/consumo` (hoy sin tope puesto).
6. Limpiar en Zoho los 111 tickets con `Asesor` vacío (no se puede saber desde
   acá si son de corredor o de cliente final) y los nombres de corredor
   escritos de varias formas, que hoy se cuentan como corredores distintos.

### Vencimientos

- **Token de Kommo: 2027-10-30.** Ese día deja de crearse cualquier lead.
- Refresh token de Zoho: sin caducidad conocida, pero se puede revocar.

---

## Cómo saber el estado ahora mismo

```sql
select * from public.estado_general;      -- foto completa: totales, cortes, fallos 24h
select * from public.bitacora_reciente;   -- una fila por corrida del sync
select * from public.analytics_overview(now() - interval '30 days'); -- funnel del agente
```

`sync_log` graba **cada ejecución**; no depende de logs de GitHub Actions
(caducan a los 90 días, y ya casi no se usa Actions para esto).

Otras vistas: `kommo_sync_status` (Zoho→Kommo), `meta_sync_status`
(Drive→Kommo), `kommo_duplicados` (debe estar vacía).

---

## Cómo funciona la automatización del pipeline

**Zoho → Kommo corre por `pg_cron` de Supabase** (jobs `zoho-sync-
incremental` y `zoho-kommo-push-safety`, ver Estado actual). GitHub Actions
(`sync.yml`) queda solo para correr manual (`workflow_dispatch`).

```
pg_cron (Supabase)   1. Zoho Desk   ──▶  Supabase (tickets)
                      2. Supabase    ──▶  Kommo   [B2C: Ventas | B2B: DATA ZOHO DESK]
                      3. Hoja Drive  ──▶  Supabase (meta_leads) ──▶ Kommo [MetaAds]
```

**Zoho es incremental** (watermark = `max(created_time)`). **Drive se relee
completo** cada vez.

**Anti-duplicados:** `kommo_lead_id is not null` = ya enviado. Más:
`tickets_ya_en_kommo()`, dedupe dentro del lote, `meta_leads_solapados()`.
Clave: `asunto + contacto + titular` (`ticket_dedup_key()`).

**Filtro de Asesor B2C:** migran a `Ventas B2C` solo tickets con `Asesor` =
"No tengo"/"Sin Asesor"/"Sin Asesor (KG)"/"Seguros Venezuela"/"Directo
Caracas"/"No Posee" (`ilike`, tolerante). **Filtro B2B (inverso):** el resto
(asesor con nombre real, es decir corredores) migra a `Ventas B2B` → etapa
"DATA ZOHO DESK". La misma regla vive en SQL como `zoho_destino(asesor)`, que
es lo que usa la vista `/pipeline` para no desincronizarse de lo que de verdad
se migra.

---

## Comandos

```bash
cd sync                       # requiere sync/.env (no versionado)

node --env-file=.env sync.mjs incremental        # el ciclo completo
node --env-file=.env sync.mjs kommo --dry-run    # ver payloads, no escribe
node --env-file=.env sync.mjs kommo-b2b --dry-run
node --env-file=.env sync.mjs meta --dry-run
node --env-file=.env sync.mjs kommo-init 2026-08-01T00:00:00Z   # mover el corte
node --env-file=.env sync.mjs kommo-b2b-init 2026-08-01T00:00:00Z
node --env-file=.env sync.mjs meta-init  2026-08-01T00:00:00Z

node --env-file=.env limpiar-kommo.mjs --dry-run  # etiquetar dups, arreglar tels
```

Migraciones en `db/` (pipeline) aplican en orden y son idempotentes.
Migraciones del agente de IA en `supabase/migrations/`, aplicadas directo
contra Supabase vía Management API (no CLI local todavía; `SUPABASE_ACCESS_
TOKEN`/`SUPABASE_PROJECT_REF` en `.env.local`). Tras cualquier cambio de
migración/función, regenerar el bundle del wizard de aprovisionamiento:
`node web/scripts/embed-provision.mjs`.

Deploy de Edge Functions: `npx supabase functions deploy <slug> --project-ref
"$SUPABASE_PROJECT_REF" --no-verify-jwt` (o varios slugs separados por
espacio). Aprovisionar/actualizar el Managed Agent de Anthropic: `node
--env-file=.env.local --env-file=sync/.env scripts/provision-agent.mjs`
(idempotente; no reconfigura un agente existente — eso se hace desde
`/agent`).

---

## Trampas encontradas (no repetir el diagnóstico)

**Pipeline Zoho/Kommo:**
1. **Zoho no devuelve `modifiedTime` en el listado** de `/tickets` (solo viene
   en el detalle) → el watermark es SIEMPRE `createdTime`. Costó un apagón de
   3 días: la Edge Function `zoho-sync` filtraba el listado por `modifiedTime`,
   que al ser `undefined` daba 0, cortaba en el PRIMER ticket y sincronizaba
   cero — respondiendo `ok:true, upserted:0` cada 5 minutos, sin un error. Por
   eso ahora la respuesta trae `watermark`/`nuevos_detectados`/`pendientes`: un
   cero silencioso no se distingue de "no había nada" si no dices contra qué
   comparaste. Para ver cambios de ESTADO (que el listado no permite filtrar)
   hay una segunda pasada que refresca los abiertos más rancios.
2. **La API de Kommo no borra leads** (`Allow: GET,POST,PATCH`). Limpiar =
   etiquetar y borrar desde la interfaz.
3. **`filter[tags][0][name]` de Kommo no filtra fiable** — filtrar por
   `filter[id][]=` o llevar el inventario en Supabase.
4. **Cédulas placeholder** (`C.I: V-00000000`, `12345678`, `124578963`)
   repetidas entre personas distintas → **toda identidad de cliente lleva
   `titular`**, nunca la cédula sola: `ticket_dedup_key()` para el dedupe y
   `zoho_cliente_key()` para la vista. Medido: la cédula `12345678` sola
   fusionaba 153 personas en un "cliente" con 241 cotizaciones.
5. **PostgREST corta en 1000 filas y no avisa**: ignora en silencio un
   `?limit=` mayor. Un "enriquecer 12.000" procesó 998 y dijo "listo". Para
   más de 1000 hay que paginar con cabeceras `Range`.
6. **El endpoint de *tokens* de Zoho es mucho más estricto que la API de
   Desk**: varios workers refrescando a la vez disparan "too many requests" y
   bloquean todo un rato — sin error visible, porque falla al pedir el token,
   no el ticket. `sync/lib/zoho.mjs` comparte un solo refresco en vuelo y
   espera creciente.
7. **Teléfonos en formatos mezclados** → todo pasa por `lib/telefono.mjs`;
   lo que no encaja en un patrón venezolano se deja crudo a propósito.
8. **El `id` de Meta (`l:...`) es la mejor clave de idempotencia.**

**Agente de IA:**
9. `process-inbound` **NO lee el body del POST**: procesa `inbound_queue`
   (encolado por `kommo-webhook`). Para simular un mensaje hay que insertar
   en `inbound_queue` y luego invocar `process-inbound`.
10. Migraciones con `net.http_post(url := '${SUPABASE_URL}/...')`: sustituir
    `${SUPABASE_URL}` por la URL real al aplicar a mano contra este proyecto.
11. `pg_cron` no tiene "cada N días desde una fecha ancla": se aproxima con
    `*/N` en día-del-mes; `DREAMS_LAST_RUN` compensa el hueco real.
12. El kill switch `agent_enabled` debe chequearse en **ambas**
    `process-inbound` (clasificación) y `generate-response` (respuesta) — si
    solo se chequea en una, la otra sigue gastando con el agente "apagado".
13. **Cualquier emoji rompe un campo de texto de Kommo** (PATCH), no solo los
    compuestos — probado en vivo (un 👋 truncó el mensaje). No confiar en
    "los simples son seguros".
14. **`EdgeRuntime.waitUntil()` para encadenar Edge Functions no es
    confiable** (probado: la función encadenada nunca se disparó en cron
    real). Preferir crons independientes de `pg_cron`, cada uno con su propia
    red de seguridad.
15. **Los `dreams` consolidados en `DREAMS_DIGEST` son rolling**: borrar los
    archivos fuente NO borra lo ya consolidado en el digest. Una corrección
    dura (ej: un aprendizaje incorrecto) requiere editar el digest
    directamente, no solo borrar dreams.
16. **Renombrar una etapa en Kommo rompe el código en silencio.** Pasó de
    verdad: "cliente por atender" → "cliente por atender (atender)" y
    "AGENTE" → "AGENTE (no atender)" tumbaron todo el push B2C de Zoho y
    `mover_etapa` sin un solo error visible. Nunca comparar nombres de etapa
    con `===`: usar `matchStagesByName()` (`supabase/functions/_shared/
    kommo.ts`), que va de literal → normalizado → prefijo → contiene. El
    escalón literal importa: CONFIGURACIONES tiene dos etapas que solo se
    distinguen por acentos/mayúsculas ("Apertura de códigos" / "APERTURA DE
    CODIGOS").
17. **Kommo exige `loss_reason_id` junto con `status_id`** en el mismo PATCH
    para marcar Perdido; mandarlo solo da 400. Los estados 142 (Ganado) y 143
    (Perdido) son globales, compartidos por todos los embudos.
18. **Una función `immutable` llamada desde otra función o desde una vista
    necesita el esquema explícito** (`public.zoho_cedula(...)`): la definición
    se resuelve con el `search_path` de quien la crea, que no siempre incluye
    `public`. Falla con "function ... does not exist" aunque exista.

### Rendimiento medido (prueba de carga, 2026-08-29)

15 conversaciones simultáneas end-to-end publicando en Kommo, con 4 usuarios
navegando el dashboard a la vez: **15/15 respondidas, 0 errores, $0,51**.
- Cola: 15/15 `done` al primer intento.
- Recorrido: clasificado ~47s, borrador p50 115s, **publicado p50 139s / p95
  186s**. El grueso NO es el modelo: es el cron de `process-inbound` (hasta
  60s) más `response_debounce_seconds=45`. `generate_response` tardó 19,9s de
  promedio bajo carga — más rápido que su promedio histórico, o sea que la
  concurrencia no lo degrada.
- Web bajo carga (4.902 peticiones): p50 122ms, p95 165ms, **0 errores**.
- Producción (Netlify): p50 ~500ms; `/pipeline` era la más lenta con
  1.500-1.800ms y bajó a **765-810ms** con la vista materializada.

---

## Cronología (resumen)

- **2026-08-07 → 2026-08-19**: pipeline inicial (sync Zoho→Supabase→Kommo,
  dashboard, GitHub Actions), luego agente de IA "Sofi" integrado (Managed
  Agent + Memory Stores, clasificador + respuesta con CMA), verificado con
  mensajes reales en modo sombra (`publishing_enabled=false`). Configuración
  unificada en un solo módulo (`/agent`). KB pasó a ser por vertical.
- **2026-08-19 → 2026-08-26**: **agente activado en vivo** end-to-end.
  Conexión a Kommo (dominio corregido), envío de imágenes de trámites,
  system prompt hecho de solo-lectura en el dashboard (edición solo por
  sesión), horario laboral y frescura de mensajes verificados, multimedia
  (foto/PDF/audio Whisper) validada, bug de KB-upload corregido, bug de
  prompts de vertical no inyectados corregido, 3 verticales nuevas (Empleo,
  Proveedores, Intermediarios-apertura-de-código), Dreams forzado a español
  y frecuencia configurable verificada, Torre de Control rediseñada como
  panel que desplaza (no flota) con pestaña de Dreams pendientes, módulo
  `/alerts` standalone eliminado (todo vive en la Torre de Control), `/inbox`
  con pestañas Agente/Resto y tag "Transferido a humano", módulo `/analitica`
  nuevo (funnel completo), filtro de Asesor B2C corregido y corrido en real,
  flujo B2B inverso (`DATA ZOHO DESK`) agregado, pipeline Zoho↔Kommo
  automatizado con `pg_cron` de Supabase (GitHub Actions dado de baja como
  cron), bug de FK ambigua `drafts`/`messages` corregido, saneador de emoji
  endurecido a TODO emoji (bug de truncado confirmado en vivo), regla
  agregada de que Instagram/WhatsApp sí son canales seguros para datos
  personales (tras un caso real corregido), y trazabilidad completa del
  timeline de `/inbox` (cambios de etapa hechos a mano en Kommo + imágenes
  enviadas por el agente ahora visibles en la conversación).
- **2026-08-26 → 2026-08-29**: endurecido lo que ya estaba en vivo. El agente
  aprendió a mandar a Perdido (`marcar_perdido`) y a hablar más concreto; se
  arregló que un lead volviera a una etapa activa y siguiera mudo (auto-sanado
  de etapa) y que un draft fallido se perdiera para siempre (reintentos +
  `agent_metadata` fusionado). Se descubrió que un rename de etapa en Kommo
  había tumbado el push B2C y `mover_etapa` en silencio → `matchStagesByName`.
  Validador de KB con visión (nada malo entra a una vertical). `/analitica`
  corregida: los canales ya no caen en "Otro" y los "sin clasificar" se
  reportan aparte. 9.998 tickets enriquecidos desde Zoho (destapó el tope de
  1000 filas de PostgREST y el bloqueo del endpoint de tokens de Zoho), y con
  esa data el módulo `/pipeline` ganó la vista B2C/B2B por corredor:
  tabla ordenable y paginada, cliente → sus cotizaciones, identidad de cliente
  corregida a cédula + titular, y panel lateral de analítica. Al verificar los
  crones se descubrió que **`zoho-sync` llevaba 3 días sin traer un solo
  ticket** (filtraba por `modifiedTime`, que el listado de Zoho no devuelve):
  corregido a watermark por `createdTime`, 236 tickets recuperados y migrados
  a Kommo.
