// ============================================================================
// Cliente Kommo CRM (API v4) — crea leads a partir de tickets de Zoho Desk.
//
// Autenticacion: token de larga duracion de una integracion privada.
// El embudo y la etapa destino se resuelven POR NOMBRE en cada corrida, asi
// que si en Kommo renombran/reordenan las etapas esto sigue funcionando sin
// tocar codigo (se puede forzar con KOMMO_PIPELINE_ID / KOMMO_STATUS_ID).
// ============================================================================

import { normalizePhone, esVenezolanoCanonico } from './telefono.mjs';

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const TOKEN =
  process.env.KOMMO_LONG_LIVED_TOKEN ||
  process.env.TOKEN_LARGA_DURACION_KOMMO; // nombre usado en sync/.env

// Destino pedido por negocio: embudo de ventas, etapa "cliente por atender".
const PIPELINE_NAME = process.env.KOMMO_PIPELINE_NAME || 'VENTAS';
const STATUS_NAME = process.env.KOMMO_STATUS_NAME || 'cliente por atender';
const TAG = process.env.KOMMO_TAG || 'ZohoDesk';

const BATCH = 50;          // maximo de entidades por request en la API de Kommo
const PAUSE_MS = 250;      // el limite de Kommo es 7 req/s; vamos muy por debajo

function requireEnv() {
  const missing = [];
  if (!SUBDOMAIN) missing.push('KOMMO_SUBDOMAIN');
  if (!TOKEN) missing.push('KOMMO_LONG_LIVED_TOKEN (o TOKEN_LARGA_DURACION_KOMMO)');
  if (missing.length) throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
}

const base = () => `https://${SUBDOMAIN}.kommo.com/api/v4`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Llamada a la API con reintento ante 429 (rate limit) y 5xx. */
async function api(path, { method = 'GET', body = null, retries = 4 } = {}) {
  requireEnv();
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${base()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (r.status === 429 || r.status >= 500) {
      if (attempt >= retries) {
        throw new Error(`Kommo ${method} ${path} -> HTTP ${r.status} tras ${retries} reintentos`);
      }
      await sleep(1000 * 2 ** attempt); // backoff exponencial: 1s, 2s, 4s, 8s
      continue;
    }
    if (r.status === 204) return null; // sin contenido (p.ej. nada que crear)
    const txt = await r.text();
    if (!r.ok) {
      throw new Error(`Kommo ${method} ${path} -> HTTP ${r.status}: ${txt.slice(0, 500)}`);
    }
    return txt ? JSON.parse(txt) : null;
  }
}

/** Datos de la cuenta (sirve de healthcheck del token). */
export async function getAccount() {
  const a = await api('/account');
  return { id: a.id, subdomain: a.subdomain, currency: a.currency };
}

/**
 * Resuelve {pipelineId, statusId} por nombre, con override por env.
 * Sin argumentos: destino B2C (env KOMMO_PIPELINE_NAME/STATUS_NAME, default
 * "VENTAS"/"cliente por atender" — y el override total KOMMO_PIPELINE_ID/
 * KOMMO_STATUS_ID sigue aplicando SOLO en este caso). Con {pipelineName,
 * statusName} explicitos (ej. destino B2B) se resuelve siempre por nombre,
 * ignorando el override de env — cada destino tiene su propio par fijo.
 */
export async function resolveTarget({ pipelineName, statusName } = {}) {
  const usingDefault = !pipelineName && !statusName;
  if (usingDefault && process.env.KOMMO_PIPELINE_ID && process.env.KOMMO_STATUS_ID) {
    return {
      pipelineId: Number(process.env.KOMMO_PIPELINE_ID),
      statusId: Number(process.env.KOMMO_STATUS_ID),
      pipelineName: '(por env)',
      statusName: '(por env)',
    };
  }
  const wantPipeline = pipelineName || PIPELINE_NAME;
  const wantStatus = statusName || STATUS_NAME;

  const d = await api('/leads/pipelines');
  const pipelines = d?._embedded?.pipelines || [];
  const norm = (s) => String(s || '').trim().toLowerCase();

  const pipeline =
    pipelines.find((p) => norm(p.name) === norm(wantPipeline)) ||
    pipelines.find((p) => norm(p.name).includes(norm(wantPipeline))) ||
    (usingDefault ? pipelines.find((p) => p.is_main) : null);
  if (!pipeline) throw new Error(`No se encontro el embudo "${wantPipeline}" en Kommo`);

  const statuses = pipeline._embedded?.statuses || [];
  const status = statuses.find((s) => norm(s.name) === norm(wantStatus));
  if (!status) {
    const nombres = statuses.map((s) => s.name).join(' | ');
    throw new Error(`No se encontro la etapa "${wantStatus}" en el embudo "${pipeline.name}". Etapas: ${nombres}`);
  }
  return {
    pipelineId: pipeline.id,
    statusId: status.id,
    pipelineName: pipeline.name,
    statusName: status.name,
  };
}

