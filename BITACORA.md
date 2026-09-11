# Bitácora del proyecto

Qué se hizo, dónde quedó y qué falta. **Leer esto primero** al retomar.

> **Regla para actualizar** (sesión humana o agente): leer el archivo completo
> antes de escribir. **Fusionar**, nunca agregar una sección que repita o
> contradiga otra; si un dato cambió, **reemplazarlo**. Cifras e IDs van en
> "Estado actual"; las trampas no se repiten arriba.
>
> **Tope: 700 líneas** (era 500 hasta el 07-09). Existe porque un archivo más
> largo no se lee completo. Más margen NO es permiso para rellenar: el espacio
> extra es para el diagnóstico de las trampas, no para decir dos veces lo mismo.

- **Repo:** `Boosty-Hub/seguros-venezuela` (público), rama `main`
- **Supabase:** `lwqqnnefywsjaatuyjma`
- **Kommo:** `segurosvenezuelait.kommo.com` (cuenta 36827351)
- **Dashboard:** https://segurosvenezuela.netlify.app (Next.js en `web/`,
  deploy automático desde `main`; local con `pnpm dev`). El pipeline Zoho está
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
  compartir cédula/teléfono/póliza: se acepta todo lo que manden por ahí y NO se
  ofrece la llamada como alternativa "más segura" (un dream lo había derogado,
  trampa 36). Un teléfono o un correo se dan **una vez por conversación**.
- **Reja antes de enviar** (trampa 35): `revisarMensajeFinal()` corre al cerrar
  el turno y otra vez en `publish-to-kommo`. Una **fuga** vuelve al agente para
  que la rehaga (2 vueltas, `correcciones_mensaje`); un **silencio** no envía
  nada, y para callar a propósito emite `<respuesta></respuesta>` vacío.
- **Tono concreto**: no cierra con preguntas redundantes; al escalar dice que
  un asesor ya tiene el caso y ofrece allanar o cotizar. Clientes molestos van
  al correo de ATC, **salvo que lo que no llegó sea una cotización**: eso es una
  venta viva y tiene sección propia en el prompt desde el 09-09 (trampa 37).
- **Acciones de CRM** (`mover_etapa`, `marcar_perdido`, `enviar_imagen`,
  `actualizar_lead/contacto`) **corren contra Kommo real aunque "Publicar en
  Kommo" esté apagado**: ese interruptor solo gobierna los MENSAJES.
- **`marcar_perdido`**: manda a Perdido (143) empleo, spam y leads errados, con
  una de las 11 razones de Kommo (trampa 10). **Auto-sanado de etapa**: si se
  pierde un webhook `leads.status`, `process-inbound` consulta la etapa viva en
  Kommo antes de ignorar el lead.
- **`publish-to-kommo` reintenta** (3 veces) y **fusiona** `agent_metadata`,
  que antes se perdía al fallar. Dos casos son terminales de una: lead cerrado
  o borrado en Kommo (trampa 23).
- **Verticales**: 14 activas, cada una inyecta su `system_prompt`. La de
  intermediarios mueve el lead a "Apertura de códigos" (notifica por etapa).
- **KB por vertical: la ingesta es una COLA, no una petición web** (0080). El
  navegador sube al bucket y encola; el resto son dos Edge Functions con cron
  cada minuto (`kb-transcribe`, `kb-assemble`): un condicionado escaneado son
  minutos de visión y Netlify corta a los 26s. Va en **tandas de ~10 páginas**
  (`KB_PAGINAS_POR_TANDA`), que es lo que mete cada llamada dentro del wall
  clock, del tope de páginas del modelo (100 Haiku / 600 Sonnet) y de su
  contexto, y anula el tope de 20MB por documento. Un PDF con capa de texto sana
  no gasta un token (detectarlo costó la trampa 38). **Nada entra sin control**:
  cada tanda la juzga un segundo modelo contra SUS páginas —y se reprocesa sola,
  no el documento—, y al ensamblar se juzga la vertical (equivocada BLOQUEA; con
  reparos va a revisión). Extracción SOLO en `_shared/kb-extract.ts`: trampa 24.
- **Dreams**: en español, frecuencia configurable desde `/dreams` con cron
  dinámico, listados en **tabla** ordenable con buscador y paginación. El digest
  (`DREAMS_DIGEST`) es rolling: ver trampa 17. **Las reglas del operador viajan
  al destilador y al consolidador**, y una segunda pasada audita el digest
  contra ellas: un aprendizaje NO puede derogar una regla dura (trampa 36).

### Dashboard

- **Torre de control**: la campana abre un panel que **desplaza** el contenido
  con alertas, Dreams, agente, consumo y revisiones (es la única vista de alertas).
- **`/inbox`**: contador de mensajes por conversación (cliente + agente, con el
  desglose en el `title`). `messages` solo guarda entrantes; las respuestas del
  agente son `drafts` en `auto_sent` (un `failed` nunca llegó al cliente).
  Pestañas "Agente"/"Resto", badge "Transferido a humano", línea de tiempo con
  `lead_stage_events` e imágenes, y **Favoritas** (0068, del equipo).
