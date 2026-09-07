# Bitácora del proyecto

Qué se hizo, dónde quedó y qué falta. **Leer esto primero** al retomar.

> **Regla para actualizar** (sesión humana o agente): leer el archivo completo
> antes de escribir. **Fusionar**, nunca agregar una sección que repita o
> contradiga otra; si un dato cambió, **reemplazarlo**. Mantenerla **corta**:
> cuanto más larga, menos se lee. Cifras e IDs van en "Estado actual"; las
> trampas no se repiten arriba.

- **Repo:** `Boosty-Hub/seguros-venezuela` (público), rama `main`
- **Supabase:** `lwqqnnefywsjaatuyjma`
- **Kommo:** `segurosvenezuelait.kommo.com` (cuenta 36827351)
- **Dashboard:** https://segurosvenezuela.netlify.app (Next.js en `web/`,
  deploy automático desde `main`; local con `pnpm dev`). El pipeline Zoho vive
  dentro, en `/pipeline`.

---

## Estado actual (2026-09-01)

**Agente "Asesora Sofi" (Kommo, WhatsApp/Instagram): EN VIVO, publicando.**
`agent_enabled=true`, `publishing_enabled=true`, `bypass_review=true`.
Para apagarlo: `/agent` → "Agente activo" (para todo) o "Publicar en Kommo"
(deja de enviar, sigue generando drafts en `/inbox`).

### Agente

- **System prompt: NO editable desde el dashboard** (solo lectura en `/agent`).
  Se cambia editando `runtime_config.SYSTEM_PROMPT` o `agent-prompt-core.mjs`
  y sincronizando con Anthropic.
- **Prohibido TODO emoji** (ver trampa 15). Dos capas: regla en el prompt +
  `sanitizeEmojiForKommo` en `generate-response`.
- **Instagram y WhatsApp SÍ son canales seguros** para que el cliente comparta
  cédula/teléfono/póliza — regla explícita tras un caso real al revés.
- **Tono concreto**: no cierra con preguntas redundantes; al escalar dice que
  un asesor ya tiene el caso y ofrece allanar o cotizar en línea. Clientes
  molestos van al correo de ATC.
- **Acciones de CRM** (`mover_etapa`, `marcar_perdido`, `enviar_imagen`,
  `actualizar_lead/contacto`) **se ejecutan contra Kommo real aunque "Publicar
  en Kommo" esté apagado** — ese interruptor solo gobierna los MENSAJES.
- **`marcar_perdido`**: manda a Perdido (143) a empleo, spam y leads errados,
  con una de las 11 razones de Kommo (ver trampa 10).
- **Auto-sanado de etapa**: si se pierde un webhook `leads.status`,
  `process-inbound` consulta la etapa viva en Kommo antes de ignorar el lead.
  Antes quedaba mudo para siempre.
- **`publish-to-kommo` reintenta** (3 veces) y **fusiona** `agent_metadata` en
  vez de sobrescribirlo. Antes un error dejaba el draft `failed` para siempre
  y se perdían `session_id`/`tool_calls`/`model`/`vertical`. Dos casos NO se
  reintentan (terminal de una): lead cerrado (Ganado/Perdido) o borrado en
  Kommo (trampa 23).
- **Verticales**: 14 activas. Cada una inyecta su `system_prompt` al agente.
  Intermediarios-apertura-de-código mueve el lead a "Apertura de códigos" del
  pipeline CONFIGURACIONES (notifica por el cambio de etapa, no por mensaje).
- **KB por vertical con validador obligatorio**: `prepare` extrae con visión
  (PDF como `document` base64, imagen como `image`), `verify` hace que un
  segundo modelo juzgue la extracción contra el original, e `ingest` solo
  guarda si pasa. Si no pasa, **bloquea y avisa**.
- **Dreams**: en español (forzado en system + reglas). Frecuencia configurable
  desde `/dreams` con cron dinámico. `/dreams` lista los activos en **tabla**
  ordenable por fecha/severidad/período/título, con buscador, selector
  50/100/250 y paginación. El digest (`DREAMS_DIGEST`) es rolling: ver trampa 17.

