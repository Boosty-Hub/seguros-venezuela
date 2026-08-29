// Acceso a Supabase vía PostgREST usando la service_role key (ignora RLS).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function requireEnv() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
}

function headers(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Upsert por lotes en la tabla tickets (merge por PK id). */
export async function upsertTickets(rows) {
  requireEnv();
  if (!rows.length) return 0;
  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tickets?on_conflict=id`, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(batch),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Supabase upsert -> HTTP ${r.status}: ${txt.slice(0, 400)}`);
    }
    done += batch.length;
  }
  return done;
}

/** IDs de tickets sin customFields (para la pasada de enriquecimiento). */
export async function getTicketsMissingDetail({ onlyOpen = true, limit = 5000 } = {}) {
  requireEnv();
  // PAGINADO a proposito: PostgREST corta en 1000 filas por respuesta
  // (max-rows del servidor) e IGNORA un ?limit= mayor sin avisar. Antes esto
  // pedia limit=12000 y devolvia 998 -> `enrich all 12000` decia "listo" tras
  // enriquecer el 9% del backlog, en silencio. Se pagina con Range hasta
  // juntar `limit` ids o agotar la tabla (mismo patron que
  // getTicketsKommoConAsesor).
  let url = `${SUPABASE_URL}/rest/v1/tickets?select=id&custom_fields=is.null&order=created_time.desc`;
  // "pipeline activo" = tickets no finalizados (Open + On Hold)
  if (onlyOpen) url += `&status_type=in.(Open,"On Hold")`;
  const PAGE = 1000;
  const out = [];
  for (let from = 0; from < limit; from += PAGE) {
    const to = Math.min(from + PAGE, limit) - 1;
    const r = await fetch(url, { headers: headers({ Range: `${from}-${to}` }) });
    if (!r.ok) throw new Error(`Supabase select -> HTTP ${r.status}: ${await r.text()}`);
    const page = await r.json();
    out.push(...page.map((x) => x.id));
    if (page.length < to - from + 1) break; // ultima pagina
  }
  return out;
}

/** max(modified_time) actualmente almacenado (watermark incremental). */
export async function getWatermark() {
  requireEnv();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tickets?select=modified_time&order=modified_time.desc.nullslast&limit=1`,
    { headers: headers() },
  );
  if (!r.ok) throw new Error(`Supabase watermark -> HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j[0]?.modified_time || null;
}

/**
 * max(created_time) almacenado. Es el watermark REAL del incremental: el
 * listado de Zoho no devuelve modifiedTime, pero si createdTime, y el orden
 * por -createdTime si es fiable.
 */
export async function getCreatedWatermark() {
  requireEnv();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tickets?select=created_time&order=created_time.desc.nullslast&limit=1`,
    { headers: headers() },
  );
  if (!r.ok) throw new Error(`Supabase watermark created -> HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j[0]?.created_time || null;
}

/**
 * Tickets abiertos que llevan mas tiempo sin refrescarse. Sirve para detectar
 * cambios de etapa, que el listado de Zoho no permite filtrar por fecha.
 */
export async function getOpenTicketsToRefresh({ limit = 200 } = {}) {
  requireEnv();
  const url =
    `${SUPABASE_URL}/rest/v1/tickets?select=id` +
    `&status_type=in.(Open,"On Hold")` +
    `&order=synced_at.asc.nullsfirst&limit=${limit}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase refresh abiertos -> HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.map((x) => x.id);
}

export async function countTickets() {
  requireEnv();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tickets?select=id`, {
    headers: headers({ Prefer: 'count=exact', Range: '0-0' }),
  });
  const cr = r.headers.get('content-range'); // formato: 0-0/1234
  return cr ? parseInt(cr.split('/')[1], 10) : null;
}

export async function updateSyncState(patch) {
  requireEnv();
  const body = { id: 1, updated_at: new Date().toISOString(), ...patch };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=id`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase sync_state -> HTTP ${r.status}: ${await r.text()}`);
}

/* ---------------------------------------------------------------------------
 * Integracion Kommo CRM
 * -------------------------------------------------------------------------*/

/** Estado de la integracion Kommo (corte, contadores). */
export async function getKommoState() {
  requireEnv();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?id=eq.1&select=kommo_since,kommo_total,kommo_last_run`,
    { headers: headers() },
  );
  if (!r.ok) throw new Error(`Supabase kommo_state -> HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j[0] || {};
}

/**
 * Filtro Postgrest (OR, ilike) que solo deja pasar tickets "sin asesor real":
 * el campo Asesor de Zoho vale "No tengo", "Sin Asesor", "Sin Asesor (KG)",
 * "Seguros Venezuela", "Directo Caracas" o "No Posee" (con variantes de
 * mayusculas/espacios/sufijos como ", C.A."). El resto de tickets SI tienen un
 * asesor/corredor asignado y no deben entrar al CRM.
 *
 * OJO con los patrones de "Directo": el ilike es *directo*caracas*, NO *directo*.
 * En Zoho existen tambien "DIRECTO VALENCIA", "DIRECTO SAN CRISTOBAL" y
 * "Directo" suelto, que por decision del operador siguen yendo al embudo B2B
 * — un patron *directo* los arrastraria a B2C por error.
 */