- **`/analitica`**: funnel del agente vía `analytics_overview(p_since)`. El
  canal sale de `leads.channel` o del `source` del primer mensaje; los leads sin
  conversación **se excluyen** en vez de caer en un "Otro" que llegó al 79%.
- **`/pipeline`, dos pestañas**: "B2C / B2B por corredor" (por defecto) y
  "Embudo Zoho" (`?vista=embudo`). Lo B2B se lee por intermediario (tabla
  ordenable y paginada) más la efectividad; **Analítica** abre el cajón (su
  sección, más abajo). `moneda` y `ramo` están vacías al 100% en Zoho: no se
  grafican. Fuente: `zoho_pipeline_overview()` y `zoho_corredor_detalle()`
  sobre la materializada **`mv_zoho_clasificacion`** (0067), refrescada por
  cron un minuto después del sync — sin ella cada carga recalculaba los regex
  fila por fila. Datos al 06-09 (15.055 tickets no-spam): **B2C 2.649 · B2B
  12.286 · sin atribución 120**, 1.163 corredores y ~11.000 clientes finales.
- **Filtro de periodo** (0081), en las dos pestañas y en la analítica: atajos
  (hoy / 7 / 30 días / este mes / mes pasado) más inicio y fin, en la URL
  (`?desde&hasta`, inclusivas) para sobrevivir a un F5 y pasarse por link. Las
  RPC ya tenían `p_since`; la 0081 suma `p_hasta` y crea `zoho_embudo_resumen()`
  porque las vistas del embudo no se pueden acotar. El corte va `>= desde`,
  `< hasta` y anclado a **UTC-4**: con UTC "hoy" empezaría a las 8pm de ayer.
  En **emisiones** hay además chips por **mes de suscripción** con lo cargado en
  cada uno (`emisiones_periodos()`, 0083), que rellenan ese mismo rango en vez
  de ser un segundo filtro — dos filtros de fecha en una pantalla es como se
  acaba leyendo un número creyendo que es otro.
- **`/verticales`**: columna **Mensajes · 7d · %** con lo que el clasificador
  metió en cada vertical (`verticales_uso()`, 0078). El pie **reconcilia**, que
  evita leer la suma como si faltaran registros: 611 entrantes = clasificados +
  ignorados a propósito (etapa del lead o media off) + fallidos. Una vertical
  sin uso muestra "—", no "0", que se leería como "se evaluó y nunca encajó".

### Alertas abiertas

**2 abiertas al 07-09** (eran 23), las dos `dream_error`: una era el agente
asumiendo datos no dichos (corregido en v15) y la otra son errores HMAC **en la
app del cliente**. Las 21 restantes se cerraron con su causa arreglada (trampas
31-32 y 34); quedan **9 mensajes** en revisión, legítimos (PENDIENTE 11).

**Sin webhook de salida** (`alert_config`): nunca se usó, la `0070` tiró la
tabla. La Torre filtra por `acknowledged_at is null`, **no** por `status`, y las
alertas **se auto-resuelven** cuando su causa desaparece.

### Webhook de Kommo → auto-sanado

Kommo deshabilita el webhook cuando le falla sostenido (el 29/08: ~40h mudo).
`alerts-scan` (cada 5 min) chequea el estado real contra la API y lo recrea solo
si está `disabled` o no existe, sin esperar a un humano (el cómo, en la trampa
20). Si falla reintenta cada 20 min — cooldown solo sobre la escritura. Avisa
con `kommo_webhook_reconnected` / `..._failed`.

### Bitácora propia (`system_logs`)

El Log Drain oficial cuesta $60/mes — descartado. En su lugar, tabla propia
`system_logs` (0069; retención 30 días con cron de limpieza) +
`_shared/system-log.ts` (`logEvent`, fail-soft), instrumentada a mano en
`kommo-webhook`, `process-inbound` y los workers de KB: puntual, no cobertura.

### Transcripción de notas de voz (Whisper)

Sana (estuvo rota al 100%: trampas 21-22). El recobro automático reintenta
audio además de imagen/documento, y la transcripción se **persiste** en
`messages.content` con prefijo 🎙️, así que también queda en el historial.

### Pipeline Zoho → Kommo

`Zoho Desk ─▶ tickets ─▶ Kommo [B2C | B2B]` y `Hoja Drive ─▶ meta_leads ─▶
Kommo [MetaAds]`, con **`pg_cron`** (GitHub Actions quedó solo con
`workflow_dispatch`). Jobs: `zoho-sync-incremental`, `zoho-kommo-push-safety`
(red independiente) y `zoho-refrescar-clasificacion`.

**Zoho es incremental** (watermark `max(created_time)`, trampa 1); **Drive se
relee completo**. **Anti-duplicados:** `kommo_lead_id is not null` = ya enviado,
más `tickets_ya_en_kommo()`, dedupe en el lote y `meta_leads_solapados()`; la
clave es `asunto + contacto + titular` (`ticket_dedup_key()`).

