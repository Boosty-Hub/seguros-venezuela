// ============================================================================
// Limpieza de Kommo. Corrige lo que quedo sucio de las cargas iniciales.
//
//   node --env-file=.env limpiar-kommo.mjs           aplica los cambios
//   node --env-file=.env limpiar-kommo.mjs --dry-run solo informa
//
// Hace tres cosas:
//   1) Etiqueta como "duplicado" los leads sobrantes de Zoho (varios tickets
//      para la misma solicitud) y en Supabase reapunta esos tickets al lead que
//      se conserva, para que el sync no los recree.
//   2) Normaliza a +58 el telefono de los contactos creados desde Zoho.
//   3) Agrega la etiqueta MetaAds a los leads de Zoho que ademas llegaron por
//      el formulario de Meta, para no perder la atribucion de origen.
//
// Todo se dirige desde Supabase, que es quien sabe que lead vino de que fuente.
// No se usa el filtro por etiqueta de la API: filter[tags][0][name] devuelve
// leads que no llevan la etiqueta pedida.
//
// OJO: la API de Kommo NO permite borrar leads (Allow: GET, PATCH). El borrado
// final es manual: filtrar por la etiqueta "duplicado" y eliminar desde la
// interfaz. Este script deja ese trabajo reducido a dos clics.
// ============================================================================
import {
  getLeadsByIds, addTagToLeads, getContacts, fixContactPhones, getAccount,
} from './lib/kommo.mjs';
import { getKommoDuplicados } from './lib/supa.mjs';

const DRY = process.argv.includes('--dry-run');
const TAG_DUP = process.env.KOMMO_TAG_DUPLICADO || 'duplicado';
const TAG_META = process.env.KOMMO_TAG_META || 'MetaAds';
const log = (...a) => console.log(new Date().toISOString(), ...a);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`Supabase GET ${path} -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/** Reapunta los tickets de un lead duplicado al lead que se conserva. */
async function reapuntarTickets(pares) {
  let total = 0;
  for (const { leadDuplicado, leadConservado } of pares) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tickets?kommo_lead_id=eq.${encodeURIComponent(leadDuplicado)}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({
          kommo_lead_id: leadConservado,
          kommo_error: `duplicado: el lead ${leadDuplicado} quedo etiquetado "${TAG_DUP}" para eliminar`,
        }),
      },
    );
    if (!r.ok) throw new Error(`PATCH tickets -> HTTP ${r.status}: ${await r.text()}`);
    total += (await r.json()).length;
  }
  return total;
}

// --------------------------------------------------------------------------
const acc = await getAccount();
log(`Kommo "${acc.subdomain}" · cuenta ${acc.id}${DRY ? ' · DRY-RUN' : ''}`);

// ---- Inventario real de leads segun Supabase ------------------------------
const idsZoho = [...new Set((await sbGet(
  'tickets?select=kommo_lead_id&kommo_lead_id=not.is.null&limit=20000',
)).map((x) => String(x.kommo_lead_id)))];
const idsMeta = new Set((await sbGet(
  'meta_leads?select=kommo_lead_id&kommo_lead_id=not.is.null&limit=20000',
)).map((x) => String(x.kommo_lead_id)));
log(`Inventario: ${idsZoho.length} lead(s) de Zoho · ${idsMeta.size} de Meta`);

// ---- 1. Duplicados de Zoho -----------------------------------------------
const grupos = await getKommoDuplicados();
const pares = [];
for (const g of grupos) {
  for (const dup of g.leads_duplicados || []) {
    if (!dup || String(dup) === String(g.lead_conservado)) continue;
    pares.push({ leadDuplicado: String(dup), leadConservado: String(g.lead_conservado) });
  }
}
const dupIds = pares.map((p) => p.leadDuplicado);
log(`1) Duplicados: ${grupos.length} grupo(s), ${dupIds.length} lead(s) sobrantes`);

const leadsDup = await getLeadsByIds(dupIds);
const faltan = dupIds.filter((id) => !leadsDup.some((l) => String(l.id) === id));
if (faltan.length) log(`   aviso: ${faltan.length} no existen en Kommo (ya eliminados)`);

if (DRY) {
  log(`   [dry-run] etiquetaria ${leadsDup.length} lead(s) como "${TAG_DUP}"`);
  log(`   [dry-run] reapuntaria ${pares.length} vinculo(s) en Supabase`);
} else {
  const n = await addTagToLeads(leadsDup, TAG_DUP);
  log(`   ${n} lead(s) etiquetados "${TAG_DUP}"`);
  const t = await reapuntarTickets(pares);
  log(`   ${t} ticket(s) reapuntados al lead conservado`);
}

// ---- 2. Telefonos de los contactos de origen Zoho -------------------------
log(`2) Telefonos: leyendo ${idsZoho.length} lead(s) de Zoho...`);
const leadsZoho = await getLeadsByIds(idsZoho);
const contactIds = [...new Set(leadsZoho.flatMap((l) => l.contactIds))];
log(`   ${contactIds.length} contacto(s) asociados`);
const contactos = await getContacts(contactIds);
const res = await fixContactPhones(contactos, { dryRun: DRY });
log(`   revisados ${res.revisados} · a corregir ${res.propuestos.length} · sin patron reconocible ${res.sin_arreglo}`);
for (const p of res.propuestos.slice(0, 4)) log(`     ${p.antes} -> ${p.despues}`);
if (!DRY) log(`   ${res.corregidos} telefono(s) normalizados a +58`);

// ---- 3. Atribucion doble en los leads compartidos ------------------------
const compartidos = leadsZoho.filter((l) => idsMeta.has(String(l.id)));
log(`3) Leads que entraron por Zoho Y por Meta: ${compartidos.length}`);
if (DRY) {
  log(`   [dry-run] les agregaria la etiqueta "${TAG_META}" (conservando ZohoDesk)`);
} else if (compartidos.length) {
  const n = await addTagToLeads(compartidos, TAG_META);
  log(`   ${n} lead(s) quedaron con ambas etiquetas`);
}

log('OK');
