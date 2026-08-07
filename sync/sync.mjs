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
import { upsertTickets, updateSyncState, getWatermark, getTicketsMissingDetail, countTickets } from './lib/supa.mjs';
import { ticketToRow } from './lib/parse.mjs';

const LIMIT = 100;
const ENRICH_CONCURRENCY = 5;
const MAX_PAGES = 1000; // salvaguarda anti-bucle (100k tickets)

function log(...a) { console.log(new Date().toISOString(), ...a); }

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

// -------- INCREMENTAL: modificados desde el watermark --------
async function incrementalSync() {
  const watermark = await getWatermark();
  log(`INCREMENTAL sync · desde ${watermark || '(sin watermark -> full)'}`);
  if (!watermark) return fullSync().then(() => enrich());

  const wmMs = new Date(watermark).getTime();
  let from = 1, page = 0, changed = [];
  outer: for (; page < MAX_PAGES; page++) {
    const tickets = await fetchTicketsPage({ from, limit: LIMIT, sortBy: '-modifiedTime' });
    if (!tickets.length) break;
    for (const t of tickets) {
      const mt = t.modifiedTime ? new Date(t.modifiedTime).getTime() : 0;
      if (mt <= wmMs) break outer; // llegamos a lo ya sincronizado
      changed.push(t.id);
    }
    from += LIMIT;
    if (tickets.length < LIMIT) break;
  }
  log(`  ${changed.length} tickets cambiados`);
  if (!changed.length) {
    await updateSyncState({ last_incremental_sync: new Date().toISOString(), last_run_updated: 0, last_error: null });
    return 0;
  }
  // detalle (con customFields) para cada ticket cambiado
  const details = await pool(changed, async (id) => {
    const d = await fetchTicketDetail(id);
    return d && d.id ? ticketToRow(d) : null;
  }, ENRICH_CONCURRENCY);
  const rows = details.filter((r) => r && !r.error);
  await upsertTickets(rows);
  const count = await countTickets();
  await updateSyncState({
    last_incremental_sync: new Date().toISOString(),
    total_tickets: count,
    last_run_updated: rows.length,
    last_error: null,
  });
  log(`INCREMENTAL listo: ${rows.length} tickets actualizados`);
  return rows.length;
}

// -------- entry point --------
const mode = (process.argv[2] || 'incremental').toLowerCase();
try {
  if (mode === 'full') { await fullSync(); }
  else if (mode === 'full-enrich') { await fullSync(); await enrich(); }
  else if (mode === 'enrich') {
    const onlyOpen = process.argv[3] !== 'all';
    const max = parseInt(process.argv[4] || '6000', 10);
    await enrich({ onlyOpen, max });
  }
  else if (mode === 'incremental') { await incrementalSync(); }
  else { console.error(`Modo desconocido: ${mode}`); process.exit(1); }
  log('OK');
} catch (e) {
  log('ERROR', e.message || e);
  try { await updateSyncState({ last_error: String(e.message || e) }); } catch {}
  process.exit(1);
}
