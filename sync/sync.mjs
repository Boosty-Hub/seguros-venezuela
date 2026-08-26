// ============================================================================
// Sincronizacion Zoho Desk -> Supabase
//
//   node sync.mjs full         Trae TODOS los tickets (campos nucleo) + enrich
//   node sync.mjs incremental  Solo tickets modificados desde el ultimo sync
//   node sync.mjs enrich        Rellena customFields (monto de prima, plan...)
//
// Sin dependencias externas: usa fetch nativo (Node 18+).
// ============================================================================
import { fetchTicketsPage, fetchTicketDetail, sleep, config } from './lib/zoho.mjs';
import {
  upsertTickets, updateSyncState, getCreatedWatermark, getOpenTicketsToRefresh,
  getTicketsMissingDetail, countTickets,
  getKommoState, getTicketsPendingKommo, markKommoSynced, getTicketsYaEnKommo,
  getKommoB2BState, getTicketsPendingKommoB2B,
  upsertMetaLeads, getMetaState, getMetaLeadsPendingKommo, markMetaKommoSynced,
  getMetaLeadsYaEnZoho, insertSyncLog,
} from './lib/supa.mjs';
import { ticketToRow } from './lib/parse.mjs';
import {
  getAccount, resolveTarget, resolveTargetB2B, createLeads, addNotes, ticketToLead,
  metaLeadToLead, metaLeadToNote, kommoConfig,
} from './lib/kommo.mjs';
import { fetchMetaLeads, sheetsConfig } from './lib/sheets.mjs';

const LIMIT = 100;
const ENRICH_CONCURRENCY = 5;
const MAX_PAGES = 1000; // salvaguarda anti-bucle (100k tickets)

function log(...a) { console.log(new Date().toISOString(), ...a); }

// -------- bitacora: se acumula durante la corrida y se graba al final --------
const STATS = {
  started_at: new Date().toISOString(),
  entorno: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
  tickets_nuevos: 0,
  tickets_refrescados: 0,
  leads_zoho_creados: 0,
  zoho_vinculados: 0,
  meta_filas_hoja: 0,
  leads_meta_creados: 0,
  meta_vinculados: 0,
  detalle: {},
};

// -------- pool de concurrencia simple --------
async function pool(items, worker, concurrency) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (e) { results[idx] = { error: String(e) }; }
    }
  });
  await Promise.all(runners);
  return results;
}

// -------- FULL: todos los tickets (nucleo), orden ascendente estable --------
async function fullSync() {
  log(`FULL sync · departamento ${config.DEPARTMENT_ID}`);
  let from = 1, page = 0, total = 0;
  for (; page < MAX_PAGES; page++) {
    const tickets = await fetchTicketsPage({ from, limit: LIMIT, sortBy: 'createdTime' });
    if (!tickets.length) break;
    const rows = tickets.map(ticketToRow);
    await upsertTickets(rows);
    total += rows.length;
    from += LIMIT;
    if (page % 10 === 0) log(`  ...${total} tickets`);
    if (tickets.length < LIMIT) break;
  }
  log(`FULL sync core listo: ${total} tickets`);
  const count = await countTickets();
  await updateSyncState({ last_full_sync: new Date().toISOString(), total_tickets: count, last_run_inserted: total, last_error: null });
  return total;
}

// -------- ENRICH: customFields (monto prima, plan, asesor...) --------
async function enrich({ onlyOpen = true, max = 6000 } = {}) {
  log(`ENRICH · customFields (${onlyOpen ? 'solo abiertos' : 'todos'}) max=${max}`);
  const ids = (await getTicketsMissingDetail({ onlyOpen, limit: max }));
  if (!ids.length) { log('  nada que enriquecer'); return 0; }
  log(`  ${ids.length} tickets a enriquecer`);
  let done = 0;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const details = await pool(chunk, async (id) => {
      const d = await fetchTicketDetail(id);
      return d && d.id ? ticketToRow(d) : null;
    }, ENRICH_CONCURRENCY);
    const rows = details.filter((r) => r && !r.error);
    if (rows.length) await upsertTickets(rows);
    done += rows.length;
    log(`  enriquecidos ${done}/${ids.length}`);
    await sleep(300);
  }
  log(`ENRICH listo: ${done} tickets`);
  return done;
}