// Destino B2B: corredores/intermediarios que cotizan via Sofi u otras
// plataformas (cualquier ticket cuyo Asesor NO sea uno de los 4 valores de
// "sin asesor real" — ver FILTRO_SIN_ASESOR en lib/supa.mjs).
const PIPELINE_NAME_B2B = process.env.KOMMO_PIPELINE_NAME_B2B || 'VENTAS B2B';
const STATUS_NAME_B2B = process.env.KOMMO_STATUS_NAME_B2B || 'DATA ZOHO DESK';
export const resolveTargetB2B = () =>
  resolveTarget({ pipelineName: PIPELINE_NAME_B2B, statusName: STATUS_NAME_B2B });

/* ---------------------------------------------------------------------------
 * Mapeo ticket de Zoho -> lead de Kommo
 * -------------------------------------------------------------------------*/
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
const unixSec = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
};

export function ticketToLead(t, { pipelineId, statusId }) {
  const nombre =
    trunc(t.subject, 250) ||
    (t.ticket_number ? `Ticket #${t.ticket_number}` : `Ticket ${t.id}`);

  const lead = {
    name: nombre,
    pipeline_id: pipelineId,
    status_id: statusId,
    created_at: unixSec(t.created_time),
    // request_id nos lo devuelve Kommo tal cual: es como amarramos el lead
    // creado con el ticket de origen sin depender del orden de la respuesta.
    request_id: String(t.id),
    _embedded: { tags: [{ name: TAG }] },
  };

  // El precio del lead en Kommo es entero. Usamos la prima anual si existe.
  const prima = Number(t.monto_prima);
  if (Number.isFinite(prima) && prima > 0) lead.price = Math.round(prima);

  // Contacto: Kommo deduplica/fusiona si ya existe (devuelve merged: true).
  // El telefono se normaliza a +58: Zoho lo guarda como "04241333536".
  const contactFields = [];
  const tel = normalizePhone(t.phone);
  if (t.email) contactFields.push({ field_code: 'EMAIL', values: [{ value: String(t.email), enum_code: 'WORK' }] });
  if (tel) contactFields.push({ field_code: 'PHONE', values: [{ value: tel, enum_code: 'WORK' }] });
  const contactName = t.contact_name || t.titular;
  if (contactName || contactFields.length) {
    lead._embedded.contacts = [{
      name: trunc(contactName || t.email || t.phone || 'Sin nombre', 250),
      ...(contactFields.length ? { custom_fields_values: contactFields } : {}),
    }];
  }
  return lead;
}

/* ---------------------------------------------------------------------------
 * Mapeo lead de Meta (hoja de marketing) -> lead de Kommo
 * -------------------------------------------------------------------------*/
const TAG_META = process.env.KOMMO_TAG_META || 'MetaAds';

export function metaLeadToLead(m, { pipelineId, statusId }) {
  const lead = {
    name: trunc(m.nombre_completo, 250) || m.correo || m.telefono || `Lead Meta ${m.id}`,
    pipeline_id: pipelineId,
    status_id: statusId,
    created_at: unixSec(m.created_time),
    request_id: String(m.id),
    _embedded: { tags: [{ name: TAG_META }] },
  };

  const contactFields = [];
  if (m.correo) contactFields.push({ field_code: 'EMAIL', values: [{ value: String(m.correo), enum_code: 'WORK' }] });
  if (m.telefono) contactFields.push({ field_code: 'PHONE', values: [{ value: String(m.telefono), enum_code: 'MOB' }] });
  lead._embedded.contacts = [{
    name: trunc(m.nombre_completo || m.correo || m.telefono || 'Sin nombre', 250),
    ...(contactFields.length ? { custom_fields_values: contactFields } : {}),
  }];
  return lead;
}