**Filtro B2C:** van a `VENTAS B2C` los tickets con `Asesor` **NULL/vacío** o
"No tengo" / "Sin Asesor" / "Sin Asesor (KG)" / "Seguros Venezuela" / "Directo
Caracas" / "No Posee" (`ilike`); **B2B** el resto, a "DATA ZOHO DESK". Tienen
que ser **partición exacta**: un hueco deja tickets sin empujar para siempre
(trampa 24) y un solapamiento duplica el lead. Viven en **dos runtimes que se
tocan juntos**: `zoho-kommo-push/index.ts` y `sync/lib/supa.mjs`.

`zoho_destino(asesor)` conserva **a propósito** un tercer valor,
`sin_atribucion`, para los NULL: en Kommo van a B2C, pero `/pipeline` los cuenta
aparte porque no hay corredor al que atribuirlos (PENDIENTE 6).

### Efectividad de corredores (cotizado vs. emitido)

En `/pipeline` → "B2C / B2B por corredor". Cruza las cotizaciones de Zoho con
las pólizas emitidas, que llegan en un **CSV mensual del sistema central** que
el operador sube desde el dashboard ("Cargar emisiones": preview primero,
escritura al confirmar). 0071-0076; `emisiones.ts` y `/api/pipeline/*`.

- **Cliente por cédula**, tomador **o** asegurado (personas distintas en muchas
  pólizas). `zoho_cedula()` la saca del asunto en el 99,8% de los B2B; con
  agosto machean 225 de 539.
- **Corredor por `corredor_alias`**, que liga el texto libre de Zoho al
  `Cod_Intermediario` canónico: las 12 escrituras de "BARECA" colapsan en una.
  `zoho_mapear_corredores()` propone (258 de 1.163) exigiendo una palabra poco
  común compartida (trampa 28) y respeta lo `manual`/`rechazado`; lo ambiguo se
  cierra a mano en **Revisar corredores**.
- **La emisión se acredita al intermediario del sistema central**, no al asesor
  del ticket: cuando difieren suele ser persona vs. empresa. **Anuladas no
  cuentan** (agosto: 460 vigentes / 79 anuladas). Los **dos porcentajes** son un
  **suelo declarado** (trampa 26): con agosto dan 4,8% y 4,1%; la fiable hoy es
  la inversa, de lo emitido cuánto venía de una cotización (35,6%).
- **25 tests e2e** cubren render, avisos, tabla, carga, alias, pestañas,
  verticales y periodo. El fixture es **sintético**: el repo es público.

### Panel de analítica de `/pipeline`

Cajón **flotante** por la derecha, mitad de pantalla (antes desplazaba el
contenido y eso ataba su ancho al de la columna: ~600px, poco para el cruce
plan×edad). Tres pestañas por **origen del dato**, que es lo que evita sumar
cosas incomparables: **Cotizaciones** (`zoho_pipeline_analitica()`),
**Emisiones** (`zoho_emisiones_analitica()`, 0077: cartera, suscripción por
día, suma asegurada, plan de pago, anulaciones, canal y los 12 que más facturan
con su comisión) y **Efectividad** (el cruce, más el desfase cotizar→emitir:
mediana 9 d, p90 44, máx 138 sobre 192 pólizas). Falta la fecha y el motivo de
anulación: el CSV no los trae (PENDIENTE 9); ojo con `Prima_Anual` (trampa 29).

### Sincronizar el prompt del agente

El system prompt NO vive en este repo ni en la DB: vive en el **Managed Agent
de Anthropic**, y es `runtime_config.SYSTEM_PROMPT` (la voz) + el
`CORE_SCAFFOLD` de `agent-prompt-core.mjs` (la maquinaria). Editar el `.mjs`
**no cambia nada** hasta sincronizar. La **voz sí está versionada**, en
`agent/system-prompt.md`, que es lo que `provision-agent.mjs` escribe en
`SYSTEM_PROMPT` (la vertical activa no: eso es DB, `/verticales`).

Lo empuja `syncAgentTools()` desde `/agent` al guardar y al tocar los gates de
`/api/agent/{bcv,crm-actions,shopify-actions}`. Manda **prompt Y tools juntos**,
así que antes hay que comprobar que las tools de la DB coincidan con las del
agente vivo, o se despliega más de lo que se cree:

```
GET https://api.anthropic.com/v1/agents/<ANTHROPIC_AGENT_ID>?beta=true
  x-api-key: <ANTHROPIC_API_KEY>   (los dos están en runtime_config)
  anthropic-beta: managed-agents-2026-04-01
```

Compara sus `tools` con `filterToolRowsByGates(agent_tools, kommo_publish_config)`
y su `system` con `composeSystem(...)`. Al 09-09 va en **v17**, con prompt
idéntico y 7 tools: `agent_toolset_20260401`, `search_kb`, `mover_etapa`,
`marcar_perdido`, `actualizar_{lead,contacto}` y `enviar_imagen`. Las 5 de
Shopify y `tasa_bcv` NO se declaran porque sus gates están apagados: costarían
tokens en cada turno e invitarían a llamadas inventadas.

### Rendimiento medido (2026-08-29)