### Dashboard

- **Torre de control**: la campana abre un panel que **desplaza** el contenido
  (no flota) con alertas, Dreams pendientes, estado del agente, consumo vs.
  tope y revisiones. **`/alerts` standalone fue eliminado**: la Torre es la
  única vista de alertas.
- **`/inbox`**: pestañas "Agente"/"Resto", badge "Transferido a humano", y una
  sola línea de tiempo con mensajes + cambios de etapa (`lead_stage_events`,
  incluidos los hechos a mano en Kommo) + imágenes enviadas por el agente. Un
  cambio de etapa sin mensaje no toca `last_message_at` (no reordena el inbox).
  **Favoritas**: estrella por conversación (`leads.favorited_at`, migración
  0068) y botón de filtro con contador. La marca es **del equipo, no por
  usuario**, y el filtro cruza las dos pestañas: si marcas una que después pasa
  a un humano, sigue apareciendo.
- **`/analitica`**: funnel del agente vía `analytics_overview(p_since)`. El
  canal sale de `leads.channel` y si está vacío del `source` del primer
  mensaje; los leads sin conversación **se excluyen** en vez de caer en un
  "Otro" que llegó a ser el 79%. Lo no clasificado se reporta aparte
  (`mensajes_sin_clasificar`, `fallos_clasificador`, `mensajes_ignorados`,
  `mensajes_sin_contenido`) en vez de esconderse como "(sin clasificar)".
- **`/pipeline`, dos pestañas**: **"B2C / B2B por corredor"** (por defecto, en
  `/pipeline`) y "Embudo Zoho" (`?vista=embudo`). La primera separa lo que va
  al agente de lo que va a corredores, y lo B2B se lee por intermediario:
  tabla ordenable, paginada (100/500/1000), y al desplegar un corredor sus
  clientes (colapsados) con todas sus cotizaciones. El botón **Analítica** abre
  un panel lateral que desplaza el contenido a la mitad (plan, edad, cruce
  plan×edad, evolución mensual, estado, concentración, repetición, prima).
  `moneda` y `ramo` están vacías al 100% en Zoho: no se grafican a propósito.
- Fuente: `zoho_pipeline_overview()`, `zoho_corredor_detalle()` y
  `zoho_pipeline_analitica()` (migraciones 0064-0066), que leen la vista
  materializada **`mv_zoho_clasificacion`** (0067): precalcula la clasificación
  de los ~15.000 tickets, refrescada por cron un minuto después del sync
  (`zoho-refrescar-clasificacion`, 1s). Sin eso cada carga recalculaba los
  regex fila por fila y la página tardaba el doble.
- Datos al 06-09 (15.055 tickets no-spam): **B2C 2.649 · B2B 12.286 · sin
  atribución 120** (99,2% clasificado), 1.163 corredores, ~11.000 clientes
  finales (8.780 del lado B2B).

### Alertas abiertas

6 genuinas sin resolver hace 4-5 días — gap de **proceso**, no de código:
**Andrea** (queja de reembolso, tox 0.30, desde 26/08) y **Andrés Ramírez**
(5 alertas del 27/08: documentos/cédula, un WhatsApp en formato no soportado
por Kommo, ambigüedad individual/colectiva). Requieren un humano en Kommo.
El resto de la Torre (2 audios, silencio del webhook, 2 dreams, regresión de
outcomes, 3 `draft_failed`) se auditó el 01/09, se explicó y quedó
reconocido con nota en `metadata.resolved_note` — detalle técnico en las
trampas 20-23 y las secciones de abajo. `detectOutcomesRegression` ahora
ignora una caída de `lead_replied` si el volumen de inbound también se
desplomó (>50%) — ese grader depende del volumen, no de la calidad del
agente, y confundía el apagón del webhook con una regresión real.

**Se eliminó el webhook de salida de alertas** (`alert_config`,
Slack/Discord): nunca se usó. Migración `0070` tira la tabla; las alertas
viven solo en la Torre de Control.

### Webhook de Kommo → auto-sanado