// -------- INCREMENTAL: tickets nuevos + refresco de etapas --------
//
// OJO: el listado de Zoho Desk (/tickets) NO devuelve modifiedTime, y
// sortBy=-modifiedTime no ordena de forma util. Por eso el watermark es
// createdTime (que si viene y si ordena bien con -createdTime).
// Los cambios de ETAPA se detectan con una pasada acotada que re-consulta el
// detalle de los tickets abiertos mas "rancios" (synced_at mas antiguo).
async function incrementalSync({ refreshOpen = 200 } = {}) {
  const watermark = await getCreatedWatermark();
  log(`INCREMENTAL sync · nuevos desde createdTime > ${watermark || '(sin watermark -> full)'}`);
  if (!watermark) return fullSync().then(() => enrich());

  const wmMs = new Date(watermark).getTime();
  let from = 1, page = 0;
  const nuevos = [];
  outer: for (; page < MAX_PAGES; page++) {
    const tickets = await fetchTicketsPage({ from, limit: LIMIT, sortBy: '-createdTime' });
    if (!tickets.length) break;
    for (const t of tickets) {
      const ct = t.createdTime ? new Date(t.createdTime).getTime() : 0;
      if (ct <= wmMs) break outer; // llegamos a lo ya sincronizado
      nuevos.push(t.id);
    }
    from += LIMIT;
    if (tickets.length < LIMIT) break;
  }
  log(`  ${nuevos.length} ticket(s) nuevo(s)`);

  // Detalle (trae customFields Y modifiedTime) de los nuevos.
  let insertados = 0;
  if (nuevos.length) {
    const details = await pool(nuevos, async (id) => {
      const d = await fetchTicketDetail(id);
      return d && d.id ? ticketToRow(d) : null;
    }, ENRICH_CONCURRENCY);
    const rows = details.filter((r) => r && !r.error);
    await upsertTickets(rows);
    insertados = rows.length;
  }

  // Refresco de etapas: los abiertos que llevan mas tiempo sin actualizarse.
  let refrescados = 0;
  if (refreshOpen > 0) {
    const ids = await getOpenTicketsToRefresh({ limit: refreshOpen });
    if (ids.length) {
      const details = await pool(ids, async (id) => {
        const d = await fetchTicketDetail(id);
        return d && d.id ? ticketToRow(d) : null;
      }, ENRICH_CONCURRENCY);
      const rows = details.filter((r) => r && !r.error);
      if (rows.length) await upsertTickets(rows);
      refrescados = rows.length;
    }
  }

  const count = await countTickets();
  await updateSyncState({
    last_incremental_sync: new Date().toISOString(),
    total_tickets: count,
    last_run_inserted: insertados,
    last_run_updated: refrescados,
    last_error: null,
  });
  STATS.tickets_nuevos = insertados;
  STATS.tickets_refrescados = refrescados;
  log(`INCREMENTAL listo: ${insertados} nuevo(s), ${refrescados} refrescado(s), total ${count}`);
  return insertados;
}

// -------- KOMMO: crear leads de los tickets nuevos --------
const kommoEnabled = () =>
  Boolean(process.env.KOMMO_SUBDOMAIN &&
    (process.env.KOMMO_LONG_LIVED_TOKEN || process.env.TOKEN_LARGA_DURACION_KOMMO));

/**
 * Envia a Kommo los tickets creados despues del corte que aun no tienen lead.
 * Idempotente: se apoya en tickets.kommo_lead_id, nunca duplica un ticket.
 */