15 conversaciones simultáneas + 4 usuarios navegando: **15/15 respondidas, 0
errores, $0,51**. Publicado p50 139s / p95 186s, y el grueso NO es el modelo
sino el cron de `process-inbound` (hasta 60s) más `response_debounce_seconds=45`
(`generate_response` tardó 19,9s bajo carga: la concurrencia no lo degrada). Web
p50 122ms / p95 165ms; producción p50 ~500ms y `/pipeline` bajó de 1.500-1.800ms
a 765-810ms con la materializada. Netlify da 403 tras ~66 cargas seguidas.

## PENDIENTE

1. Cargar KB real en cada vertical; la mayoría sigue sin ninguno. Los
   **condicionados escaneados** ya se pueden subir sin tope práctico de páginas
   (cola de la 0080), pero estrénala con uno (PENDIENTE 14). Auditoría del
   11-09 sobre los 5 documentos / 31 chunks que hay: sanos salvo **"Flyer RCV"
   y "Flyer marcotas"**, que siguen ILEGIBLES (largo medio de palabra 12,7 y
   8,8 contra 5,9 del resto — se cargaron antes del validador). Hay que volver
   a subirlos: ahora `looksMangled` los manda a visión y entran bien.
2. Borrar a mano en Kommo los leads etiquetados `duplicado` y los 15 de
   `prueba-carga` (ya en Perdido). La API no borra leads (trampa 2).
3. Restringir la hoja de Google de Meta Ads (hoy `anyone: commenter`, expone
   PII): pedir a `alessandra.publithink@gmail.com` compartirla con cuenta de
   servicio y apuntar `META_SHEET_CSV_URL`.
4. Decidir qué hacer con los leads `revisar-asesor`, y definir topes reales en
   `/consumo` (hoy sin tope).
6. Limpiar en Zoho: los 120 tickets con `Asesor` vacío (ya migran a B2C pero
   siguen sin corredor atribuible), las 166 cotizaciones con `Asesor` = "si
   tengo" y otros valores que no son un corredor (entran a B2B y ensucian el
   conteo). La tabla "B2B por corredor" sigue listando los nombres crudos,
   aunque la efectividad ya los colapsa con `corredor_alias`.
7. Que `zoho-sync` escriba `sync_state` en cada corrida (trampa 25): hoy solo
   lo hace el script Node y la tabla aparenta un sync caído con pipeline sano.
8. Revisar los **905 corredores sin ligar** en "Revisar corredores" (9 ambiguos
   + 896 sin candidato): casi todos no emitieron en los meses cargados y se
   ligarán solos. Empezar por los de más volumen, que es el orden del panel.
9. **Pedir al sistema central los meses de emisión anteriores**, y si se puede
   la fecha y el motivo real de anulación (hoy no vienen — trampa 29 y cabecera
   de la 0077). Con un solo mes, los dos porcentajes son un suelo (trampa 26).
10. **Borrar el usuario de prueba** `prueba.e2e@segurosvenezuela.com` (editor)
   cuando no se necesite. Credenciales en `web/.env.local`, no versionado.
11. Decidir qué hacer con los **9 mensajes que siguen en revisión**: son del
   17-19 de agosto (apagón de saldo, trampa 30), nunca recibieron respuesta y
   ya pasaron tres semanas. Incluyen dos cancelaciones de póliza y un "no me
   iré con ustedes entonces".
13. **Que un mensaje rechazado por la reja levante alerta en la Torre**
   (trampa 35). Hoy queda en `agent_metadata.correcciones_mensaje`, en el
   `publish_error` del draft y en el log, pero **nada avisa**: los 6 acuses
   internos se enviaron y nadie se enteró hasta que el operador los vio en
   pantalla. Un rechazo `fuga` es justo la señal que sí hay que mirar (es raro:
   6 en 259 drafts), y el `silencio` no debería alertar para no repetir la
   trampa 34. Falta decidir si va como alerta de `alerts-scan` o como contador
   en `/inbox`.
14. **Estrenar la cola de KB con un condicionado real.** Migración aplicada y
   workers desplegados con sus crones activos (11-09), pero todavía no ha
   pasado un documento de verdad. Subir uno mirando `system_logs` y `/consumo`:
   ahí se mide lo único que hoy es estimación —cuánto tarda y cuesta una
   tanda—; la perilla es `KB_PAGINAS_POR_TANDA`.

15. **Decidir qué es un "cliente" en emisiones.** La tarjeta de la analítica
   cuenta titulares —`coalesce(tomador, asegurado)`, 420 en agosto— y el cruce
   de efectividad cuenta a cualquiera que aparezca como tomador **o** asegurado
   (631), porque en 229 de las 539 pólizas son personas distintas. Las dos
   definiciones son defendibles y cada una sirve a lo suyo, pero se llaman
   igual en la misma pantalla. Falta que el operador diga cuál va en la tarjeta,
   o renombrar una de las dos.

**Vencimientos:** token de Kommo **2027-10-30** (ese día deja de crearse
cualquier lead). Refresh token de Zoho sin caducidad conocida, pero revocable.

---

## Estado y comandos