Kommo deshabilita el webhook cuando le falla sostenido (pasó el 29/08
~16:20 UTC: ~40h mudo; la alerta `inbound_silence` avisaba desde el 28/08
sin que nadie la atendiera). `alerts-scan` (cada 5 min) chequea el estado
real contra la API de Kommo y, si está `disabled` o no existe, lo recrea
solo (DELETE + POST — Kommo no admite PATCH de `disabled`, trampa 20), sin
esperar revisión humana: si falla, reintenta cada 20 min indefinidamente
(cooldown solo sobre la escritura; la lectura corre siempre). Alerta
`kommo_webhook_reconnected` / `kommo_webhook_reconnect_failed` en la Torre.

### Bitácora propia (`system_logs`)

El Log Drain oficial de Supabase cuesta $60/mes — descartado. En su lugar,
tabla propia `system_logs` (migración 0069, retención
`runtime_config.SYSTEM_LOGS_RETENTION_DAYS` default 30 días, cron de
limpieza diario) + `_shared/system-log.ts` (`logEvent`, fail-soft),
instrumentada a mano en `kommo-webhook` (secret inválido, excepciones) y
`process-inbound` (fallas reales de Whisper, crashes del drain). No
reemplaza al Log Drain (no cubre Postgres/Auth/HTTP general) — es
instrumentación puntual de los dos puntos que ya mordieron.

### Transcripción de notas de voz (Whisper)

Estaba rota al 100%, no de forma intermitente (trampas 21-22): la descarga
fallaba siempre por un redirect mal manejado, y aun bajando el archivo
Whisper lo rechazaba por un nombre de archivo que no coincidía con el
formato real. Arreglado. Además, el recobro automático ahora también
reintenta audio (antes solo imagen/documento), y la transcripción exitosa
se persiste en `messages.content` con prefijo 🎙️ — antes se usaba solo para
clasificar ESE mensaje y el historial se quedaba con el placeholder
`[Audio ...]` para siempre.

### Pipeline Zoho → Kommo

Automatizado con **`pg_cron` de Supabase** (GitHub Actions quedó solo con
`workflow_dispatch`). Jobs: `zoho-sync-incremental`, `zoho-kommo-push-safety`
(red de seguridad independiente) y `zoho-refrescar-clasificacion`.

```
pg_cron   1. Zoho Desk  ──▶ Supabase (tickets)
          2. Supabase   ──▶ Kommo  [B2C: VENTAS B2C | B2B: DATA ZOHO DESK]
          3. Hoja Drive ──▶ Supabase (meta_leads) ──▶ Kommo [MetaAds]
```

**Zoho es incremental** (watermark `max(created_time)`, ver trampa 1). **Drive
se relee completo** cada vez.

**Anti-duplicados:** `kommo_lead_id is not null` = ya enviado; más
`tickets_ya_en_kommo()`, dedupe dentro del lote y `meta_leads_solapados()`.
Clave: `asunto + contacto + titular` (`ticket_dedup_key()`).

**Filtro B2C:** migran a `VENTAS B2C` los tickets con `Asesor` **NULL/vacío**
(cliente final que llegó sin corredor) o = "No tengo" / "Sin Asesor" / "Sin
Asesor (KG)" / "Seguros Venezuela" / "Directo Caracas" / "No Posee" (`ilike`).
**B2B (inverso):** el resto (corredores con nombre real) va a `VENTAS B2B` →
"DATA ZOHO DESK". Los dos filtros tienen que ser **partición exacta**: un hueco
deja tickets sin empujar para siempre (trampa 24), un solapamiento duplica el
lead. Viven en **dos runtimes que se tocan juntos**:
`supabase/functions/zoho-kommo-push/index.ts` (el cron) y `sync/lib/supa.mjs`
(el script Node).

En SQL, `zoho_destino(asesor)` mantiene **a propósito** un tercer valor,
`sin_atribucion`, para los NULL/vacío: en Kommo van a B2C, pero `/pipeline` los
cuenta aparte porque no hay corredor al que atribuirlos — es la medida de lo
sucio que está el dato en Zoho (PENDIENTE 6). Routing y reporte difieren ahí
deliberadamente; no es una desincronización que haya que "arreglar".

