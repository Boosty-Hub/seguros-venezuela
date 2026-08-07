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
  let url = `${SUPABASE_URL}/rest/v1/tickets?select=id&custom_fields=is.null&order=created_time.desc&limit=${limit}`;
  // "pipeline activo" = tickets no finalizados (Open + On Hold)
  if (onlyOpen) url += `&status_type=in.(Open,"On Hold")`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`Supabase select -> HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.map((x) => x.id);
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