```sql
-- OJO: la frescura del sync se mide con max(tickets.synced_at), NO con
-- sync_state, que solo lo escribe el script Node (trampa 25).
select * from public.estado_general;      -- totales, cortes, fallos 24h
select * from public.bitacora_reciente;   -- una fila por corrida del sync
select * from public.system_logs order by created_at desc limit 50;
```

Otras: `sync_log`, `kommo_sync_status`, `meta_sync_status`, `kommo_duplicados`.

```bash
cd sync                                          # requiere sync/.env
node --env-file=.env sync.mjs incremental        # el ciclo completo
node --env-file=.env sync.mjs kommo --dry-run    # ver payloads, no escribe
#   ...igual con kommo-b2b y meta
node --env-file=.env sync.mjs kommo-init 2026-08-01T00:00:00Z   # mover el corte
node --env-file=.env limpiar-kommo.mjs --dry-run # etiquetar dups, arreglar tels
cd ../web && npx playwright test                 # los 25 e2e
```

Migraciones del pipeline en `db/`; las del agente y emisiones en
`supabase/migrations/`, aplicadas por Management API (`SUPABASE_ACCESS_TOKEN` /
`SUPABASE_PROJECT_REF` en `.env.local`). Tras tocar una migración o función:
`node web/scripts/embed-provision.mjs`. Edge Functions:
`node scripts/deploy-agent-functions.mjs <slug>`. Managed Agent:
`scripts/provision-agent.mjs` (idempotente; NO reconfigura uno existente — eso
se hace desde `/agent`, que es lo que empuja el prompt).

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
2. **La API de Kommo no borra leads** (`Allow: GET,POST,PATCH`): hay que etiquetar y borrar desde la interfaz.
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
    consolidado, porque cada rebuild parte del digest anterior. Desde el 07-09
    lo quita la **segunda pasada de auditoría** de `rebuildDigest` (trampa 36),
    no una edición a mano.
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
    atascados, 4 ago → 4 sep). Arreglado agregando `asesor.is.null` (y
    `asesor.eq.` por el vacío) al filtro B2C, en los dos runtimes. La misma
    trampa muerde al verificarlo: `not (asesor ilike ...)` también descarta las
    filas NULL, así que la consulta de control "demuestra" que no hay nada.
    Comprobar las DOS direcciones, y que el total sea **exactamente** la suma de
    las partes.
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
    FACTURADO de esa póliza: `prima_anual / suma(prima_recibo)` da **1,000
    exacto** en todos los grupos. Se detectó porque el panel mostraba "prima
    media" de $135 en Mensual y $1.018 en Anual — un 7,5× que parecía un
    hallazgo de negocio y era un artefacto: una póliza mensual de agosto lleva
    facturado 1-2 meses y una anual el año entero. A igual suma asegurada
    ($50.000) vale 130 en Mensual y 730 en Anual. Conclusión: el campo es
    redundante con `sum(prima_recibo)` y **no se puede comparar entre planes de
    pago**; todo el dinero del módulo sale de `prima_recibo`, que se llama como
    lo que es. Regla general: antes de publicar una media, comprobar que el
    denominador cubra la misma ventana en todos los grupos.

30. **Un tope de reintentos que no distingue de quién es la culpa condena
    mensajes sanos.** `process-inbound` reintenta 5 veces y luego pone el
    prefijo `recover:`, que lo saca de la cola PARA SIEMPRE (sin tope, un
    mensaje imposible quema Haiku cada minuto). Pero contaba igual los fallos
    que NO son del mensaje: del 15 al 19 de agosto la cuenta se quedó sin saldo
    y **102 mensajes (17% del total) quedaron sin clasificar para siempre**.
    Arreglado con `esFalloDeCuenta()`: sin saldo, 429, 5xx, timeouts y auth no
    gastan intento — reintentar es seguro porque mientras dura el corte fallan
    todos (no hay coste) y al resolverse la cola se drena sola.
31. **Una alerta de "regresión" con 6 muestras es ruido, no una señal.** El
    mínimo era de 5 muestras y disparó una "caída 69%" con n=6 contra un
    baseline de n=96 (6 casos contra 16 diarios). Un grader no evalúa a diario:
    pocas muestras es "ventana no representativa", no "el agente empeoró". Ahora
    exige **20 muestras** y que la caída supere **2 errores estándar** (~95%);
    con eso 0,455 (n=22) contra 0,667 (n=60) tampoco alerta (caída 0,212,
    margen 0,245). Hay que acumular la suma de cuadrados, no solo la suma.
32. **El agente devuelve texto vacío de vez en cuando, y eso dejaba la
    conversación muerta.** Pasó 3 veces (26/08 x2, 06/09) y en las TRES el lead
    se quedó sin respuesta: el draft se marcaba `failed` de una, sin reintento.
    Ahora se reintenta UNA vez —solo con menos de 100s gastados, porque una
    corrida son 60-80s y dos se pasan del límite— y si vuelve vacío los mensajes
    pasan a `requires_human_review`, que sí llega a un asesor.