async function pushToKommo({ dryRun = false, limit = 200 } = {}) {
  const { kommo_since: since } = await getKommoState();
  if (!since) {
    log('KOMMO: sin corte configurado. Ejecuta primero: node sync.mjs kommo-init [ISO|now]');
    return 0;
  }

  const target = await resolveTarget();
  log(`KOMMO${dryRun ? ' (DRY-RUN)' : ''} · embudo "${target.pipelineName}" (${target.pipelineId}) ` +
      `· etapa "${target.statusName}" (${target.statusId}) · etiqueta "${kommoConfig.TAG}"`);
  log(`  corte: tickets creados desde ${since}`);

  let pend = await getTicketsPendingKommo({ since, limit });
  if (!pend.length) { log('  no hay tickets nuevos por enviar'); return 0; }
  log(`  ${pend.length} ticket(s) por enviar`);

  // ---- Control de duplicados, dos pasadas ----
  // (1) Contra lo ya creado: Zoho abre varios tickets para la misma solicitud.
  const yaEnKommo = await getTicketsYaEnKommo({ since });
  const mapaYa = new Map(yaEnKommo.map((x) => [x.ticket_id, x]));
  const vinculados = pend.filter((p) => mapaYa.has(p.id));
  if (vinculados.length) {
    STATS.zoho_vinculados += vinculados.length;
    log(`  ${vinculados.length} duplicado(s) de Zoho: se vinculan al lead existente en vez de crearse`);
    for (const v of vinculados.slice(0, 3)) {
      const x = mapaYa.get(v.id);
      log(`    - #${v.ticket_number} == #${x.origen_ticket} -> lead ${x.kommo_lead_id}`);
    }
    if (!dryRun) {
      await markKommoSynced(vinculados.map((v) => ({
        sourceId: v.id, leadId: mapaYa.get(v.id).kommo_lead_id,
      })));
    }
    pend = pend.filter((p) => !mapaYa.has(p.id));
  }

  // (2) Dentro del propio lote: si dos tickets nuevos son equivalentes, solo
  // uno crea el lead y el resto se vincula despues de crearlo.
  const claveTicket = (t) =>
    `${(t.subject || '').toLowerCase()}|` +
    `${(t.email || '').toLowerCase() || String(t.phone || '').replace(/\D/g, '') || (t.contact_name || '').toLowerCase()}|` +
    `${(t.titular || '').toLowerCase()}`;
  const primeros = new Map();
  const secundarios = [];
  for (const t of pend) {
    const k = claveTicket(t);
    if (primeros.has(k)) secundarios.push({ ticket: t, clave: k });
    else primeros.set(k, t);
  }
  if (secundarios.length) {
    log(`  ${secundarios.length} duplicado(s) dentro del lote: se vincularan al hermano`);
    pend = [...primeros.values()];
  }

  if (dryRun) {
    for (const t of pend.slice(0, 5)) {
      const lead = ticketToLead(t, target);
      log(`  [dry-run] ticket ${t.ticket_number || t.id} -> ${JSON.stringify(lead)}`);
    }
    if (pend.length > 5) log(`  [dry-run] ...y ${pend.length - 5} mas`);
    return 0;
  }

  if (!pend.length) { log('  nada por crear tras el control de duplicados'); return 0; }

  const pairs = await createLeads(pend, target);
  const byId = new Map(pend.map((t) => [t.id, t]));
  await addNotes(pairs, byId);

  // Los duplicados del lote heredan el lead que acaba de crear su hermano.
  if (secundarios.length) {
    const leadPorClave = new Map();
    for (const p of pairs) {
      if (!p.leadId) continue;
      const t = byId.get(p.sourceId);
      if (t) leadPorClave.set(claveTicket(t), p.leadId);
    }
    const herencia = secundarios
      .map((s) => ({ sourceId: s.ticket.id, leadId: leadPorClave.get(s.clave) }))
      .filter((x) => x.leadId);
    if (herencia.length) await markKommoSynced(herencia);
    STATS.zoho_vinculados += herencia.length;
    log(`  ${herencia.length} duplicado(s) del lote vinculados al lead de su hermano`);
  }

  const ok = await markKommoSynced(pairs);
  const fail = pairs.length - ok;
  const fusionados = pairs.filter((p) => p.merged).length;

  const st = await getKommoState();
  await updateSyncState({
    kommo_last_run: new Date().toISOString(),
    kommo_last_pushed: ok,
    kommo_total: (st.kommo_total || 0) + ok,
    kommo_last_error: fail ? `${fail} ticket(s) sin lead` : null,
  });
  STATS.leads_zoho_creados = ok;
  log(`KOMMO listo: ${ok} lead(s) creados${fusionados ? ` (${fusionados} con contacto fusionado)` : ''}` +
      `${fail ? `, ${fail} con error` : ''}`);
  return ok;
}