/** Nota con la atribucion de campana del lead de Meta. */
export function metaLeadToNote(m) {
  const edad = (() => {
    if (!m.fecha_nacimiento) return null;
    const b = new Date(m.fecha_nacimiento), n = new Date(m.created_time || Date.now());
    let a = n.getFullYear() - b.getFullYear();
    if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
    return Number.isFinite(a) && a > 0 && a < 120 ? a : null;
  })();
  return [
    'Origen: Meta Lead Ads',
    m.platform ? `Plataforma: ${m.platform === 'ig' ? 'Instagram' : m.platform === 'fb' ? 'Facebook' : m.platform}` : null,
    m.campaign_name ? `Campana: ${m.campaign_name}` : null,
    m.adset_name ? `Conjunto: ${m.adset_name}` : null,
    m.ad_name ? `Anuncio: ${m.ad_name}` : null,
    m.form_name ? `Formulario: ${m.form_name}` : null,
    m.fecha_nacimiento ? `Fecha de nacimiento: ${m.fecha_nacimiento}${edad ? ` (${edad} anos)` : ''}` : null,
    m.telefono_raw && m.telefono_raw !== m.telefono ? `Telefono en la hoja: ${m.telefono_raw}` : null,
    `ID de Meta: ${m.id}`,
  ].filter(Boolean).join('\n');
}

/** Texto de la nota que deja la trazabilidad hacia Zoho dentro del lead. */
export function ticketToNote(t) {
  const l = [
    `Origen: Zoho Desk`,
    t.ticket_number ? `Ticket #${t.ticket_number}` : null,
    t.status ? `Etapa en Zoho: ${t.status}` : null,
    t.channel ? `Canal: ${t.channel}` : null,
    t.asesor ? `Asesor: ${t.asesor}` : null,
    t.plan_hcm ? `Plan: ${t.plan_hcm}` : null,
    t.monto_prima ? `Prima anual: ${t.monto_prima} ${t.moneda || ''}`.trim() : null,
    t.web_url ? `Ver en Zoho: ${t.web_url}` : null,
  ].filter(Boolean);
  return l.join('\n');
}

/* ---------------------------------------------------------------------------
 * Creacion
 * -------------------------------------------------------------------------*/

/**
 * Crea leads (con contacto y etiqueta) en lotes.
 * `mapFn` decide el mapeo: ticketToLead para Zoho, metaLeadToLead para Meta.
 * Devuelve [{ sourceId, leadId, contactId, merged }].
 */
export async function createLeads(items, target, mapFn = ticketToLead) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const payload = chunk.map((t) => mapFn(t, target));
    const res = await api('/leads/complex', { method: 'POST', body: payload });
    const arr = Array.isArray(res) ? res : [];

    // Kommo responde en el mismo orden, pero nos fiamos de request_id.
    for (let k = 0; k < chunk.length; k++) {
      const t = chunk[k];
      const hit = arr.find((x) => String(x?.request_id) === String(t.id)) || arr[k];
      if (hit?.id) {
        out.push({
          sourceId: t.id,
          leadId: String(hit.id),
          contactId: hit.contact_id ? String(hit.contact_id) : null,
          merged: Boolean(hit.merged),
        });
      } else {
        out.push({ sourceId: t.id, leadId: null, error: 'Kommo no devolvio id para este registro' });
      }
    }
    await sleep(PAUSE_MS);
  }
  return out;
}

/** Adjunta a cada lead una nota con su trazabilidad al origen. */
export async function addNotes(pairs, byId, noteFn = ticketToNote) {
  const withLead = pairs.filter((p) => p.leadId);
  let done = 0;
  for (let i = 0; i < withLead.length; i += BATCH) {
    const chunk = withLead.slice(i, i + BATCH);
    const payload = chunk.map((p) => ({
      entity_id: Number(p.leadId),
      note_type: 'common',
      params: { text: noteFn(byId.get(p.sourceId) || {}) },
    }));
    try {
      await api('/leads/notes', { method: 'POST', body: payload });
      done += chunk.length;
    } catch (e) {
      // Una nota que falla no debe invalidar el lead ya creado.
      console.warn('  aviso: no se pudieron crear notas del lote:', e.message);
    }
    await sleep(PAUSE_MS);
  }
  return done;
}

/* ---------------------------------------------------------------------------
 * Mantenimiento: etiquetado de duplicados y correccion de telefonos
 * -------------------------------------------------------------------------*/

/**
 * Trae leads por id concretos, con sus etiquetas y contactos.
 * Se prefiere esto al filtro por etiqueta: filter[tags][0][name] no filtra de
 * forma fiable en la API y devuelve leads que no llevan la etiqueta pedida.
 */
