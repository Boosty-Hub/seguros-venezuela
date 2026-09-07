# Bitácora del proyecto

Qué se hizo, dónde quedó y qué falta. **Leer esto primero** al retomar.

> **Regla para actualizar** (sesión humana o agente): leer el archivo completo
> antes de escribir. **Fusionar**, nunca agregar una sección que repita o
> contradiga otra; si un dato cambió, **reemplazarlo**. Cifras e IDs van en
> "Estado actual"; las trampas no se repiten arriba.
>
> **Tope: 700 líneas** (era 500 hasta el 07-09; se subió porque tres sesiones
> seguidas obligaron a comprimir diagnóstico real de las trampas para caber).
> El tope existe porque un archivo más largo no se lee completo. Más margen NO
> es permiso para rellenar: el espacio extra es para el diagnóstico de las
> trampas, no para decir dos veces lo mismo.

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
  compartir cédula/teléfono/póliza: se acepta todo lo que manden por ahí y NO se
  ofrece la llamada como alternativa "más segura" (un dream lo había derogado,
  trampa 36). Un teléfono o un correo se dan **una vez por conversación**.
- **Reja antes de enviar** (trampa 35): `revisarMensajeFinal()` verifica que el
  texto sea un mensaje para el cliente y no algo interno. Si es una **fuga**, se
  le devuelve al agente en la misma sesión para que lo rehaga (2 vueltas máximo,
  ver `correcciones_mensaje` en `agent_metadata`); si es un **silencio** no se
  envía nada. Se revisa dos veces: al cerrar el turno y en `publish-to-kommo`.
  Para callar a propósito, el agente emite `<respuesta></respuesta>` vacío.
- **Tono concreto**: no cierra con preguntas redundantes; al escalar dice que
  un asesor ya tiene el caso y ofrece allanar o cotizar. Clientes molestos van
  al correo de ATC.
- **Acciones de CRM** (`mover_etapa`, `marcar_perdido`, `enviar_imagen`,
  `actualizar_lead/contacto`) **corren contra Kommo real aunque "Publicar en
  Kommo" esté apagado**: ese interruptor solo gobierna los MENSAJES.
- **`marcar_perdido`**: manda a Perdido (143) empleo, spam y leads errados, con
  una de las 11 razones de Kommo (trampa 10). **Auto-sanado de etapa**: si se
  pierde un webhook `leads.status`, `process-inbound` consulta la etapa viva en
  Kommo antes de ignorar el lead (antes quedaba mudo para siempre).
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
  (`DREAMS_DIGEST`) es rolling: ver trampa 17. **Las reglas del operador viajan
  al destilador y al consolidador**, y una segunda pasada audita el digest
  contra ellas: un aprendizaje NO puede derogar una regla dura (trampa 36).

### Dashboard

- **Torre de control**: la campana abre un panel que **desplaza** el contenido
  con alertas, Dreams, estado del agente, consumo y revisiones (`/alerts`
  standalone se eliminó: la Torre es la única vista de alertas).
- **`/inbox`**: contador de mensajes por conversación (cliente + agente) con el
  desglose en el `title`. `messages` solo guarda entrantes; las respuestas del
  agente son `drafts` en `auto_sent` (un `failed` nunca llegó al cliente).
  Pestañas "Agente"/"Resto" (`?vista=resto`), badge "Transferido a humano" y una
  línea de tiempo con mensajes + cambios de etapa (`lead_stage_events`, los de
  Kommo incluidos) + imágenes del agente; un cambio de etapa sin mensaje no toca
  `last_message_at`. **Favoritas** (0068): la marca es **del equipo**.
- **`/analitica`**: funnel del agente vía `analytics_overview(p_since)`. El
  canal sale de `leads.channel` o del `source` del primer mensaje; los leads sin
  conversación **se excluyen** en vez de caer en un "Otro" que llegó al 79%.
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

**2 abiertas al 07-09** (eran 23), las dos `dream_error`: uno era el agente
asumiendo datos no dichos por la clienta (ya corregido en el prompt y
sincronizado, v15) y el otro son errores HMAC **en la app del cliente**, no
aquí.

Las 21 restantes se cerraron con su causa arreglada: trampas 31-32 el 06-09, y
el 07-09 la **limpieza de la cola de revisión** (trampa 34) cerró 17 de golpe.
Quedan **9 mensajes** marcados para revisión y son legítimos: del 17-19 de
agosto, del apagón de saldo (trampa 30), y nunca recibieron respuesta — alguien
tiene que decidir si a estas alturas se contacta a esa gente (PENDIENTE 11).
**Sin webhook de salida** (`alert_config`): nunca se usó, la `0070` tiró la
tabla. La Torre filtra por `acknowledged_at is null`, **no** por `status`. Y
**se auto-resuelven** cuando su causa desaparece, en vez de quedarse en rojo:
`provider_credit_exhausted` (llegó consumo) e `inbound_silence` (entró un evento
a `inbound_queue` tras la alerta).

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
1. Zoho Desk ─▶ Supabase (tickets)   2. ─▶ Kommo [B2C | B2B: DATA ZOHO DESK]
3. Hoja Drive ─▶ Supabase (meta_leads) ─▶ Kommo [MetaAds]
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