33. **Una vista de Postgres se salta la RLS de sus tablas base, y en Supabase
    nace legible por `anon`.** `GET /rest/v1/v_polizas` con la clave **anon**
    (la del frontend, pública por diseño) devolvía cédulas, nombres, teléfonos y
    primas — y las 8 vistas con grant a `anon` devolvían datos,
    `kommo_duplicados` incluida, cuya clave lleva nombre + correo. Dos causas
    sumadas: una vista corre con los privilegios de su PROPIETARIO
    (`security_invoker = off`), así que da igual que la tabla base exija sesión;
    y Supabase concede por defecto TODO sobre lo nuevo de `public` a `anon`.
    Arreglado en la 0079 con las dos capas: `security_invoker = on` en todas las
    vistas (la que protege de verdad, porque hace que la RLS cuente) y `revoke
    all from anon` + quitarlo del default privilege.
    **Y pasa OTRA VEZ con las FUNCIONES** (0082, 11-09), que son otro objeto y
    otro default privilege: 18 de 75 eran `security definer` y estaban abiertas.
    Medido con la clave anon, sin sesión: `rpc/zoho_pipeline_overview` devolvía
    **190 KB** — 1.196 corredores con nombre, clientes y volumen. Cerrado
    revocando EXECUTE de `PUBLIC` (de donde `anon` lo hereda; revocárselo solo
    a `anon` no quita nada) y cambiando ese default privilege también.
    **Al crear una vista O una función sobre datos personales, comprobar con la
    clave anon que NO devuelve 200**: la comprobación de 10 segundos que
    destapó las dos.

34. **Una cola de revisión humana con 41% de ruido es una cola que nadie mira.**
    Había 56 mensajes marcados para revisión y 17 alertas sin atender desde el
    26 de agosto. Al clasificarlos: **15 eran una sola cadena literal**,
    `"The message could not be displayed due to API restrictions"` — el relleno
    que manda Meta cuando no puede renderizar un mensaje (sticker, nota de voz,
    post compartido). Llegaba sin contenido al clasificador, que adivinaba por
    el historial y lo repartía entre 4 verticales con urgencia hasta 5. Otros 4
    eran acuses ("Ok.", "Edpero reespuesta ."): la urgency se heredaba del hilo,
    así que un "ok." dentro de un reclamo furioso salía urgency 4. Y 3 los había
    puesto la propia regla de "respuesta vacía" (trampa 32) sobre **"Amén 🙏",
    "Gracias" y "Ok gracias"** — los tres cierres de conversación, donde vacío
    ES la respuesta correcta: 100% de falsos positivos.
    Cuatro arreglos: el placeholder de Meta se reconoce ANTES de clasificar (no
    gasta Haiku, no va a revisión, y el agente pide que lo reenvíen, porque el
    cliente sí mandó algo); la regla del clasificador exige que la queja aporte
    **información nueva** y que urgency/toxicity se juzguen del mensaje nuevo y
    no del historial; la de respuesta vacía solo convoca a un humano si el
    mensaje pedía algo (`esCierreOAcuse()`); y la marca deja de ser permanente:
    `limpiarRevisionesAtendidas()` la levanta cuando la conversación ya recibió
    respuesta del agente o un humano movió el lead en Kommo
    (`lead_stage_events.moved_by='kommo'` — las respuestas que escribe un asesor
    en Kommo NO llegan a nuestra DB, así que un movimiento manual es la mejor
    señal disponible). Resultado: 56 marcas → 9, y 19 alertas → 2.
    Lección: una marca que se pone y nunca se quita deja de ser una señal.