export async function getLeadsByIds(ids) {
  const out = [];
  const unicos = [...new Set(ids.map(String))];
  for (let i = 0; i < unicos.length; i += BATCH) {
    const chunk = unicos.slice(i, i + BATCH);
    const q = `/leads?${chunk.map((id) => `filter[id][]=${id}`).join('&')}&with=contacts&limit=${BATCH}`;
    const d = await api(q);
    for (const l of d?._embedded?.leads || []) {
      out.push({
        id: l.id,
        name: l.name,
        tags: (l._embedded?.tags || []).map((t) => t.name),
        contactIds: (l._embedded?.contacts || []).map((c) => c.id),
      });
    }
    await sleep(PAUSE_MS);
  }
  return out;
}

/** Recorre todos los leads que tengan una etiqueta. Devuelve [{id,name,tags,contactIds}]. */
export async function getLeadsByTag(tag, { pageLimit = 250 } = {}) {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const q = `/leads?filter[tags][0][name]=${encodeURIComponent(tag)}` +
              `&with=contacts&page=${page}&limit=${pageLimit}`;
    const d = await api(q);
    const leads = d?._embedded?.leads || [];
    for (const l of leads) {
      out.push({
        id: l.id,
        name: l.name,
        tags: (l._embedded?.tags || []).map((t) => t.name),
        contactIds: (l._embedded?.contacts || []).map((c) => c.id),
      });
    }
    if (leads.length < pageLimit) break;
    await sleep(PAUSE_MS);
  }
  return out;
}

/**
 * Agrega una etiqueta a varios leads CONSERVANDO las que ya tienen.
 * PATCH sobre _embedded.tags reemplaza la lista completa, asi que hay que
 * reenviar las existentes o se pierden.
 */
export async function addTagToLeads(leads, nuevaTag) {
  let done = 0;
  const pendientes = leads.filter((l) => !l.tags.includes(nuevaTag));
  for (let i = 0; i < pendientes.length; i += BATCH) {
    const chunk = pendientes.slice(i, i + BATCH);
    const payload = chunk.map((l) => ({
      id: Number(l.id),
      _embedded: { tags: [...new Set([...l.tags, nuevaTag])].map((name) => ({ name })) },
    }));
    await api('/leads', { method: 'PATCH', body: payload });
    done += chunk.length;
    await sleep(PAUSE_MS);
  }
  return done;
}

/** Trae contactos por id, en lotes. Devuelve [{id, name, telefono}]. */
export async function getContacts(ids) {
  const out = [];
  const unicos = [...new Set(ids.map(Number))];
  for (let i = 0; i < unicos.length; i += BATCH) {
    const chunk = unicos.slice(i, i + BATCH);
    const q = `/contacts?${chunk.map((id) => `filter[id][]=${id}`).join('&')}&limit=${BATCH}`;
    const d = await api(q);
    for (const c of d?._embedded?.contacts || []) {
      const tel = (c.custom_fields_values || [])
        .find((f) => f.field_code === 'PHONE')?.values?.[0]?.value ?? null;
      out.push({ id: c.id, name: c.name, telefono: tel });
    }
    await sleep(PAUSE_MS);
  }
  return out;
}

/**
 * Corrige el telefono de los contactos cuyo valor no este en formato +58.
 * Devuelve { revisados, corregidos, sin_arreglo }.
 */
export async function fixContactPhones(contacts, { dryRun = false } = {}) {
  const arreglos = [];
  let sinArreglo = 0;
  for (const c of contacts) {
    if (!c.telefono) continue;
    if (esVenezolanoCanonico(c.telefono)) continue;
    const nuevo = normalizePhone(c.telefono);
    if (!nuevo || nuevo === c.telefono) { sinArreglo++; continue; }
    arreglos.push({ id: c.id, antes: c.telefono, despues: nuevo });
  }
  if (dryRun) return { revisados: contacts.length, corregidos: 0, propuestos: arreglos, sin_arreglo: sinArreglo };

  let done = 0;
  for (let i = 0; i < arreglos.length; i += BATCH) {
    const chunk = arreglos.slice(i, i + BATCH);
    const payload = chunk.map((a) => ({
      id: Number(a.id),
      custom_fields_values: [{ field_code: 'PHONE', values: [{ value: a.despues, enum_code: 'WORK' }] }],
    }));
    await api('/contacts', { method: 'PATCH', body: payload });
    done += chunk.length;
    await sleep(PAUSE_MS);
  }
  return { revisados: contacts.length, corregidos: done, propuestos: arreglos, sin_arreglo: sinArreglo };
}

export const kommoConfig = {
  PIPELINE_NAME, STATUS_NAME, TAG, SUBDOMAIN,
  PIPELINE_NAME_B2B, STATUS_NAME_B2B,
};