### Efectividad de corredores (cotizado vs. emitido)

En `/pipeline` → "B2C / B2B por corredor". Cruza las cotizaciones de Zoho con
las pólizas realmente emitidas, que vienen del **sistema central en un CSV
mensual** que el operador sube desde el propio dashboard (botón "Cargar
emisiones": dos pasos, primero un preview de lo que va a entrar y solo después
se escribe). Migraciones 0071-0073; el parser vive en `web/src/lib/emisiones.ts`
y la ruta en `/api/pipeline/emisiones`.

- **El cruce de cliente es por cédula** (tomador **o** asegurado, que son
  personas distintas en muchas pólizas). `zoho_cedula()` la saca del asunto en
  el 99,8% de los tickets B2B. Con el archivo de agosto machean 225 de 539
  pólizas.
- **El cruce de corredor es por `corredor_alias`**, que liga el texto libre de
  Zoho al `Cod_Intermediario` canónico del CSV. Esto es lo que arregla el
  recuento de corredores: las 12 escrituras de "BARECA" (typo `CORETAJE`
  incluido) colapsan en una. `zoho_mapear_corredores()` lo propone solo
  (267 alias de 1.163 nombres con el archivo de agosto) y respeta lo marcado a
  mano (`origen` = `manual` / `rechazado`).
- **La emisión se acredita al intermediario del sistema central**, no al asesor
  que escribió el ticket: cuando difieren suele ser persona vs. empresa
  (CSV "MARSH VENEZUELA CA..." vs. Zoho "MANUEL LOBATON").
- **Anuladas no cuentan como cierre** y se muestran aparte (agosto: 460
  vigentes / 79 anuladas).
- Se publican **dos porcentajes** (por cotizaciones y por clientes) y son un
  **suelo declarado**, no la cifra final: ver trampa 26. Con solo agosto dan
  4,8% y 4,2%. La medida que NO depende de la ventana — y por eso la fiable
  hoy — es la inversa: de las pólizas emitidas, cuántas venían de una
  cotización (35,6%).
- Falta la UI para editar alias a mano (hoy solo por SQL) — PENDIENTE 8.

### Rendimiento medido (2026-08-29)

15 conversaciones simultáneas end-to-end publicando en Kommo, con 4 usuarios
navegando el dashboard: **15/15 respondidas, 0 errores, $0,51**.

- Recorrido: clasificado ~47s · borrador p50 115s · **publicado p50 139s /
  p95 186s**. El grueso NO es el modelo: es el cron de `process-inbound` (hasta
  60s) más `response_debounce_seconds=45`. `generate_response` tardó 19,9s bajo
  carga, más rápido que su promedio histórico: la concurrencia no lo degrada.
- Web bajo carga (4.902 peticiones): p50 122ms, p95 165ms, 0 errores.
- Producción: p50 ~500ms. `/pipeline` era la más lenta (1.500-1.800ms) y bajó a
  **765-810ms** con la vista materializada.
- Netlify devuelve 403 tras ~66 cargas seguidas (rate limiting propio).

## PENDIENTE

1. Cargar KB real en cada vertical (tarifarios, condiciones, FAQs) — la mayoría
   sigue sin ninguno. **Volver a subir "Flyer RCV" y "Flyer marcotas"**: se
   cargaron antes del validador y su texto quedó corrupto.
2. Borrar a mano en Kommo los leads etiquetados `duplicado` y los 15 de
   `prueba-carga` (`[BORRAR - prueba de carga 166377]`, ya en Perdido). La API
   no borra leads (trampa 2).
3. Restringir la hoja de Google de Meta Ads (hoy `anyone: commenter`, expone
   PII): pedir a `alessandra.publithink@gmail.com` compartirla con cuenta de
   servicio y apuntar `META_SHEET_CSV_URL`.