// -------- KOMMO B2B: corredores/intermediarios (asesor real) --------
//
// Espejo de pushToKommo() pero para el otro lado del filtro de Asesor:
// tickets CON un corredor/asesor real asignado (cotizan via Sofi u otras
// plataformas) van al embudo "VENTAS B2B" / etapa "DATA ZOHO DESK" en vez
// de "VENTAS B2C". Corte propio (kommo_b2b_since), independiente del de B2C.
async function pushToKommoB2B({ dryRun = false, limit = 200 } = {}) {
  const { kommo_b2b_since: since } = await getKommoB2BState();
  if (!since) {
    log('KOMMO B2B: sin corte configurado. Ejecuta primero: node sync.mjs kommo-b2b-init [ISO|now]');
    return 0;
  }

  const target = await resolveTargetB2B();
  log(`KOMMO B2B${dryRun ? ' (DRY-RUN)' : ''} · embudo "${target.pipelineName}" (${target.pipelineId}) ` +
      `· etapa "${target.statusName}" (${target.statusId}) · etiqueta "${kommoConfig.TAG}"`);
  log(`  corte: tickets creados desde ${since}`);

  let pend = await getTicketsPendingKommoB2B({ since, limit });
  if (!pend.length) { log('  no hay tickets nuevos por enviar'); return 0; }
  log(`  ${pend.length} ticket(s) por enviar`);

  // Mismo control de duplicados que pushToKommo(): (1) contra lo ya creado
  // en Kommo (por cualquiera de los dos embudos — la clave es la persona,
  // no el destino), (2) dentro del propio lote.
  const yaEnKommo = await getTicketsYaEnKommo({ since });
  const mapaYa = new Map(yaEnKommo.map((x) => [x.ticket_id, x]));
  const vinculados = pend.filter((p) => mapaYa.has(p.id));
  if (vinculados.length) {
    STATS.detalle.zoho_b2b_vinculados = (STATS.detalle.zoho_b2b_vinculados || 0) + vinculados.length;
    log(`  ${vinculados.length} duplicado(s) de Zoho: se vinculan al lead existente en vez de crearse`);
    if (!dryRun) {
      await markKommoSynced(vinculados.map((v) => ({
        sourceId: v.id, leadId: mapaYa.get(v.id).kommo_lead_id,
      })));
    }
    pend = pend.filter((p) => !mapaYa.has(p.id));
  }

  const claveTicket = (t) =>
    `${(t.subject || '').toLowerCase()}|` +
    `${(t.email || '').toLowerCase() || String(t.phone || '').replace(/\D/g, '') || (t.contact_name || '').toLowerCase()}|` +
    `${(t.titular || '').toLowerCase()}`;
  const primeros = new Map();
  const secundarios = [];
  for (const t of pend) {
    const k = claveTicket(t);
    if (primeros.has(k)) secundarios.push({ ticket: t, clave: k });
    else primeros.set(k, t);
  }
  if (secundarios.length) {
    log(`  ${secundarios.length} duplicado(s) dentro del lote: se vincularan al hermano`);
    pend = [...primeros.values()];
  }

  if (dryRun) {
    for (const t of pend.slice(0, 5)) {
      const lead = ticketToLead(t, target);
      log(`  [dry-run] ticket ${t.ticket_number || t.id} -> ${JSON.stringify(lead)}`);
    }
    if (pend.length > 5) log(`  [dry-run] ...y ${pend.length - 5} mas`);
    return 0;
  }

  if (!pend.length) { log('  nada por crear tras el control de duplicados'); return 0; }

  const pairs = await createLeads(pend, target);
  const byId = new Map(pend.map((t) => [t.id, t]));
  await addNotes(pairs, byId);

  if (secundarios.length) {
    const leadPorClave = new Map();
    for (const p of pairs) {
      if (!p.leadId) continue;
      const t = byId.get(p.sourceId);
      if (t) leadPorClave.set(claveTicket(t), p.leadId);
    }
    const herencia = secundarios
      .map((s) => ({ sourceId: s.ticket.id, leadId: leadPorClave.get(s.clave) }))
      .filter((x) => x.leadId);
    if (herencia.length) await markKommoSynced(herencia);
    STATS.detalle.zoho_b2b_vinculados = (STATS.detalle.zoho_b2b_vinculados || 0) + herencia.length;
    log(`  ${herencia.length} duplicado(s) del lote vinculados al lead de su hermano`);
  }

  const ok = await markKommoSynced(pairs);
  const fail = pairs.length - ok;
  const fusionados = pairs.filter((p) => p.merged).length;

  const st = await getKommoB2BState();
  await updateSyncState({
    kommo_b2b_last_run: new Date().toISOString(),
    kommo_b2b_last_pushed: ok,
    kommo_b2b_total: (st.kommo_b2b_total || 0) + ok,
    kommo_b2b_last_error: fail ? `${fail} ticket(s) sin lead` : null,
  });
  STATS.detalle.leads_zoho_b2b_creados = ok;
  log(`KOMMO B2B listo: ${ok} lead(s) creados${fusionados ? ` (${fusionados} con contacto fusionado)` : ''}` +
      `${fail ? `, ${fail} con error` : ''}`);
  return ok;
}

