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

- **System prompt: NO editable desde el dashboard** (solo lectura en
  `/agent`). Se cambia en `runtime_config.SYSTEM_PROMPT` o
  `agent-prompt-core.mjs`, y sincronizando con Anthropic.
- **Prohibido TODO emoji** (trampa 15): regla en el prompt +
  `sanitizeEmojiForKommo`. **Instagram y WhatsApp SÍ son canales seguros** para
  compartir cédula/teléfono/póliza (regla explícita tras un caso al revés).
- **Tono concreto**: no cierra con preguntas redundantes; al escalar dice que
  un asesor ya tiene el caso y ofrece allanar o cotizar. Clientes molestos van
  al correo de ATC.
- **Acciones de CRM** (`mover_etapa`, `marcar_perdido`, `enviar_imagen`,
  `actualizar_lead/contacto`) **corren contra Kommo real aunque "Publicar en
  Kommo" esté apagado**: ese interruptor solo gobierna los MENSAJES.
- **`marcar_perdido`**: manda a Perdido (143) empleo, spam y leads errados, con
  una de las 11 razones de Kommo (trampa 10).
- **Auto-sanado de etapa**: si se pierde un webhook `leads.status`,
  `process-inbound` consulta la etapa viva en Kommo antes de ignorar el lead
  (antes quedaba mudo para siempre).
- **`publish-to-kommo` reintenta** (3 veces) y **fusiona** `agent_metadata`;
  antes un error dejaba el draft `failed` para siempre y se perdían
  `session_id`/`tool_calls`/`model`/`vertical`. Dos casos son terminales de
  una: lead cerrado o borrado en Kommo (trampa 23).
- **Verticales**: 14 activas, cada una inyecta su `system_prompt`.
  Intermediarios-apertura-de-código mueve el lead a "Apertura de códigos" del
  pipeline CONFIGURACIONES (notifica por etapa, no por mensaje).
- **KB por vertical con validador obligatorio**: `prepare` extrae con visión
  (PDF como `document` base64, imagen como `image`), `verify` hace que un
  segundo modelo juzgue la extracción contra el original, e `ingest` solo
  guarda si pasa; si no, **bloquea y avisa**.
- **Dreams**: en español (forzado en system + reglas), frecuencia configurable
  desde `/dreams` con cron dinámico. Se listan en **tabla** ordenable por
  fecha/severidad/período/título, con buscador y paginación. El digest
  (`DREAMS_DIGEST`) es rolling: ver trampa 17.

### Dashboard

- **Torre de control**: la campana abre un panel que **desplaza** el contenido
  con alertas, Dreams, estado del agente, consumo y revisiones. `/alerts`
  standalone fue eliminado: la Torre es la única vista de alertas.
- **`/inbox`**: pestañas "Agente"/"Resto", badge "Transferido a humano", y una
  línea de tiempo con mensajes + cambios de etapa (`lead_stage_events`, los
  hechos a mano en Kommo incluidos) + imágenes del agente. Un cambio de etapa
  sin mensaje no toca `last_message_at`. **Favoritas** (`leads.favorited_at`,
  0068) con filtro y contador: la marca es **del equipo, no por usuario**.
- **`/analitica`**: funnel del agente vía `analytics_overview(p_since)`. El
  canal sale de `leads.channel`, o del `source` del primer mensaje; los leads
  sin conversación **se excluyen** en vez de caer en un "Otro" que llegó al
  79%, y lo no clasificado se reporta aparte en vez de esconderse.
- **`/pipeline`, dos pestañas**: "B2C / B2B por corredor" (por defecto) y
  "Embudo Zoho" (`?vista=embudo`). Lo B2B se lee por intermediario (tabla
  ordenable y paginada, con sus clientes al desplegar) más la efectividad; el
  botón **Analítica** abre el cajón de abajo. `moneda` y `ramo` están vacías al
  100% en Zoho: no se grafican a propósito. Fuente: `zoho_pipeline_overview()`,
  `zoho_corredor_detalle()` y `zoho_pipeline_analitica()` (0064-0066) sobre la
  materializada **`mv_zoho_clasificacion`** (0067), refrescada por cron un
  minuto después del sync — sin ella cada carga recalculaba los regex fila por
  fila. Datos al 06-09 (15.055 tickets no-spam): **B2C 2.649 · B2B 12.286 · sin
  atribución 120**, 1.163 corredores y ~11.000 clientes finales.