4. Decidir qué hacer con los leads `revisar-asesor`.
5. Definir topes reales en `/consumo` (hoy sin tope).
6. Limpiar en Zoho los 120 tickets con `Asesor` vacío (desde el 06-09 ya migran
   a B2C, pero siguen sin corredor atribuible). Los nombres de corredor
   escritos de varias formas ya no distorsionan la efectividad —
   `corredor_alias` los colapsa— pero la tabla "B2B por corredor" sigue
   listándolos crudos.
7. Que `zoho-sync` escriba `sync_state` en cada corrida: hoy solo lo hace el
   script Node y la tabla aparenta un sync caído con el pipeline sano
   (trampa 25).
8. **UI para editar `corredor_alias` a mano.** El auto-mapeo dejó 21 alias
   ambiguos (dos candidatos con el mismo parecido, no elige a ciegas) y 875 sin
   candidato. La tabla ya soporta `origen` = `manual` / `rechazado` y el
   auto-mapeo los respeta, pero hoy solo se tocan por SQL.
9. Cargar los meses de emisión anteriores si el sistema central los puede
   exportar: mientras solo haya un mes, los dos porcentajes de efectividad son
   un suelo (trampa 26).

**Vencimientos:** token de Kommo **2027-10-30** (ese día deja de crearse
cualquier lead). Refresh token de Zoho sin caducidad conocida, pero revocable.

---

## Cómo saber el estado ahora mismo

```sql
select * from public.estado_general;      -- totales, cortes, fallos 24h
select * from public.bitacora_reciente;   -- una fila por corrida del sync
select * from public.analytics_overview(now() - interval '30 days');
select * from public.system_logs order by created_at desc limit 50; -- kommo-webhook / process-inbound, 30 días
```

`sync_log` graba cada ejecución. Otras vistas: `kommo_sync_status`,
`meta_sync_status`, `kommo_duplicados` (debe estar vacía).

## Comandos

```bash
cd sync                       # requiere sync/.env (no versionado)
node --env-file=.env sync.mjs incremental        # el ciclo completo
node --env-file=.env sync.mjs kommo --dry-run    # ver payloads, no escribe
node --env-file=.env sync.mjs kommo-b2b --dry-run
node --env-file=.env sync.mjs meta --dry-run
node --env-file=.env sync.mjs kommo-init 2026-08-01T00:00:00Z   # mover el corte
node --env-file=.env limpiar-kommo.mjs --dry-run # etiquetar dups, arreglar tels
```

Migraciones del pipeline en `db/`; las del agente en `supabase/migrations/`,
aplicadas contra Supabase por Management API (`SUPABASE_ACCESS_TOKEN` /
`SUPABASE_PROJECT_REF` en `.env.local`). Tras cambiar una migración o función,
regenerar el bundle del wizard: `node web/scripts/embed-provision.mjs`.

Edge Functions: `npx supabase functions deploy <slug> --project-ref
"$SUPABASE_PROJECT_REF" --no-verify-jwt`. Managed Agent: `node
--env-file=.env.local --env-file=sync/.env scripts/provision-agent.mjs`
(idempotente; no reconfigura uno existente — eso se hace desde `/agent`).

---

## Trampas encontradas (no repetir el diagnóstico)

**Zoho / Kommo**

1. **Zoho no devuelve `modifiedTime` en el listado** de `/tickets`, solo en el
   detalle → el watermark es SIEMPRE `createdTime`. Costó un apagón de 3 días:
   `zoho-sync` filtraba el listado por `modifiedTime`, que al ser `undefined`
   daba 0, cortaba en el PRIMER ticket y sincronizaba cero, respondiendo
   `ok:true, upserted:0` cada 5 minutos sin un error. Por eso la respuesta
   ahora trae `watermark`/`nuevos_detectados`/`pendientes`: un cero silencioso
   no se distingue de "no había nada" si no dices contra qué comparaste. Los
   cambios de ESTADO (que el listado no permite filtrar) los cubre una segunda
   pasada que refresca los abiertos más rancios.
2. **La API de Kommo no borra leads** (`Allow: GET,POST,PATCH`). Limpiar =
   etiquetar y borrar desde la interfaz.
