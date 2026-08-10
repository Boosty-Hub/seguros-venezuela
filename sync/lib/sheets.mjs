// ============================================================================
// Lectura de la hoja de Google donde marketing recibe los leads de Meta.
//
// Hoy la hoja es accesible por enlace, asi que se descarga por el endpoint de
// exportacion a CSV sin credenciales. Si mas adelante se cierra el acceso
// publico (recomendable: son datos personales), basta apuntar
// META_SHEET_CSV_URL a un endpoint autenticado; el resto del codigo no cambia.
// ============================================================================

import { normalizePhone } from './telefono.mjs';

const SHEET_ID = process.env.META_SHEET_ID || '1jUy4z0CPGV3DkF28goP8rqxL9qUZSJPMh3H6MwwPhiE';
const CSV_URL = process.env.META_SHEET_CSV_URL ||
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

/* ---------------------------------------------------------------------------
 * Parser CSV minimo (comillas dobles, comas y saltos de linea dentro de campo)
 * -------------------------------------------------------------------------*/
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  // Normalizamos saltos de linea y quitamos el BOM que mete Google.
  const s = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // comilla escapada
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------------------------------------------------------------------------
 * Normalizacion
 * -------------------------------------------------------------------------*/

const stripPrefix = (v) => (v == null ? null : String(v).trim().replace(/^(l|ag|as|c|f|p):/i, '') || null);
const clean = (v) => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? null : s; };

function toDate(v) {
  const s = clean(v);
  if (!s) return null;
  // La hoja usa YYYY-MM-DD; cualquier otra cosa se descarta antes que corromper.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? s : null;
}

function toTimestamp(v) {
  const s = clean(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Fila de la hoja -> fila de public.meta_leads */
export function rowToMetaLead(r) {
  const id = clean(r['id']);
  if (!id) return null;
  return {
    id,                                   // se conserva con prefijo l: (es unico y estable)
    created_time: toTimestamp(r['created_time']),
    ad_id: stripPrefix(r['ad_id']),
    ad_name: clean(r['ad_name']),
    adset_id: stripPrefix(r['adset_id']),
    adset_name: clean(r['adset_name']),
    campaign_id: stripPrefix(r['campaign_id']),
    campaign_name: clean(r['campaign_name']),
    form_id: stripPrefix(r['form_id']),
    form_name: clean(r['form_name']),
    is_organic: clean(r['is_organic']) === null ? null : /^true$/i.test(r['is_organic']),
    platform: clean(r['platform']),
    nombre_completo: clean(r['nombre_completo']),
    fecha_nacimiento: toDate(r['fecha_de_nacimiento']),
    telefono: normalizePhone(r['número_de_teléfono'] ?? r['numero_de_telefono']),
    telefono_raw: clean(r['número_de_teléfono'] ?? r['numero_de_telefono']),
    correo: clean(r['correo_electrónico'] ?? r['correo_electronico'])?.toLowerCase() || null,
    lead_status: clean(r['lead_status']),
  };
}

/** Descarga la hoja y devuelve las filas ya normalizadas. */
export async function fetchMetaLeads() {
  const r = await fetch(CSV_URL, { redirect: 'follow' });
  if (!r.ok) {
    throw new Error(
      `Hoja de Google -> HTTP ${r.status}. Si es 401/403 el acceso por enlace fue ` +
      `revocado: hay que compartirla con una cuenta de servicio y usar META_SHEET_CSV_URL.`,
    );
  }
  const text = await r.text();
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('La hoja vino vacia');

  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i].some((c) => c && c.trim())) continue; // fila vacia
    const obj = {};
    header.forEach((h, k) => { obj[h] = rows[i][k]; });
    const lead = rowToMetaLead(obj);
    if (lead) out.push(lead);
  }
  return out;
}

export const sheetsConfig = { SHEET_ID, CSV_URL };