- **`/verticales`**: columna **Mensajes · 7d · %** con lo que el clasificador ha
  metido en cada vertical (`verticales_uso()`, 0078; el dato es
  `messages.vertical_id`). El pie **reconcilia**, que es lo que evita leer la
  suma como si faltaran registros: 611 entrantes = clasificados + ignorados a
  propósito (etapa del lead o media off, nunca llegan al clasificador) +
  fallidos. Una vertical sin uso muestra "—", no "0": lo segundo se leería como
  "se evaluó y nunca encajó".

### Alertas abiertas

**18 abiertas al 06-09** (eran 23): **16 `human_review_needed`** del 26/08 al
04/09 — gap de **proceso**, no de código: requieren un humano en Kommo (incluye
Andrea, queja de reembolso desde el 26/08, y 5 de Andrés Ramírez del 27/08). Y
**2 `dream_error`**: uno es el agente asumiendo datos no dichos por la clienta
(corregido en el prompt, pendiente de sincronizar — PENDIENTE 12) y el otro son
errores HMAC **en la app del cliente**, no en este sistema.

Las otras 5 se cerraron el 06-09 con su causa arreglada: 2 `inbound_silence`
rancias, 2 `outcomes_regression` que eran ruido (trampa 31) y 1 `draft_failed`
por respuesta vacía (trampa 32). **Sin webhook de salida** (`alert_config`,
Slack/Discord): nunca se usó, la `0070` tiró la tabla. Las alertas viven solo en
la Torre, que filtra por `acknowledged_at is null`, **no** por `status`.

**Se auto-resuelven** cuando su causa desaparece, en vez de quedarse en rojo:
`provider_credit_exhausted` (llegó consumo nuevo) e `inbound_silence` (entró un
evento a `inbound_queue` tras la alerta). `detectOutcomesRegression` exige 20
muestras y significancia (trampa 31), y para `lead_replied` ignora la caída si
el inbound se desplomó (>50%): ese grader depende del volumen, no de la
calidad.

### Webhook de Kommo → auto-sanado

Kommo deshabilita el webhook cuando le falla sostenido (el 29/08: ~40h mudo,
con `inbound_silence` avisando desde el 28/08 sin que nadie la atendiera).
`alerts-scan` (cada 5 min) chequea el estado real contra la API y lo recrea
solo si está `disabled` o no existe, sin esperar a un humano (el cómo, en la
trampa 20). Si falla reintenta cada 20 min indefinidamente — cooldown solo
sobre la escritura. Avisa con `kommo_webhook_reconnected` / `..._failed`.

### Bitácora propia (`system_logs`)

El Log Drain oficial cuesta $60/mes — descartado. En su lugar, tabla propia
`system_logs` (0069; retención en `runtime_config`, 30 días, con cron de
limpieza) + `_shared/system-log.ts` (`logEvent`, fail-soft), instrumentada a
mano en `kommo-webhook` y `process-inbound`. No cubre Postgres/Auth/HTTP: es
instrumentación puntual de los dos puntos que ya mordieron.

### Transcripción de notas de voz (Whisper)

Estaba rota al 100%, no de forma intermitente — diagnóstico en las trampas
21-22. Arreglado. Además el recobro automático ya reintenta audio (antes solo
imagen/documento) y la transcripción se persiste en `messages.content` con
prefijo 🎙️; antes solo servía para clasificar ESE mensaje y el historial se
quedaba con el placeholder `[Audio ...]` para siempre.

### Pipeline Zoho → Kommo

Automatizado con **`pg_cron` de Supabase** (GitHub Actions quedó solo con
`workflow_dispatch`). Jobs: `zoho-sync-incremental`, `zoho-kommo-push-safety`
(red de seguridad independiente) y `zoho-refrescar-clasificacion`.