/** Fija el corte B2B: a partir de que momento se envian tickets con asesor a VENTAS B2B. */
async function kommoInitB2B(arg) {
  const iso = (!arg || arg === 'now') ? new Date().toISOString() : new Date(arg).toISOString();
  if (Number.isNaN(Date.parse(iso))) throw new Error(`Fecha de corte invalida: ${arg}`);
  const acc = await getAccount();
  const target = await resolveTargetB2B();
  await updateSyncState({ kommo_b2b_since: iso });
  log(`KOMMO B2B conectado a "${acc.subdomain}" (cuenta ${acc.id}, ${acc.currency})`);
  log(`  destino: embudo "${target.pipelineName}" / etapa "${target.statusName}" / etiqueta "${kommoConfig.TAG}"`);
  log(`  corte fijado en ${iso} — solo se enviaran tickets creados desde ese instante`);
}

// -------- META: hoja de Google -> Supabase -> Kommo --------
//
// Dos pasos independientes:
//   1) La hoja completa se replica en public.meta_leads (upsert por id de Meta).
//   2) Los leads posteriores al corte que no tengan lead se crean en Kommo.
// El paso 1 corre siempre; el 2 solo si hay corte configurado.
async function syncMeta({ dryRun = false, limit = 500, skipSolapados = true } = {}) {
  log(`META · hoja ${sheetsConfig.SHEET_ID}`);
  const filas = await fetchMetaLeads();
  STATS.meta_filas_hoja = filas.length;
  log(`  ${filas.length} lead(s) en la hoja`);
  const guardados = await upsertMetaLeads(filas);
  log(`  ${guardados} replicado(s) en Supabase`);

  const { meta_since: since } = await getMetaState();
  if (!since) {
    log('  sin corte para Kommo. Ejecuta: node sync.mjs meta-init [ISO|now]');
    await updateSyncState({ meta_last_run: new Date().toISOString(), meta_total: filas.length });
    return 0;
  }

  const target = await resolveTarget();
  let pend = await getMetaLeadsPendingKommo({ since, limit });
  log(`  ${pend.length} pendiente(s) de Kommo desde ${since}`);
  if (!pend.length) {
    await updateSyncState({ meta_last_run: new Date().toISOString(), meta_total: filas.length });
    return 0;
  }

  // Anti-duplicado cruzado: si la persona ya entro por un ticket de Zoho y ese
  // ticket ya tiene lead en Kommo, no creamos un segundo lead para la misma
  // persona. Se marca con una nota de por que se omitio.
  if (skipSolapados) {
    const solapados = await getMetaLeadsYaEnZoho({ since });
    const mapa = new Map(solapados.map((s) => [s.meta_id, s]));
    const omitidos = pend.filter((p) => mapa.has(p.id));
    if (omitidos.length) {
      STATS.meta_vinculados += omitidos.length;
      log(`  ${omitidos.length} omitido(s): ya estan en Kommo via ticket de Zoho`);
      for (const o of omitidos.slice(0, 5)) {
        const s = mapa.get(o.id);
        log(`    - ${o.nombre_completo} (${s.coincide_por}) -> lead ${s.kommo_lead_id} del ticket #${s.ticket_number}`);
      }
      if (!dryRun) {
        await markMetaKommoSynced(omitidos.map((o) => ({
          sourceId: o.id,
          leadId: mapa.get(o.id).kommo_lead_id,   // se reutiliza el lead existente
        })));
      }
      pend = pend.filter((p) => !mapa.has(p.id));
    }
  }

  if (dryRun) {
    for (const m of pend.slice(0, 5)) {
      log(`  [dry-run] ${m.id} -> ${JSON.stringify(metaLeadToLead(m, target))}`);
    }
    if (pend.length > 5) log(`  [dry-run] ...y ${pend.length - 5} mas`);
    return 0;
  }
  if (!pend.length) { log('  nada por crear tras el filtro de duplicados'); return 0; }

  const pairs = await createLeads(pend, target, metaLeadToLead);
  const byId = new Map(pend.map((m) => [m.id, m]));
  await addNotes(pairs, byId, metaLeadToNote);
  const ok = await markMetaKommoSynced(pairs);
  const fail = pairs.length - ok;
  const fusionados = pairs.filter((p) => p.merged).length;

  await updateSyncState({
    meta_last_run: new Date().toISOString(),
    meta_total: filas.length,
    meta_last_error: fail ? `${fail} lead(s) sin crear` : null,
  });
  STATS.leads_meta_creados = ok;
  log(`META listo: ${ok} lead(s) creados en Kommo` +
      `${fusionados ? ` (${fusionados} con contacto fusionado)` : ''}${fail ? `, ${fail} con error` : ''}`);
  return ok;
}