3. **`filter[tags][0][name]` no filtra fiable** — usar `filter[id][]=` o llevar
   el inventario en Supabase.
4. **Cédulas placeholder** (`V-00000000`, `12345678`, `124578963`) repetidas
   entre personas distintas → **toda identidad de cliente lleva `titular`**,
   nunca la cédula sola (`ticket_dedup_key()`, `zoho_cliente_key()`). Medido:
   `12345678` sola fusionaba 153 personas en un "cliente" con 241 cotizaciones.
5. **PostgREST corta en 1000 filas sin avisar**: ignora en silencio un `?limit=`
   mayor. Un "enriquecer 12.000" procesó 998 y dijo "listo". Paginar con `Range`.
6. **El endpoint de *tokens* de Zoho es mucho más estricto que la API de Desk**:
   varios workers refrescando a la vez disparan "too many requests" y bloquean
   todo un rato, sin error visible (falla al pedir el token, no el ticket).
   `sync/lib/zoho.mjs` comparte un refresco en vuelo con espera creciente.
7. **Teléfonos mezclados** → todo pasa por `lib/telefono.mjs`; lo que no encaja
   en un patrón venezolano se deja crudo a propósito.
8. **El `id` de Meta (`l:...`) es la mejor clave de idempotencia.**
9. **Renombrar una etapa en Kommo rompe el código en silencio.** Pasó:
    "cliente por atender" → "cliente por atender (atender)" y "AGENTE" →
    "AGENTE (no atender)" tumbaron el push B2C y `mover_etapa` sin un error.
    Nunca comparar nombres con `===`: usar `matchStagesByName()`
    (`supabase/functions/_shared/kommo.ts`), que va literal → normalizado →
    prefijo → contiene. El escalón literal importa: CONFIGURACIONES tiene dos
    etapas que solo se distinguen por acentos ("Apertura de códigos" /
    "APERTURA DE CODIGOS").
10. **Kommo exige `loss_reason_id` junto con `status_id`** en el mismo PATCH
    para marcar Perdido; solo da 400. Los estados 142 (Ganado) y 143 (Perdido)
    son globales, compartidos por todos los embudos.

**Agente / infraestructura**

11. `process-inbound` **NO lee el body del POST**: procesa `inbound_queue`
   (encolado por `kommo-webhook`). Para simular un mensaje hay que insertar en
   `inbound_queue` y luego invocar `process-inbound`.
12. Migraciones con `net.http_post(url := '${SUPABASE_URL}/...')`: sustituir
    `${SUPABASE_URL}` por la URL real al aplicar a mano.
13. `pg_cron` no tiene "cada N días desde una fecha ancla": se aproxima con
    `*/N` en día-del-mes; `DREAMS_LAST_RUN` compensa el hueco real.
14. El kill switch `agent_enabled` debe chequearse en **ambas**
    `process-inbound` y `generate-response` — si solo está en una, la otra
    sigue gastando con el agente "apagado".
15. **Cualquier emoji rompe un campo de texto de Kommo** (PATCH), no solo los
    compuestos: un 👋 truncó el mensaje en vivo.
16. **`EdgeRuntime.waitUntil()` para encadenar Edge Functions no es confiable**
    (la función encadenada nunca se disparó en cron real). Preferir crons
    independientes de `pg_cron`, cada uno con su red de seguridad.
17. **`DREAMS_DIGEST` es rolling**: borrar los dreams fuente NO borra lo ya
    consolidado. Una corrección dura requiere editar el digest directamente.
18. **Una función `immutable` llamada desde otra función o desde una vista
    necesita el esquema explícito** (`public.zoho_cedula(...)`): la definición
    se resuelve con el `search_path` de quien la crea, que no siempre incluye
    `public`. Falla con "function ... does not exist" aunque exista.
19. **Bug de FK ambigua (`drafts`↔`messages`)**: `publish-to-kommo`,
    `evaluate-outcomes` y `alerts-scan` tiraban 500 en cron por tener dos FKs
    entre esas tablas. Se resuelve con el hint `messages!drafts_message_id_fkey`.