```
pg_cron   1. Zoho Desk  ──▶ Supabase (tickets)
          2. Supabase   ──▶ Kommo  [B2C: VENTAS B2C | B2B: DATA ZOHO DESK]
          3. Hoja Drive ──▶ Supabase (meta_leads) ──▶ Kommo [MetaAds]
```

**Zoho es incremental** (watermark `max(created_time)`, trampa 1); **Drive se
relee completo**. **Anti-duplicados:** `kommo_lead_id is not null` = ya
enviado, más `tickets_ya_en_kommo()`, dedupe dentro del lote y
`meta_leads_solapados()`; la clave es `asunto + contacto + titular`
(`ticket_dedup_key()`).

**Filtro B2C:** van a `VENTAS B2C` los tickets con `Asesor` **NULL/vacío**
(cliente sin corredor) o "No tengo" / "Sin Asesor" / "Sin Asesor (KG)" /
"Seguros Venezuela" / "Directo Caracas" / "No Posee" (`ilike`). **B2B:** el
resto, a "DATA ZOHO DESK". Tienen que ser **partición exacta**: un hueco deja
tickets sin empujar para siempre (trampa 24) y un solapamiento duplica el lead.
Viven en **dos runtimes que se tocan juntos**:
`supabase/functions/zoho-kommo-push/index.ts` y `sync/lib/supa.mjs`.

`zoho_destino(asesor)` conserva **a propósito** un tercer valor,
`sin_atribucion`, para los NULL: en Kommo van a B2C, pero `/pipeline` los cuenta
aparte porque no hay corredor al que atribuirlos (PENDIENTE 6). Routing y
reporte difieren ahí deliberadamente.

### Efectividad de corredores (cotizado vs. emitido)

En `/pipeline` → "B2C / B2B por corredor". Cruza las cotizaciones de Zoho con
las pólizas emitidas, que llegan en un **CSV mensual del sistema central** que
el operador sube desde el dashboard ("Cargar emisiones": preview primero,
escritura solo al confirmar). Migraciones 0071-0076; parser en
`web/src/lib/emisiones.ts`, rutas en `/api/pipeline/{emisiones,alias}`.

- **Cliente por cédula**, tomador **o** asegurado (son personas distintas en
  muchas pólizas). `zoho_cedula()` la saca del asunto en el 99,8% de los
  tickets B2B; con agosto machean 225 de 539 pólizas.
- **Corredor por `corredor_alias`**, que liga el texto libre de Zoho al
  `Cod_Intermediario` canónico. Es lo que arregla el recuento: las 12
  escrituras de "BARECA" (typo `CORETAJE` incluido) colapsan en una.
  `zoho_mapear_corredores()` propone (258 de 1.163) exigiendo una palabra poco
  común compartida (trampa 28) y respeta lo `manual`/`rechazado`. Lo ambiguo se
  cierra a mano en **Revisar corredores**.
- **La emisión se acredita al intermediario del sistema central**, no al asesor
  del ticket: cuando difieren suele ser persona vs. empresa ("MARSH VENEZUELA
  CA..." vs. "MANUEL LOBATON"). **Anuladas no cuentan** como cierre (agosto:
  460 vigentes / 79 anuladas).
- Los **dos porcentajes** (por cotizaciones y por clientes) son un **suelo
  declarado**: trampa 26. Con solo agosto dan 4,8% y 4,1%. La fiable hoy es la
  inversa: de lo emitido, cuánto venía de una cotización (35,6%).
- **17 tests e2e** (`web/e2e/`) cubren render, avisos, tabla, carga, alias,
  pestañas y la columna de verticales. El fixture de carga es **sintético a
  propósito**: el repo es público y el real lleva cédulas y teléfonos reales.

### Panel de analítica de `/pipeline`