- **Cliente por cédula**, tomador **o** asegurado (personas distintas en muchas
  pólizas). `zoho_cedula()` la saca del asunto en el 99,8% de los tickets B2B;
  con agosto machean 225 de 539.
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

### Sincronizar el prompt del agente

El system prompt NO vive en este repo ni en la DB: vive en el **Managed Agent de
Anthropic**, y es la composición de `runtime_config.SYSTEM_PROMPT` (la voz,
editable) + el `CORE_SCAFFOLD` de `web/src/lib/agent-prompt-core.mjs` (la
maquinaria: flujo obligatorio, formato, seguridad). Editar el `.mjs` **no cambia
nada** hasta sincronizar.

Lo empuja `syncAgentTools()`, que corre desde `/agent` al guardar (admin) y
también al tocar los interruptores de `/api/agent/{bcv,crm-actions,shopify-actions}`.
Manda **prompt Y tools juntos**, así que antes de sincronizar hay que comprobar
que las tools de la DB coincidan con las del agente vivo, o se despliega más de
lo que se cree:

```
GET https://api.anthropic.com/v1/agents/<ANTHROPIC_AGENT_ID>?beta=true
  x-api-key: <ANTHROPIC_API_KEY>   (los dos están en runtime_config)
  anthropic-beta: managed-agents-2026-04-01
```

Compara sus `tools` con `filterToolRowsByGates(agent_tools, kommo_publish_config)`
y su `system` con `composeSystem(...)`. Al 07-09 va en **v16**: 7 tools idénticas
(`agent_toolset_20260401`, `search_kb`, `mover_etapa`, `marcar_perdido`,
`actualizar_lead`, `actualizar_contacto`, `enviar_imagen`) y prompt idéntico.
Las 5 de Shopify y `tasa_bcv` NO se declaran porque sus gates están apagados —
declararlas costaría tokens en cada turno e invitaría a llamadas inventadas.

### Rendimiento medido (2026-08-29)

15 conversaciones simultáneas + 4 usuarios navegando: **15/15 respondidas, 0
errores, $0,51**. Publicado p50 139s / p95 186s, y el grueso NO es el modelo
sino el cron de `process-inbound` (hasta 60s) más `response_debounce_seconds=45`
(`generate_response` tardó 19,9s bajo carga: la concurrencia no lo degrada). Web
p50 122ms / p95 165ms en 4.902 peticiones; producción p50 ~500ms y `/pipeline`
bajó de 1.500-1.800ms a 765-810ms con la vista materializada. Netlify devuelve
403 tras ~66 cargas seguidas (rate limiting propio).

## PENDIENTE

1. Cargar KB real en cada vertical (tarifarios, condiciones, FAQs); la mayoría
   sigue sin ninguno. **Volver a subir "Flyer RCV" y "Flyer marcotas"**: se
   cargaron antes del validador y su texto quedó corrupto.
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
7. Que `zoho-sync` escriba `sync_state` en cada corrida: hoy solo lo hace el
   script Node y la tabla aparenta un sync caído con el pipeline sano
   (trampa 25).
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
12. ~~Sincronizar el prompt~~ **HECHO el 07-09**: el agente vivo está en la
   versión 15 con la regla "no des por supuesto ningún dato que el lead no haya
   dicho", y el diff entre `agent-prompt-core.mjs` y el prompt del Managed Agent
   es de **cero líneas en los dos sentidos**. Ver "Sincronizar el prompt" más
   abajo para cómo se hace y cómo verificarlo.

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
    hallazgo
    de negocio y era un artefacto: una póliza mensual suscrita en agosto lleva
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
    all from anon` + quitarlo del default privilege. **Al crear una vista sobre
    datos personales, comprobar con la clave anon que devuelve 401.**

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
- **07-09**: auditoría completa (sin drift entre repo y producción, 12 crones
  sin fallos, 0 pendientes en los embudos). Destapó la **fuga de las vistas**
  (trampa 33) y se cerró. Contador de mensajes por conversación en `/inbox`.
  Prompt del agente sincronizado (v15) tras verificar que el sync solo cambiaba
  esa línea. Tope de la bitácora subido de 500 a 700 líneas. Y se limpió la
  **cola de revisión humana**, que tenía 41% de ruido (trampa 34): 56 marcas →
  9, 19 alertas → 2. Al final del día, dos casos del operador destaparon las
  **trampas 35 y 36**: el agente había publicado 6 veces su acuse interno (se
  cerró con la reja de `revisarMensajeFinal()`, 0 falsos positivos en 259
  drafts) y un dream derogaba la regla dura de que Instagram es canal seguro
  para la cédula (se cerró dándole al destilador las reglas del operador y
  auditando el digest contra ellas). Agente a **v16**.
- **06-09**: módulo de **efectividad de corredores** (carga mensual con
  preview, `corredor_alias`, dos porcentajes declarados como suelo — trampas
  26-27; la primera versión daba 0,2% por medir la madurez contra `now()`),
  panel **Revisar corredores** con ponderación por rareza (trampa 28, 9 alias
  mal atribuidos limpiados), analítica de emisiones en **cajón flotante con
  tres pestañas** (trampa 29: `Prima_Anual` no es anual) y **15 tests e2e** con
  Playwright contra el Supabase real. De paso, `zoho_alias_pendientes()` de
  1,77 s a 0,12 s y `zoho_corredores_efectividad()` de 2,5 s a 0,15 s.