20. **La API de Kommo no admite reactivar un webhook con PATCH** (`PATCH
    /api/v4/webhooks/{id}` → 404 "Cannot PATCH"). Un webhook `disabled` (o
    borrado) solo se repara con `DELETE` (por `destination`) + `POST` de
    nuevo con el mismo destino y `settings`. Automatizado en `alerts-scan`
    (ver "Webhook de Kommo → auto-sanado").
21. **`fetch(url, {redirect:"error"})` no sirve para adjuntos de Kommo**: el
    dominio de media (`amojo.kommo.com`) SIEMPRE redirige (2 saltos, hasta un
    bucket de GCS firmado) — con `redirect:"error"` la promesa se rechaza
    ante el primer 3xx. Para permitir el redirect sin abrir un hueco de SSRF,
    hay que seguirlo a mano con `redirect:"manual"`, validando CADA destino
    contra el mismo allowlist de hosts (ver `fetchAudioFollowingRedirects`).
22. **Whisper valida el formato de audio por la extensión del nombre del
    multipart, no por los bytes reales.** El `file_name` que reporta Kommo en
    el payload (`file.ogg`) no coincide con el archivo real servido (viene
    transcodeado, `content-type: audio/mp4`) → "Invalid file format" siempre.
    Hay que derivar la extensión de `content-disposition`/`content-type` de
    la respuesta real de descarga, nunca del nombre que reporta Kommo.
23. **Kommo devuelve 400 "Not enough rights" al hacer PATCH de custom_fields
    en un lead que YA está en Ganado (142) o Perdido (143)**, aunque el token
    sea de admin — no es un problema de permisos del token, es el estado del
    lead. `publish-to-kommo` lo detecta con `fetchLeadStage` antes de agotar
    los 3 reintentos (nunca iba a funcionar, el lead no se reabre solo).

24. **Un `ilike` contra NULL devuelve NULL, no `false`** — y entre dos filtros
    "inversos" eso abre un HUECO, no un solapamiento. El filtro B2C
    (`or=(asesor.ilike...)`) no matcheaba los `asesor` NULL y el B2B los
    excluía con `not.is.null`: los tickets sin asesor no calificaban para
    NINGÚN embudo y se quedaban sin lead para siempre (18 atascados, 4 ago →
    4 sep de 2026). El comentario del código se cuidaba del solapamiento y no
    del hueco. Arreglado con `asesor.is.null` en el filtro B2C. La misma
    trampa muerde al verificarlo en SQL: `not (asesor ilike ...)` también
    descarta las filas NULL, así que una consulta de control escrita así
    "demuestra" que no hay nada. Al revisar filtros complementarios, comprobar
    las DOS direcciones y que el total sea **exactamente** la suma de las
    partes.
25. **`sync_state` no refleja lo que hace el cron: solo lo escribe el script
    Node.** La Edge Function `zoho-sync` (la que corre en `pg_cron`) nunca
    toca la tabla, así que `last_incremental_sync` y `total_tickets` quedaron
    congelados en la última corrida de `sync/sync.mjs` (26-08) y aparentan un
    sync caído hace días con el pipeline perfectamente sano. Medir frescura
    con `max(tickets.synced_at)`, no con `sync_state`. Lo mismo, más leve, con
    `kommo_last_run`/`kommo_b2b_last_run`: `pushOne` sale temprano sin
    actualizarlos cuando no hay nada pendiente, así que en horas tranquilas se
    ven viejos aunque el job corra cada 5 min. Y ojo con `cron.job_run_details`:
    `succeeded` solo dice que el `net.http_post` se encoló, no que la Edge
    Function corriera — eso se confirma con `net._http_response`.