const FILTRO_SIN_ASESOR =
  'or=(asesor.ilike.*no*tengo*,asesor.ilike.*sin*asesor*,asesor.ilike.*seguros*venezuela*' +
  ',asesor.ilike.*directo*caracas*,asesor.ilike.*no*posee*)';

/**
 * Tickets que todavia no tienen lead en Kommo y son POSTERIORES al corte.
 * El corte (kommo_since) es lo que evita volcar el historico al CRM. Ademas
 * solo pasan los tickets sin asesor asignado (ver FILTRO_SIN_ASESOR): los que
 * tienen un asesor/corredor real no se migran.
 */
export async function getTicketsPendingKommo({ since, limit = 200 } = {}) {
  requireEnv();
  if (!since) throw new Error('getTicketsPendingKommo: falta el corte (kommo_since)');
  const cols = [
    'id', 'ticket_number', 'subject', 'status', 'status_type', 'channel',
    'contact_name', 'email', 'phone', 'titular', 'asesor', 'plan_hcm',
    'monto_prima', 'moneda', 'created_time', 'web_url',
  ].join(',');
  const url =
    `${SUPABASE_URL}/rest/v1/tickets?select=${cols}` +
    `&kommo_lead_id=is.null` +
    `&created_time=gte.${encodeURIComponent(since)}` +
    `&is_spam=is.false` +
    `&${FILTRO_SIN_ASESOR}` +
    `&order=created_time.asc&limit=${limit}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase pendientes Kommo -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * Filtro inverso: tickets CON asesor/corredor real asignado — es decir,
 * cualquier valor de Asesor que NO cumpla FILTRO_SIN_ASESOR. Excluye ademas
 * asesor null/vacio (dato incompleto, no se asume corredor). Estos son los que
 * van al embudo B2B (corredores que cotizan via Sofi u otras plataformas) en
 * vez del B2C.
 *
 * Debe ser el complemento EXACTO de FILTRO_SIN_ASESOR: si se agrega un valor
 * alla y no se excluye aca, el mismo ticket calificaria para los dos embudos.
 */
const FILTRO_CON_ASESOR =
  'asesor=not.is.null' +
  '&asesor=neq.' +
  '&asesor=not.ilike.*no*tengo*' +
  '&asesor=not.ilike.*sin*asesor*' +
  '&asesor=not.ilike.*seguros*venezuela*' +
  '&asesor=not.ilike.*directo*caracas*' +
  '&asesor=not.ilike.*no*posee*';

/** Estado de la integracion Kommo B2B (corte, contadores) — espejo de getKommoState(). */
export async function getKommoB2BState() {
  requireEnv();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?id=eq.1&select=kommo_b2b_since,kommo_b2b_total,kommo_b2b_last_run`,
    { headers: headers() },
  );
  if (!r.ok) throw new Error(`Supabase kommo_b2b_state -> HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j[0] || {};
}

/**
 * Tickets CON asesor real, todavia sin lead en Kommo, posteriores al corte
 * B2B (kommo_b2b_since) — van al embudo VENTAS B2B / etapa "DATA ZOHO DESK".
 * Espejo de getTicketsPendingKommo() pero con el filtro invertido.
 */
export async function getTicketsPendingKommoB2B({ since, limit = 200 } = {}) {
  requireEnv();
  if (!since) throw new Error('getTicketsPendingKommoB2B: falta el corte (kommo_b2b_since)');
  const cols = [
    'id', 'ticket_number', 'subject', 'status', 'status_type', 'channel',
    'contact_name', 'email', 'phone', 'titular', 'asesor', 'plan_hcm',
    'monto_prima', 'moneda', 'created_time', 'web_url',
  ].join(',');
  const url =
    `${SUPABASE_URL}/rest/v1/tickets?select=${cols}` +
    `&kommo_lead_id=is.null` +
    `&created_time=gte.${encodeURIComponent(since)}` +
    `&is_spam=is.false` +
    `&${FILTRO_CON_ASESOR}` +
    `&order=created_time.asc&limit=${limit}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase pendientes Kommo B2B -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * Tickets YA enviados a Kommo (tienen lead) cuyo Asesor NO cumple el filtro
 * de "sin asesor" (ver FILTRO_SIN_ASESOR) -- incluye asesor con nombre real Y
 * asesor null/vacio (nunca se enriquecio o el campo viene sin valor). Son los
 * que se migraron ANTES de activar el filtro y hay que revisar/etiquetar en
 * Kommo, porque segun la regla actual no deberian haber entrado.
 */
export async function getTicketsKommoConAsesor({ limit = 20000 } = {}) {
  requireEnv();
  const url =
    `${SUPABASE_URL}/rest/v1/tickets?select=id,ticket_number,asesor,kommo_lead_id` +
    `&kommo_lead_id=not.is.null` +
    `&or=(asesor.is.null,and(asesor.not.ilike.*no*tengo*,asesor.not.ilike.*sin*asesor*,asesor.not.ilike.*seguros*venezuela*,asesor.not.ilike.*directo*caracas*,asesor.not.ilike.*no*posee*))`;
  const PAGE = 1000;
  const out = [];
  for (let from = 0; from < limit; from += PAGE) {
    const r = await fetch(url, { headers: headers({ Range: `${from}-${from + PAGE - 1}` }) });
    if (!r.ok) throw new Error(`Supabase con-asesor -> HTTP ${r.status}: ${await r.text()}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/** Graba el lead_id devuelto por Kommo (o el error) en cada ticket. */
export async function markKommoSynced(pairs) {
  requireEnv();
  if (!pairs.length) return 0;
  const now = new Date().toISOString();
  const rows = pairs.map((p) => ({
    id: p.sourceId,
    kommo_lead_id: p.leadId || null,
    kommo_synced_at: p.leadId ? now : null,
    kommo_error: p.leadId ? null : (p.error || 'sin lead_id'),
  }));
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tickets?on_conflict=id`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase marcar Kommo -> HTTP ${r.status}: ${await r.text()}`);
  return rows.filter((x) => x.kommo_lead_id).length;
}

/**
 * Graba una fila en la bitacora de ejecuciones. Nunca lanza: si la bitacora
 * falla no debe tumbar un sync que ya hizo su trabajo.
 */
export async function insertSyncLog(row) {
  try {
    requireEnv();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sync_log`, {
      method: 'POST',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(row),
    });
    if (!r.ok) console.warn('  aviso: no se pudo grabar la bitacora:', (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) {
    console.warn('  aviso: no se pudo grabar la bitacora:', e.message);
    return false;
  }
}

/**
 * Tickets pendientes cuya solicitud YA tiene lead en Kommo (creado por otro
 * ticket equivalente de Zoho). Se vinculan en vez de duplicarse.
 */
export async function getTicketsYaEnKommo({ since } = {}) {
  requireEnv();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/tickets_ya_en_kommo`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ p_since: since ?? null }),
  });
  if (!r.ok) throw new Error(`Supabase tickets_ya_en_kommo -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/** Grupos que produjeron mas de un lead (auditoria de limpieza). */
export async function getKommoDuplicados() {
  requireEnv();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/kommo_duplicados?select=*`, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase kommo_duplicados -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/* ---------------------------------------------------------------------------
 * Leads de Meta (hoja de Google)
 * -------------------------------------------------------------------------*/

/** Upsert por lotes en meta_leads. No pisa las columnas de control de Kommo. */
export async function upsertMetaLeads(rows) {
  requireEnv();
  if (!rows.length) return 0;
  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/meta_leads?on_conflict=id`, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(batch),
    });
    if (!r.ok) throw new Error(`Supabase upsert meta_leads -> HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
    done += batch.length;
  }
  return done;
}

export async function getMetaState() {
  requireEnv();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?id=eq.1&select=meta_since,meta_total,meta_last_run`,
    { headers: headers() },
  );
  if (!r.ok) throw new Error(`Supabase meta_state -> HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j[0] || {};
}

/** Leads de Meta posteriores al corte que aun no tienen lead en Kommo. */
export async function getMetaLeadsPendingKommo({ since, limit = 200 } = {}) {
  requireEnv();
  if (!since) throw new Error('getMetaLeadsPendingKommo: falta el corte (meta_since)');
  const url =
    `${SUPABASE_URL}/rest/v1/meta_leads?select=*` +
    `&kommo_lead_id=is.null` +
    `&created_time=gte.${encodeURIComponent(since)}` +
    `&order=created_time.asc&limit=${limit}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase pendientes Meta -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function markMetaKommoSynced(pairs) {
  requireEnv();
  if (!pairs.length) return 0;
  const now = new Date().toISOString();
  const rows = pairs.map((p) => ({
    id: p.sourceId,
    kommo_lead_id: p.leadId || null,
    kommo_synced_at: p.leadId ? now : null,
    kommo_error: p.leadId ? null : (p.error || 'sin lead_id'),
  }));
  const r = await fetch(`${SUPABASE_URL}/rest/v1/meta_leads?on_conflict=id`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase marcar Meta -> HTTP ${r.status}: ${await r.text()}`);
  return rows.filter((x) => x.kommo_lead_id).length;
}

/**
 * Leads de Meta que ya existen como contacto en Kommo por otra via (ticket de
 * Zoho con el mismo correo o telefono). Sirve para no crear un lead duplicado
 * de una persona que ya esta en el CRM.
 */
export async function getMetaLeadsYaEnZoho({ since } = {}) {
  requireEnv();
  const url =
    `${SUPABASE_URL}/rest/v1/rpc/meta_leads_solapados`;
  const r = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ p_since: since }),
  });
  if (!r.ok) throw new Error(`Supabase solapados -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}