Cajón **flotante** por la derecha, mitad de pantalla, fondo oscurecido (antes
desplazaba el contenido y eso ataba su ancho al de la columna: ~600px, poco
para el cruce plan×edad). Tres pestañas por **origen del dato**, que es lo que
evita sumar cosas incomparables: **Cotizaciones** (`zoho_pipeline_analitica()`,
0066), **Emisiones** (`zoho_emisiones_analitica()`, 0077: cartera, suscripción
por día, suma asegurada, plan de pago, beneficiarios, anulaciones por plan y
por corredor, canal, y los 12 que más facturan con su comisión) y
**Efectividad** (el cruce, más el desfase cotizar→emitir: mediana 9 d, p90 44,
máx 138 sobre 192 pólizas).

Las comisiones van con desglose por corredor, por decisión del operador. No
están la fecha ni el motivo real de anulación porque el CSV no los trae (ver
cabecera de la 0077), y ojo con `Prima_Anual`, que no es anual: trampa 29.

### Rendimiento medido (2026-08-29)

15 conversaciones simultáneas + 4 usuarios navegando: **15/15 respondidas, 0
errores, $0,51**. Publicado p50 139s / p95 186s, y el grueso NO es el modelo
sino el cron de `process-inbound` (hasta 60s) más `response_debounce_seconds=45`
(`generate_response` tardó 19,9s bajo carga: la concurrencia no lo degrada). Web
p50 122ms / p95 165ms en 4.902 peticiones; producción p50 ~500ms y `/pipeline`
bajó de 1.500-1.800ms a 765-810ms con la vista materializada. Netlify devuelve
403 tras ~66 cargas seguidas (rate limiting propio).

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
6. Limpiar en Zoho: los 120 tickets con `Asesor` vacío (ya migran a B2C pero
   siguen sin corredor atribuible), las 166 cotizaciones con `Asesor` = "si
   tengo" y otros valores que no son un corredor (entran a B2B y ensucian el
   conteo). La tabla "B2B por corredor" sigue listando los nombres crudos,
   aunque la efectividad ya los colapsa con `corredor_alias`.
7. Que `zoho-sync` escriba `sync_state` en cada corrida: hoy solo lo hace el
   script Node y la tabla aparenta un sync caído con el pipeline sano
   (trampa 25).
8. Revisar los **905 corredores sin ligar** en "Revisar corredores" (9 ambiguos
   + 896 sin candidato). Casi todos no emitieron en los meses cargados y se
   ligarán solos; empezar por los de más volumen, que es el orden del panel.
9. **Pedir al sistema central los meses de emisión anteriores**, y si se puede
   la fecha y el motivo real de anulación (hoy no vienen — trampa 29 y cabecera
   de la 0077). Con un solo mes, los dos porcentajes son un suelo (trampa 26).
10. **Borrar el usuario de prueba** `prueba.e2e@segurosvenezuela.com` (editor)
   cuando no se necesite. Credenciales en `web/.env.local`, no versionado.
11. Atender en Kommo las **16 alertas `human_review_needed`** (26/08 - 04/09) y
   las 3 conversaciones que el agente dejó sin respuesta por devolver vacío
   (trampa 32), ya marcadas para revisión.
