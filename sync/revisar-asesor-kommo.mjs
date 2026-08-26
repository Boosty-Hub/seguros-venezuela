// ============================================================================
// Etiqueta en Kommo los leads de Zoho que se migraron ANTES de activar el
// filtro de Asesor. Regla vigente (ver lib/supa.mjs, FILTRO_SIN_ASESOR): solo
// deben entrar al CRM los tickets cuyo campo "Asesor" sea "No tengo", "Sin
// Asesor", "Sin Asesor (KG)" o "Seguros Venezuela" (variantes de
// mayusculas/espacios/sufijos toleradas).
//
//   node --env-file=.env revisar-asesor-kommo.mjs           aplica la etiqueta
//   node --env-file=.env revisar-asesor-kommo.mjs --dry-run solo informa
//
// No borra nada (la API de Kommo no lo permite, ver limpiar-kommo.mjs): deja
// la etiqueta "revisar-asesor" para que alguien decida a mano si el lead se
// queda o se elimina desde la interfaz.
// ============================================================================
import { getLeadsByIds, addTagToLeads, getAccount } from './lib/kommo.mjs';
import { getTicketsKommoConAsesor } from './lib/supa.mjs';

const DRY = process.argv.includes('--dry-run');
const TAG = process.env.KOMMO_TAG_REVISAR_ASESOR || 'revisar-asesor';
const log = (...a) => console.log(new Date().toISOString(), ...a);

const acc = await getAccount();
log(`Kommo "${acc.subdomain}" · cuenta ${acc.id}${DRY ? ' · DRY-RUN' : ''}`);

const tickets = await getTicketsKommoConAsesor({ limit: 5000 });
log(`Tickets ya en Kommo que NO cumplen el filtro de asesor: ${tickets.length}`);
for (const t of tickets.slice(0, 5)) {
  log(`  #${t.ticket_number} · asesor="${t.asesor ?? '(vacio)'}" · lead ${t.kommo_lead_id}`);
}
if (tickets.length > 5) log(`  ...y ${tickets.length - 5} mas`);

if (!tickets.length) { log('OK'); process.exit(0); }

const leadIds = [...new Set(tickets.map((t) => String(t.kommo_lead_id)))];
const leads = await getLeadsByIds(leadIds);
const faltan = leadIds.filter((id) => !leads.some((l) => String(l.id) === id));
if (faltan.length) log(`  aviso: ${faltan.length} lead(s) ya no existen en Kommo`);

if (DRY) {
  log(`[dry-run] etiquetaria ${leads.length} lead(s) como "${TAG}"`);
} else {
  const n = await addTagToLeads(leads, TAG);
  log(`${n} lead(s) etiquetados "${TAG}"`);
}

log('OK');