35. **"El último `agent.message` gana" le publicó al cliente el acuse interno
    del agente.** Seis veces, todas `auto_sent` a clientes reales: dos con el
    recibo de su propio trabajo ("Memoria actualizada. Respuesta enviada al
    lead.", 20-08 y 03-09) y cuatro con su deliberación de NO responder ("Sin
    respuesta automática. El lead está compartiendo reels…", "No hay respuesta
    que enviar en este caso…"). El agente SÍ había redactado el mensaje bueno:
    emitía su `<respuesta>`, después llamaba a las tools para escribir la
    memoria, y cerraba narrando que había terminado — sin etiquetas. Ese último
    mensaje pisaba al anterior y, al no haber tags, el fallback "usa el último
    texto" lo tomaba tal cual. **Un fallback que acepta cualquier cosa no es un
    fallback, es un agujero**: el formato correcto nunca fue obligatorio.
    Tres capas, y la del medio es la que pedía el operador: el acumulador da
    **precedencia al mensaje ETIQUETADO** (un acuse posterior ya no lo
    desplaza); `revisarMensajeFinal()` (`_shared/mensaje-final.ts`) revisa el
    texto **antes de enviarlo** y, si es una **fuga**, se lo DEVUELVE al agente
    en la misma sesión con el motivo y el fragmento exacto para que lo rehaga
    (hasta 2 vueltas, ~0 costo: el contexto y el trabajo interno ya están
    hechos); y `publish-to-kommo` repite la revisión en el PATCH real, que es el
    único punto por el que pasan todos los drafts, los de un humano incluidos.
    La distinción **fuga vs. silencio** importa: ante una mención en un story,
    callar YA era la decisión correcta, así que ahí no se pide reescribir —
    hacerlo lo empujaría a inventar un mensaje. Para eso el prompt ahora tiene
    dónde decirlo: `<respuesta></respuesta>` vacío.
    Medido contra los 259 drafts históricos: 6 rechazos, los 6 verdaderos, **0
    falsos positivos** en los 253 restantes. Lección: si el modelo decide el
    formato, el código tiene que verificarlo — y a una cola de revisión ya
    limpiada (trampa 34) solo se le mandan patrones inequívocos, nunca
    heurísticas de estilo.

36. **Un dream puede derogar una regla dura del prompt, y ganaba.** El operador
    tenía escrito "Instagram y WhatsApp SÍ son canales seguros para la cédula —
    NUNCA le digas que no lo haga". El agente hacía lo contrario ("Instagram no
    es el canal más seguro para cédula; si lo prefieres, llama al 0501") porque
    el dream del 28-08 había destilado "SIEMPRE advierte antes de solicitar
    datos sensibles, o redirige a canal seguro" — y el digest se inyecta como
    **prioridad máxima sobre la voz base**. Otros dos hacían lo mismo: uno pedía
    "2-3 opciones numeradas con emoji" (el prompt prohíbe las dos cosas) y otro
    ofrecer "siempre" la línea de emergencias (el prompt la limita a
    emergencias médicas) — de ahí el "llama al call center" repetido turno tras
    turno.
    La causa está antes: **a `dreamPrompt` nunca se le pasaba el system prompt
    del agente**, aunque se le pidiera detectar "violaciones de una regla de su
    prompt". Sin la regla contra la que comparar, destilaba buenas prácticas
    genéricas y las genéricas contradicen a un operador que decidió otra cosa.
    El consolidador incluso **invertía** el sentido: del dream "el agente
    prometió 24h y el back-office no cumplió" salió la viñeta "comunica SLA
    máximo 24h", justo lo que el prompt prohíbe.
    Arreglado en tres sitios: las reglas del operador viajan a `dreamPrompt` y
    a `rebuildDigest` como vara de medir; el orden de prioridad del scaffold
    pone las **reglas duras por encima de los dreams** (antes los dreams eran
    el punto 1); y como pedir el filtro en la MISMA llamada que la consolidación
    **no alcanza** —con 57 dreams y un tope de 900 palabras el digest salió
    contradiciéndose a sí mismo, "nunca prometas 24 horas" y tres viñetas más
    abajo "siempre agrega en máximo 24 horas"— hay una **segunda pasada** que
    solo audita el digest ya escrito contra las reglas. Esa tarea chica sí
    aplica el filtro. Pela el code fence en código, no pidiéndoselo al modelo.
    Lección: un destilador al que no le das la política escribe la suya, y a la
    tercera consolidación ya nadie sabe de dónde salió la regla.

37. **Una regla para "clientes molestos" se tragó una venta viva.** Una clienta
    escribió "pedí cotización por el centro de atención telefónica y no me
    mandaron la información, y por acá tampoco responden". El agente contestó
    con el buzón de ATC pidiéndole **cédula y número de póliza** y movió el lead
    a "cliente por atender". Las tres cosas fallaban: no es asegurada, así que
    no hay póliza que citar; lo que pedía era un precio, no el registro de un
    reclamo; y devolverla al call center la manda al canal que ya le falló. Ella
    cerró con "Gracias" y se fue.
    La regla no estaba mal escrita, estaba mal **delimitada**: "reclamo, demora,
    promesa incumplida" describe igual de bien a un asegurado esperando un
    reembolso que a un prospecto esperando una cotización, y el remedio es
    OPUESTO (uno se registra formalmente, el otro se cotiza aquí mismo). Como la
    sección de reclamos se enunciaba primero, se llevaba los dos casos.
    Arreglado con una sección propia ANTES de la de reclamos, con la plantilla
    literal del operador (5 datos numerados + grupo familiar) y su excepción
    declarada a la regla de largo — 60 palabras no dan para la lista, y una
    excepción a una regla dura hay que escribirla en la regla dura misma o el
    orden de prioridad del scaffold la descarta. `mover_etapa` va **después** de
    recibir los datos, no antes: escalar primero y no cotizar repetiría la falla
    de la que se queja.
    Lección: cuando dos casos comparten el síntoma y no el remedio, matizar la
    regla no alcanza — hay que sacar el caso a su propia sección.

38. **El separador de páginas del parser hacía pasar por "documento legible" a
    todo escaneo de 4 páginas o más.** Los condicionados son escaneos: PDFs sin
    capa de texto, de los que `pdf-parse` saca 0 caracteres por página. Pero
    pdf-parse v2 intercala por defecto un marcador ENTRE páginas (`pageJoiner`,
    `"\n-- page_number of total_number --"`) y ese texto sí cuenta: un escaneo
    de 4 páginas devolvía 60 caracteres y uno de 40, 707. El detector de "no
    tiene texto" comparaba contra un umbral ABSOLUTO de 50, así que de 4
    páginas para arriba lo superaba siempre: la visión —que existe justo para
    esto— nunca se invocaba y a la vertical le llegaba `-- 1 of 4 --\n-- 2 of
    4 --…` como si fuera el condicionado. `looksMangled` tampoco lo veía (mide
    largo medio de palabra; los marcadores son tokens de 1-2 letras). Lo frenó
    el juez de vertical —"el documento está vacío o sin contenido legible"—,
    pero su veredicto es "duda" y no "mal", así que el panel ofrecía **Aprobar
    e indexar** encima de la basura.
    El marcador se fue solo al mudar la extracción a Deno (`unpdf` no
    intercala nada), pero **el umbral absoluto seguiría estando mal**: la red
    que protege de verdad es medir **caracteres por PÁGINA**
    (`sinCapaDeTexto`, <25 → visión), lo único que distingue un documento
    corto legítimo de un escaneo de 40 hojas foliadas.
    Lección: si el extractor agrega texto propio, el umbral que mide "¿vino
    algo?" está midiendo también lo que agregó el extractor.

---

## Cronología

- **07-08 → 19-08**: pipeline Zoho→Supabase→Kommo, dashboard y agente "Sofi"
  (Managed Agent + Memory Stores) verificado en modo sombra.
- **19-08 → 26-08**: **agente en vivo**. Multimedia, 3 verticales, Torre de
  Control, `/analitica` e `/inbox` rehechos, pipeline pasado a `pg_cron`.
- **26-08 → 29-08**: endurecimiento. `marcar_perdido`, auto-sanado de etapa,
  reintentos de publicación, `matchStagesByName`, validador de KB con visión y
  módulo `/pipeline` B2C/B2B; `zoho-sync` llevaba 3 días mudo (trampa 1).
- **29-08 → 01-09**: apagón del webhook de Kommo (trampa 20) y audio roto al
  100% (trampas 21-22), los dos con auto-sanado. Auditoría de la Torre.
- **01-09 → 06-09**: los tres crones auditados y sanos (288/288 en 24h) aunque
  `sync_state` no lo reflejara (trampa 25); cerrado el hueco del `asesor` NULL
  (trampa 24): 18 tickets migrados a `VENTAS B2C`.
- **07-09**: auditoría completa (sin drift, 12 crones sin fallos); destapó la
  **fuga de las vistas** (trampa 33). Contador de mensajes en `/inbox`, prompt
  a v15 y tope de la bitácora de 500 a 700. Limpiada la **cola de revisión**
  (41% de ruido, trampa 34): 56 marcas → 9, 19 alertas → 2. Y al cierre, dos
  casos del operador destaparon las **trampas 35 y 36**. Agente a **v16**.
- **06-09**: módulo de **efectividad de corredores** (carga mensual con
  preview, `corredor_alias`, dos porcentajes declarados como suelo), **Revisar
  corredores** con ponderación por rareza, analítica en cajón flotante y los
  primeros e2e — trampas 26-29. `zoho_alias_pendientes()` 1,77 s → 0,12 s.
- **09-09**: un caso real destapó la **trampa 37** — la regla de "clientes
  molestos" se tragó una venta viva. El prompt tiene ahora sección propia para
  ese caso, con la plantilla del operador normalizada a tuteo. Agente a **v17**,
  diff cero contra el repo al verificarlo.
- **10-09**: los condicionados escaneados no entraban a ninguna vertical, por
  la detección (**trampa 38**) y porque la extracción no cabe en los 26s de
  Netlify. La ingesta pasó a ser una **cola** (0080) y la extracción se mudó
  ENTERA a `_shared/kb-extract.ts`; de Netlify se borraron los tres `kb-*.ts`,
  las rutas `prepare`/`verify`/`ingest` y `pdf-parse`/`mammoth`.
  `esFalloDeCuenta` subió a `_shared` (con tests) para que la cola no repita la
  trampa 30. Juez a **Sonnet 5**: 1M de contexto por $2/$10 en vez de $3/$15.
  Después, **filtro de periodo en `/pipeline`** (0081): `p_hasta` en las cinco
  funciones —generadas por transformación del original y revisadas por diff— y
  `zoho_embudo_resumen()` para la pestaña que tiraba de vistas sin parámetros.
  De paso destapó una fuga: las funciones `security definer` eran ejecutables
  por `anon` (trampa 33, segunda mitad).
- **11-09**: cerrada esa fuga (0082) tras medirla en vivo, chips de mes en
  emisiones (0083) y **todo desplegado**: cuatro migraciones, los dos workers
  de KB con sus crones activos y 25 e2e en verde. Los e2e destaparon dos cosas
  que el typecheck no ve: el filtro en `actions` aplastaba el título a una
  palabra por línea, y el widget fijo de soporte tapaba la pestaña "Embudo
  Zoho" lo bastante como para no poder **clicarla** (nadie lo había visto
  porque los tests viejos navegan por URL). Arregladas. Y auditada la KB ya
  indexada: 29 de 31 chunks llevaban dentro el marcador de página de la trampa
  38 —"PLANES SUMAS ASEGURADAS -- 19 of 60 --"—, limpiados y re-embebidos.
  Recuperación comprobada: 4/4 preguntas traen su chunk en 1ª posición.
