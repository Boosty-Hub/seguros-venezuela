// Cliente minimo de Zoho Desk: refresco de token OAuth + paginacion de tickets.

const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || 'https://accounts.zoho.com';
const DESK_HOST = process.env.ZOHO_DESK_HOST || 'https://desk.zoho.com';

const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ORG_ID = process.env.ZOHO_ORG_ID;
const DEPARTMENT_ID = process.env.ZOHO_DEPARTMENT_ID;

let cachedToken = null;
let cachedExp = 0;
// Refresco EN VUELO compartido. Sin esto, los N workers concurrentes que
// arrancan a la vez con la cache vacia disparan N refrescos simultaneos, y el
// endpoint de tokens de Zoho es mucho mas estricto que la API de Desk: al
// pasarse responde "You have made too many requests continuously" y bloquea
// TODAS las llamadas por un rato (visto en produccion: el enriquecimiento
// paso a 0/9998 sin un solo error visible en el log, porque el fallo ocurria
// al pedir el token, no al pedir el ticket).
let refreshInFlight = null;

function requireEnv() {
  const missing = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID', 'ZOHO_DEPARTMENT_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
}

export async function getAccessToken() {
  requireEnv();
  const now = Date.now();
  if (cachedToken && now < cachedExp - 60_000) return cachedToken;
  // Ya hay un refresco corriendo: esperar ESE en vez de disparar otro.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const body = new URLSearchParams({
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    });

    // Reintento con espera creciente: si ya nos bloquearon, insistir de
    // inmediato solo alarga el bloqueo.
    let ultimo = null;
    for (let intento = 0; intento < 4; intento++) {
      const r = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const j = await r.json();
      if (j.access_token) {
        cachedToken = j.access_token;
        cachedExp = Date.now() + (j.expires_in || 3600) * 1000;
        return cachedToken;
      }
      ultimo = j;
      const bloqueado = JSON.stringify(j).includes('too many requests');
      if (!bloqueado) break;
      await sleep(30_000 * (intento + 1));
    }
    throw new Error(`No se pudo refrescar el token Zoho: ${JSON.stringify(ultimo)}`);
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function deskFetch(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${DESK_HOST}/api/v1/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, orgId: ORG_ID },
    });
    if (r.status === 429) {
      // rate limit: espera exponencial
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (r.status === 204) return { data: [] };
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Zoho ${path} -> HTTP ${r.status}: ${txt.slice(0, 300)}`);
    }
    return r.json();
  }
  throw new Error(`Zoho ${path}: agotados los reintentos por rate limit`);
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Trae una pagina de tickets del departamento.
 * sortBy: 'createdTime' (asc, para full) o '-modifiedTime' (desc, para incremental)
 */
export async function fetchTicketsPage({ from, limit = 100, sortBy = 'createdTime', include = 'contacts,assignee' }) {
  const j = await deskFetch('tickets', {
    departmentId: DEPARTMENT_ID,
    from,
    limit,
    sortBy,
    include,
  });
  return j.data || [];
}

/** Detalle completo de un ticket (incluye customFields). */
export async function fetchTicketDetail(id) {
  return deskFetch(`tickets/${id}`, { include: 'contacts,assignee' });
}

export const config = { ORG_ID, DEPARTMENT_ID, DESK_HOST };