26. **Una ventana de "madurez" contra `now()` mide cualquier cosa menos lo que
    se cree.** La efectividad de corredores descartaba las cotizaciones de
    menos de 60 días para no castigar a las que aún no habían tenido tiempo de
    emitirse. Correcto en teoría; en la práctica dio **0,2%**, que parecía
    desempeño catastrófico y era un error de medición: con emisiones solo de
    agosto, las cotizaciones que produjeron esas emisiones son de julio y
    agosto — o sea de MENOS de 60 días — así que el filtro tiraba justo la
    evidencia. De las 342 cotizaciones que cruzaban con una emisión de agosto,
    solo 32 pasaban el corte. La madurez hay que anclarla a la **ventana de
    datos observada**, no a hoy: con emisiones en [D, H] solo es juzgable la
    cotización nacida entre `D - maduración` y `H`. Reanclada, la misma base da
    4,8%. Y aun así es un suelo mientras la ventana de cotizaciones (3 meses)
    sea más ancha que la de emisiones (1 mes) — por eso la respuesta trae
    `parcial: true` y el front lo dice con palabras. Regla general: antes de
    publicar un porcentaje, comprobar que el denominador PUEDA tener numerador.
27. **El CSV de emisiones tiene grano de RECIBO, no de póliza**, y viene en
    **ISO-8859-1**. Las 655 filas de agosto son 539 pólizas: una póliza puede
    llevar varias cuotas del mismo asegurado (`Recibo` es único y es la PK;
    `Certificado` vale 0 en todas y no sirve de clave). Contar filas en vez de
    pólizas infla el resultado un 21%. Los campos de póliza son constantes
    entre sus recibos y solo varían `prima_recibo`, `estatus_recibo` y
    `fecha_emision_recibo`, así que `v_polizas` colapsa con `min()`. Leerlo
    como UTF-8 destroza la cabecera (`Motivo_Anulación`) y el parser deja de
    reconocer las columnas; las fechas son `d/m/yyyy` y se convierten a ISO en
    el parser, nunca dejándoselas interpretar a Postgres.

---

## Cronología

- **07-08 → 19-08**: pipeline Zoho→Supabase→Kommo, dashboard, y agente "Sofi"
  integrado (Managed Agent + Memory Stores) verificado en modo sombra.
- **19-08 → 26-08**: **agente en vivo** end-to-end. Imágenes de trámites,
  multimedia (foto/PDF/audio), 3 verticales nuevas, Torre de Control, módulos
  `/analitica` e `/inbox` rehechos, pipeline pasado a `pg_cron`.
- **26-08 → 29-08**: endurecimiento. `marcar_perdido`, tono concreto,
  auto-sanado de etapa, reintentos de publicación, `matchStagesByName` tras
  descubrir que un rename había tumbado el push B2C, validador de KB con
  visión, `/analitica` corregida, 9.998 tickets enriquecidos y módulo
  `/pipeline` B2C/B2B con panel de analítica. Se descubrió que `zoho-sync`
  llevaba 3 días sin traer un ticket (trampa 1): corregido, 236 recuperados.
  Prueba de carga end-to-end (ver Rendimiento) que destapó y motivó la vista
  materializada.
- **06-09**: módulo de **efectividad de corredores**: carga mensual del
  Reporte de Emisión con preview, `corredor_alias` para colapsar el texto
  libre de Zoho en el código canónico, y los dos porcentajes (por cotizaciones
  y por clientes) declarados como suelo hasta tener más meses (trampas 26-27).
  La primera versión publicaba 0,2% por medir la madurez contra `now()`.
- **01-09 → 06-09**: auditoría de los tres crones del pipeline: sanos
  (288/288 corridas en 24h, 0 fallos), pero `sync_state` no lo reflejaba
  (trampa 25). Cerrado el hueco del `asesor` NULL (trampa 24): 18 tickets
  atascados migrados a `VENTAS B2C`.
- **29-08 → 01-09**: apagón del webhook de Kommo (trampa 20) y transcripción
  de audio rota al 100% (trampas 21-22), ambos arreglados con auto-sanado y
  recobro — 2 notas de voz reales atascadas se recuperaron. Auditoría de la
  Torre de Control: 9 de 15 alertas explicadas y reconocidas, incluyendo
  `publish-to-kommo` detectando leads cerrados/borrados (trampa 23); se
  quitó el webhook de salida de alertas (nunca se usó).