12. **Sincronizar el prompt** desde `/agent` para activar la regla nueva de
   `agent-prompt-core.mjs` ("no des por supuesto ningún dato que el lead no
   haya dicho"). El CORE_SCAFFOLD vive en el Managed Agent y solo se actualiza
   con `syncAgentTools()`, que empuja prompt **y** tools: por eso no se disparó
   sin revisar antes que las tools de la DB coincidan con las del agente vivo.

**Vencimientos:** token de Kommo **2027-10-30** (ese día deja de crearse
cualquier lead). Refresh token de Zoho sin caducidad conocida, pero revocable.

---

## Estado y comandos

```sql
-- OJO: la frescura del sync se mide con max(tickets.synced_at), NO con
-- sync_state, que solo lo escribe el script Node (trampa 25).
select * from public.estado_general;      -- totales, cortes, fallos 24h
select * from public.bitacora_reciente;   -- una fila por corrida del sync
select * from public.analytics_overview(now() - interval '30 days');
select * from public.system_logs order by created_at desc limit 50;
```

Otras vistas: `sync_log`, `kommo_sync_status`, `meta_sync_status` y
`kommo_duplicados` (debe estar vacía; hoy tiene 64 grupos por borrar, trampa 2).

```bash
cd sync                                          # requiere sync/.env
node --env-file=.env sync.mjs incremental        # el ciclo completo
node --env-file=.env sync.mjs kommo --dry-run    # ver payloads, no escribe
#   ...igual con kommo-b2b y meta
node --env-file=.env sync.mjs kommo-init 2026-08-01T00:00:00Z   # mover el corte
node --env-file=.env limpiar-kommo.mjs --dry-run # etiquetar dups, arreglar tels
cd ../web && npx playwright test                 # los 17 e2e
```

Migraciones del pipeline en `db/`; las del agente y emisiones en
`supabase/migrations/`, aplicadas por Management API (`SUPABASE_ACCESS_TOKEN` /
`SUPABASE_PROJECT_REF` en `.env.local`). Tras tocar una migración o función,
regenerar el bundle: `node web/scripts/embed-provision.mjs`. Edge Functions:
`node scripts/deploy-agent-functions.mjs <slug>`. Managed Agent:
`scripts/provision-agent.mjs` (idempotente; NO reconfigura uno existente — eso
se hace desde `/agent`, y es lo que empuja el prompt).

---

## Trampas encontradas (no repetir el diagnóstico)

**Zoho / Kommo**

1. **Zoho no devuelve `modifiedTime` en el listado** de `/tickets`, solo en el
   detalle → el watermark es SIEMPRE `createdTime`. Costó un apagón de 3 días:
   al filtrar por `modifiedTime` (que llegaba `undefined`) cortaba en el PRIMER
   ticket y respondía `ok:true, upserted:0` cada 5 min sin un error. Por eso la
   respuesta trae `watermark`/`nuevos_detectados`/`pendientes`: un cero
   silencioso no se distingue de "no había nada" si no dices contra qué
   comparaste. Los cambios de ESTADO los cubre una segunda pasada.
2. **La API de Kommo no borra leads** (`Allow: GET,POST,PATCH`): etiquetar y
   borrar desde la interfaz.
3. **`filter[tags][0][name]` no filtra fiable** — usar `filter[id][]=`.
4. **Cédulas placeholder** (`V-00000000`, `12345678`) repetidas entre personas
   distintas → **toda identidad de cliente lleva `titular`**, nunca la cédula
   sola. Medido: `12345678` fusionaba 153 personas en un "cliente".
5. **PostgREST corta en 1000 filas sin avisar** e ignora un `?limit=` mayor: un
   "enriquecer 12.000" procesó 998 y dijo "listo". Paginar con `Range`.
6. **El endpoint de *tokens* de Zoho es más estricto que la API de Desk**:
   varios workers refrescando a la vez disparan "too many requests" sin error
   visible (falla al pedir el token, no el ticket). `sync/lib/zoho.mjs` comparte
   un refresco en vuelo con espera creciente.
7. **Teléfonos mezclados** → todo pasa por `lib/telefono.mjs`; lo que no encaja
   en patrón venezolano se deja crudo a propósito.
8. **El `id` de Meta (`l:...`) es la mejor clave de idempotencia.**
9. **Renombrar una etapa en Kommo rompe el código en silencio.** "cliente por
    atender" → "cliente por atender (atender)" tumbó el push B2C y
    `mover_etapa` sin un error. Nunca comparar con `===`: usar
    `matchStagesByName()` (`_shared/kommo.ts`), que va literal → normalizado →
    prefijo → contiene. El escalón literal importa: CONFIGURACIONES tiene dos
    etapas que solo se distinguen por acentos.
10. **Kommo exige `loss_reason_id` junto con `status_id`** en el mismo PATCH
    para marcar Perdido; solo da 400. Los estados 142 (Ganado) y 143 (Perdido)
    son globales, compartidos por todos los embudos.

**Agente / infraestructura**

11. `process-inbound` **NO lee el body del POST**: procesa `inbound_queue`
   (encolado por `kommo-webhook`). Para simular un mensaje, insertar ahí.
12. Migraciones con `net.http_post(url := '${SUPABASE_URL}/...')`: sustituir
    `${SUPABASE_URL}` por la URL real al aplicar a mano.
13. `pg_cron` no tiene "cada N días desde una fecha ancla": se aproxima con
    `*/N` en día-del-mes y `DREAMS_LAST_RUN` compensa el hueco.
14. El kill switch `agent_enabled` se chequea en **ambas** `process-inbound` y
    `generate-response`: si solo está en una, la otra sigue gastando.
15. **Cualquier emoji rompe un campo de texto de Kommo** (PATCH), no solo los
    compuestos: un 👋 truncó un mensaje en vivo.
16. **`EdgeRuntime.waitUntil()` para encadenar Edge Functions no es confiable**
    (la encadenada nunca se disparó en cron real). Preferir crons
    independientes de `pg_cron`, cada uno con su red de seguridad.
17. **`DREAMS_DIGEST` es rolling**: borrar los dreams fuente NO borra lo
    consolidado; hay que editar el digest.
18. **Una función `immutable` llamada desde otra función o vista necesita el
    esquema explícito** (`public.zoho_cedula(...)`): se resuelve con el
    `search_path` de quien la crea. Falla con "does not exist" aunque exista.
19. **FK ambigua (`drafts`↔`messages`)**: tres funciones tiraban 500 en cron
    por tener dos FKs entre esas tablas. Se resuelve con el hint
    `messages!drafts_message_id_fkey`.
20. **La API de Kommo no admite reactivar un webhook con PATCH** (→ 404
    "Cannot PATCH"). Un webhook `disabled` o borrado solo se repara con
    `DELETE` (por `destination`) + `POST` con el mismo destino y `settings`.
    Automatizado en `alerts-scan`.
21. **`fetch(url, {redirect:"error"})` no sirve para adjuntos de Kommo**:
    `amojo.kommo.com` SIEMPRE redirige (2 saltos hasta un bucket de GCS
    firmado). Para permitirlo sin abrir un hueco de SSRF hay que seguirlo a
    mano con `redirect:"manual"`, validando CADA destino contra el allowlist
    de hosts (`fetchAudioFollowingRedirects`).
22. **Whisper valida el formato de audio por la extensión del nombre del
    multipart, no por los bytes.** El `file_name` de Kommo (`file.ogg`) no
    coincide con el archivo real (viene transcodeado, `audio/mp4`) → "Invalid
    file format" siempre. La extensión se deriva del `content-disposition` /
    `content-type` de la descarga real, nunca del nombre que reporta Kommo.
23. **Kommo da 400 "Not enough rights" al hacer PATCH de custom_fields en un
    lead que YA está en Ganado (142) o Perdido (143)**, aunque el token sea de
    admin: no es permisos, es el estado del lead. `publish-to-kommo` lo detecta
    con `fetchLeadStage` antes de agotar los 3 reintentos.

24. **Un `ilike` contra NULL devuelve NULL, no `false`** — y entre dos filtros
    "inversos" eso abre un HUECO, no un solapamiento. El B2C no matcheaba los
    `asesor` NULL y el B2B los excluía con `not.is.null`: los tickets sin asesor
    no calificaban para NINGÚN embudo y se quedaban sin lead para siempre (18
    atascados, 4 ago → 4 sep). La misma trampa muerde al verificarlo: `not
    (asesor ilike ...)` también descarta las filas NULL, así que la consulta de
    control "demuestra" que no hay nada. Comprobar las DOS direcciones, y que el
    total sea **exactamente** la suma de las partes.
25. **`sync_state` no refleja lo que hace el cron: solo lo escribe el script
    Node.** La Edge Function `zoho-sync` (la del `pg_cron`) nunca toca la tabla,
    así que `last_incremental_sync` y `total_tickets` se congelaron en la última
    corrida de `sync/sync.mjs` (26-08) y aparentan un sync caído con el pipeline
    sano. Medir frescura con `max(tickets.synced_at)`. Igual con
    `kommo_last_run`: `pushOne` sale temprano sin actualizarlo si no hay nada
    pendiente. Y `cron.job_run_details.succeeded` solo dice que el `http_post`
    se encoló, no que la función corriera: eso es `net._http_response`.

26. **Una ventana de "madurez" contra `now()` mide cualquier cosa menos lo que
    se cree.** La efectividad descartaba las cotizaciones de menos de 60 días
    para no castigar a las que aún no podían haberse emitido. En la práctica
    dio **0,2%**: con emisiones solo de agosto, las cotizaciones que las
    produjeron son de julio y agosto — MENOS de 60 días — así que el filtro
    tiraba justo la evidencia (de 342 que cruzaban, solo 32 pasaban el corte).
    La madurez se ancla a la **ventana de datos observada**: con emisiones en
    [D, H] solo es juzgable lo nacido entre `D - maduración` y `H`. Reanclada da
    4,8%, y sigue siendo un suelo mientras la ventana de cotizaciones sea más
    ancha que la de emisiones (de ahí `parcial: true`). Regla general: antes de
    publicar un porcentaje, comprobar que el denominador PUEDA tener numerador.
27. **El CSV de emisiones tiene grano de RECIBO, no de póliza**, y viene en
    **ISO-8859-1**. Las 655 filas de agosto son 539 pólizas (varias cuotas del
    mismo asegurado; `Recibo` es la PK, `Certificado` vale 0 en todas): contar
    filas infla el resultado un 21%. Los campos de póliza son constantes entre
    sus recibos y solo varían `prima_recibo`, `estatus_recibo` y
    `fecha_emision_recibo`, así que `v_polizas` colapsa con `min()`. Leerlo como
    UTF-8 destroza la cabecera y el parser deja de reconocer las columnas; las
    fechas `d/m/yyyy` se pasan a ISO en el parser, no en Postgres.

28. **Emparejar nombres por palabras compartidas necesita ponderar por rareza,
    o empareja gente distinta.** "JOSE SAYEGH" salía al 50% con "ALBERTO JOSE
    MEJIAS URRIBARRI" por compartir solo "JOSE", que está en 27 de los 174
    intermediarios (15,5%); y el auto-mapeo había ligado "JOSE GARCIA" a
    "ATILIO JOSE ROSALES GARCIA" con score 1,0. Un alias equivocado es PEOR que
    ninguno: acredita a un corredor las pólizas de otro y el número parece
    bueno. Arreglado exigiendo una palabra compartida presente en 3
    intermediarios o menos (`zoho_tokens_comunes()`), calculada sobre la tabla
    y no con una lista fija que envejecería. El trigram se conserva: compara el
    nombre ENTERO y rescata los casos donde todas las palabras son comunes. De
    los 267 alias, 258 siguieron valiendo; los 9 restantes eran 3 cierres mal
    atribuidos.

29. **`Prima_Anual` del Reporte de Emisión no es una prima anual.** Es lo
    FACTURADO de esa póliza en el archivo: `prima_anual / suma(prima_recibo de
    la póliza)` da **1,000 exacto** en todos los grupos, por plan de pago y por
    número de recibos. Se detectó porque el panel mostraba "prima media" de
    $135 en plan Mensual y $1.018 en Anual — un 7,5× que parecía un hallazgo
    de negocio y era un artefacto: una póliza mensual suscrita en agosto lleva
    facturado 1-2 meses y una anual el año entero. A igual suma asegurada
    ($50.000) vale 130 en Mensual y 730 en Anual. Conclusión: el campo es
    redundante con `sum(prima_recibo)` y **no se puede comparar entre planes de
    pago**; todo el dinero del módulo sale de `prima_recibo`, que se llama como
    lo que es. Regla general: antes de publicar una media, comprobar que el
    denominador cubra la misma ventana en todos los grupos.

30. **Un tope de reintentos que no distingue de quién es la culpa condena
    mensajes sanos.** `process-inbound` reintenta 5 veces y luego pone el
    prefijo `recover:`, que saca el mensaje de la cola PARA SIEMPRE (el tope
    existe por algo: sin él, un mensaje imposible quema Haiku cada minuto).
    Pero contaba igual los fallos que NO son del mensaje: del 15 al 19 de agosto
    la cuenta se quedó sin saldo, los 5 intentos se gastaron contra ese 400 y
    **102 mensajes (17% del total) quedaron sin clasificar para siempre**.
    Arreglado con `esFalloDeCuenta()`: sin saldo, 429, 5xx, timeouts y auth no
    gastan intento — es seguro reintentar indefinidamente porque mientras dura
    el corte fallan todos (no hay coste) y al resolverse la cola se drena sola.
31. **Una alerta de "regresión" con 6 muestras es ruido, no una señal.** El
    detector comparaba el promedio de 24h contra el de los 6 días previos con
    un mínimo de solo 5 muestras, y disparó una alerta de "caída 69%" con n=6
    contra un baseline de n=96 (o sea 6 casos contra 16 diarios). Un grader no
    evalúa a diario: pocas muestras significa "ventana no representativa", no
    "el agente empeoró". Ahora exige **20 muestras** y que la caída supere **2
    errores estándar** de la diferencia (~95%). Con eso, 0,455 (n=22) contra
    0,667 (n=60) tampoco alerta: la caída es 0,212 y el margen 0,245. Para
    calcularlo hay que acumular la suma de cuadrados, no solo la suma.
32. **El agente devuelve texto vacío de vez en cuando, y eso dejaba la
    conversación muerta.** Pasó 3 veces (26/08 x2, 06/09) y en las TRES el lead
    se quedó sin respuesta (`respuestas_posteriores = 0`): el draft se marcaba
    `failed` de una, sin reintento, y la alerta no era accionable. Ahora se
    reintenta UNA vez —solo si se han gastado menos de 100s, porque una corrida
    son 60-80s y dos pueden pasarse del límite del runtime— y si vuelve vacío
    los mensajes pasan a `requires_human_review`, que sí pone el caso en la
    cola de un asesor.

---

## Cronología

- **07-08 → 19-08**: pipeline Zoho→Supabase→Kommo, dashboard y agente "Sofi"
  (Managed Agent + Memory Stores) verificado en modo sombra.
- **19-08 → 26-08**: **agente en vivo**. Multimedia, 3 verticales, Torre de
  Control, `/analitica` e `/inbox` rehechos, pipeline pasado a `pg_cron`.
- **26-08 → 29-08**: endurecimiento. `marcar_perdido`, auto-sanado de etapa,
  reintentos de publicación, `matchStagesByName` (un rename había tumbado el
  push B2C), validador de KB con visión, 9.998 tickets enriquecidos y módulo
  `/pipeline` B2C/B2B. Se descubrió que `zoho-sync` llevaba 3 días sin traer un
  ticket (trampa 1): 236 recuperados. La prueba de carga motivó la vista
  materializada.
- **29-08 → 01-09**: apagón del webhook de Kommo (trampa 20) y transcripción de
  audio rota al 100% (trampas 21-22), arreglados con auto-sanado y recobro.
  Auditoría de la Torre: 9 de 15 alertas explicadas; se quitó el webhook de
  salida de alertas.
- **01-09 → 06-09**: los tres crones del pipeline auditados y sanos (288/288 en
  24h), pero `sync_state` no lo reflejaba (trampa 25). Cerrado el hueco del
  `asesor` NULL (trampa 24): 18 tickets migrados a `VENTAS B2C`.
- **06-09**: módulo de **efectividad de corredores** (carga mensual con
  preview, `corredor_alias`, dos porcentajes declarados como suelo — trampas
  26-27; la primera versión daba 0,2% por medir la madurez contra `now()`),
  panel **Revisar corredores** con ponderación por rareza (trampa 28, 9 alias
  mal atribuidos limpiados), analítica de emisiones en **cajón flotante con
  tres pestañas** (trampa 29: `Prima_Anual` no es anual) y **15 tests e2e** con
  Playwright contra el Supabase real. De paso, `zoho_alias_pendientes()` de
  1,77 s a 0,12 s y `zoho_corredores_efectividad()` de 2,5 s a 0,15 s.