/** Fija el corte de Meta. */
async function metaInit(arg) {
  const iso = (!arg || arg === 'now') ? new Date().toISOString() : new Date(arg).toISOString();
  if (Number.isNaN(Date.parse(iso))) throw new Error(`Fecha de corte invalida: ${arg}`);
  await updateSyncState({ meta_since: iso });
  log(`META corte fijado en ${iso}`);
}

/** Fija el corte: a partir de que momento se envian tickets a Kommo. */
async function kommoInit(arg) {
  const iso = (!arg || arg === 'now') ? new Date().toISOString() : new Date(arg).toISOString();
  if (iso === 'Invalid Date' || Number.isNaN(Date.parse(iso))) {
    throw new Error(`Fecha de corte invalida: ${arg}`);
  }
  const acc = await getAccount();
  const target = await resolveTarget();
  await updateSyncState({ kommo_since: iso });
  log(`KOMMO conectado a "${acc.subdomain}" (cuenta ${acc.id}, ${acc.currency})`);
  log(`  destino: embudo "${target.pipelineName}" / etapa "${target.statusName}" / etiqueta "${kommoConfig.TAG}"`);
  log(`  corte fijado en ${iso} — solo se enviaran tickets creados desde ese instante`);
}

// -------- entry point --------
const mode = (process.argv[2] || 'incremental').toLowerCase();
const flags = process.argv.slice(3);
const hasFlag = (f) => flags.includes(f);
const flagVal = (name, def) => {
  const hit = flags.find((f) => f.startsWith(`${name}=`));
  return hit ? hit.split('=')[1] : def;
};
try {
  if (mode === 'full') { await fullSync(); }
  else if (mode === 'full-enrich') { await fullSync(); await enrich(); }
  else if (mode === 'enrich') {
    const onlyOpen = process.argv[3] !== 'all';
    const max = parseInt(process.argv[4] || '6000', 10);
    await enrich({ onlyOpen, max });
  }
  else if (mode === 'incremental') {
    await incrementalSync();
    // Los tickets nuevos pasan a Kommo en la misma corrida. Si la integracion
    // no esta configurada (sin credenciales o sin corte), no hace nada.
    if (kommoEnabled()) {
      await pushToKommo({ limit: parseInt(flagVal('--limit', '200'), 10) });
      await pushToKommoB2B({ limit: parseInt(flagVal('--limit', '200'), 10) });
    }
    // Y la hoja de Meta se replica y empuja en la misma pasada. Se aisla en
    // try/catch: que la hoja falle no debe tumbar el sync de Zoho.
    if (!hasFlag('--sin-meta')) {
      try { await syncMeta({ limit: 500 }); }
      catch (e) {
        log('META aviso: la hoja de Google fallo:', e.message);
        await updateSyncState({ meta_last_error: String(e.message || e) });
      }
    }
  }
  else if (mode === 'kommo') {
    await pushToKommo({
      dryRun: hasFlag('--dry-run'),
      limit: parseInt(flagVal('--limit', '200'), 10),
    });
  }
  else if (mode === 'kommo-init') { await kommoInit(flags[0]); }
  else if (mode === 'kommo-b2b') {
    await pushToKommoB2B({
      dryRun: hasFlag('--dry-run'),
      limit: parseInt(flagVal('--limit', '200'), 10),
    });
  }
  else if (mode === 'kommo-b2b-init') { await kommoInitB2B(flags[0]); }
  else if (mode === 'meta') {
    await syncMeta({
      dryRun: hasFlag('--dry-run'),
      limit: parseInt(flagVal('--limit', '500'), 10),
      skipSolapados: !hasFlag('--permitir-duplicados'),
    });
  }
  else if (mode === 'meta-init') { await metaInit(flags[0]); }
  else { console.error(`Modo desconocido: ${mode}`); process.exit(1); }
  await grabarBitacora({ ok: true });
  log('OK');
} catch (e) {
  log('ERROR', e.message || e);
  try { await updateSyncState({ last_error: String(e.message || e) }); } catch {}
  await grabarBitacora({ ok: false, error: String(e.message || e) });
  process.exit(1);
}

/** Cierra la fila de bitacora de esta corrida. */
async function grabarBitacora({ ok, error = null }) {
  // Los modos de configuracion y los dry-run no son ejecuciones reales.
  if (mode.endsWith('-init') || hasFlag('--dry-run')) return;
  const fin = new Date();
  await insertSyncLog({
    started_at: STATS.started_at,
    finished_at: fin.toISOString(),
    duracion_seg: (fin - new Date(STATS.started_at)) / 1000,
    modo: mode,
    entorno: STATS.entorno,
    ok,
    tickets_nuevos: STATS.tickets_nuevos,
    tickets_refrescados: STATS.tickets_refrescados,
    leads_zoho_creados: STATS.leads_zoho_creados,
    zoho_vinculados: STATS.zoho_vinculados,
    meta_filas_hoja: STATS.meta_filas_hoja,
    leads_meta_creados: STATS.leads_meta_creados,
    meta_vinculados: STATS.meta_vinculados,
    error,
    detalle: Object.keys(STATS.detalle).length ? STATS.detalle : null,
  });
}
