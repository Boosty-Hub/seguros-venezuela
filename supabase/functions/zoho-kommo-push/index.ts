// Edge Function: zoho-kommo-push
//
// Puerto a Deno de sync/sync.mjs::pushToKommo + pushToKommoB2B (Node, uso
// manual/histórico) — para que la migración Zoho -> Kommo corra sola por
// cron de Supabase en vez de depender de GitHub Actions o de correrla a
// mano. Reusa exactamente las mismas reglas de negocio:
//
//   B2C (embudo "VENTAS B2C" / etapa "cliente por atender"):
//     tickets cuyo campo Asesor es "No tengo", "Sin Asesor", "Sin Asesor
//     (KG)", "Seguros Venezuela", "Directo Caracas" o "No Posee" — sin
//     corredor real asignado.
//   B2B (embudo "VENTAS B2B" / etapa "DATA ZOHO DESK"):
//     el resto — tickets con un corredor/asesor real (cotizan vía Sofi u
//     otras plataformas). Excluye asesor null/vacío (dato incompleto).
//
// Cortes independientes (sync_state.kommo_since / kommo_b2b_since) — el
// mismo singleton que ya usaba el script de Node, así que ambos caminos
// (manual y cron) comparten estado sin pisarse.
//
// Se invoca encadenado desde zoho-sync (fire-and-forget, al final de cada
// corrida incremental) y también por su propio cron cada 5 minutos (red de
// seguridad: si zoho-sync corrió pero el chain falló, este cron igual drena
// lo pendiente).
//
//   POST {}                      corre B2C + B2B con el corte guardado
//   POST { mode: "b2c" }         solo B2C
//   POST { mode: "b2b" }         solo B2B
//   POST { limit: 500 }          tope de tickets por corrida (default 200)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { loadConfig } from "../_shared/config.ts";
import { fetchPipelineStages, matchStagesByName, type KommoStageLite } from "../_shared/kommo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const TAG = "ZohoDesk";
const BATCH = 50;
const PAUSE_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- Teléfono venezolano (puerto de sync/lib/telefono.mjs) ----------------
function normalizePhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/^p:/i, "").trim();
  if (!s) return null;
  const plus = s.startsWith("+");
  const d = s.replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("58") && d.length === 12) return `+${d}`;
  if (d.startsWith("0") && d.length === 11) return `+58${d.slice(1)}`;
  if (d.length === 10 && d.startsWith("4")) return `+58${d}`;
  if (plus) return `+${d}`;
  if (d.startsWith("58") && d.length > 12) return `+${d}`;
  return d;
}

// ---------------- Filtros de Asesor (puerto de sync/lib/supa.mjs) ----------------
// Mantener EN SINCRONÍA con sync/lib/supa.mjs: son las mismas reglas en dos
// runtimes (este cron y el script de Node). Y CON_ASESOR debe ser el
// complemento exacto de SIN_ASESOR, o un ticket calificaría para los dos embudos.
//
// B2C: "sin asesor real" (No tengo / Sin Asesor / Sin Asesor (KG) / Seguros
// Venezuela / Directo Caracas / No Posee).
// OJO: el patrón es *directo*caracas*, NO *directo*. En Zoho hay también
// "DIRECTO VALENCIA", "DIRECTO SAN CRISTOBAL" y "Directo" suelto, que por
// decisión del operador siguen yendo a B2B.
const FILTRO_SIN_ASESOR =
  "or=(asesor.ilike.*no*tengo*,asesor.ilike.*sin*asesor*,asesor.ilike.*seguros*venezuela*" +
  ",asesor.ilike.*directo*caracas*,asesor.ilike.*no*posee*)";
// B2B: inverso — asesor real asignado (excluye null/vacío).
const FILTRO_CON_ASESOR =
  "asesor=not.is.null&asesor=neq.&asesor=not.ilike.*no*tengo*&asesor=not.ilike.*sin*asesor*&asesor=not.ilike.*seguros*venezuela*" +
  "&asesor=not.ilike.*directo*caracas*&asesor=not.ilike.*no*posee*";

type Ticket = {
  id: string;
  ticket_number: string | null;
  subject: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  titular: string | null;
  asesor: string | null;
  plan_hcm: string | null;
  monto_prima: number | null;
  moneda: string | null;
  created_time: string | null;
  web_url: string | null;
};

const sbHeaders = (extra: Record<string, string> = {}) => ({
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
  ...extra,
});

async function getPendingTickets(since: string, filterClause: string, limit: number): Promise<Ticket[]> {
  const cols = [
    "id", "ticket_number", "subject", "status", "status_type", "channel",
    "contact_name", "email", "phone", "titular", "asesor", "plan_hcm",
    "monto_prima", "moneda", "created_time", "web_url",
  ].join(",");
  const url =
    `${SUPABASE_URL}/rest/v1/tickets?select=${cols}` +
    `&kommo_lead_id=is.null` +
    `&created_time=gte.${encodeURIComponent(since)}` +
    `&is_spam=is.false` +
    `&${filterClause}` +
    `&order=created_time.asc&limit=${limit}`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`pendientes Kommo: ${r.status} ${await r.text()}`);
  return r.json();
}

async function getTicketsYaEnKommo(since: string): Promise<Array<{ ticket_id: string; kommo_lead_id: string }>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/tickets_ya_en_kommo`, {
    method: "POST",
    headers: sbHeaders(),
    body: JSON.stringify({ p_since: since ?? null }),
  });
  if (!r.ok) throw new Error(`tickets_ya_en_kommo: ${r.status} ${await r.text()}`);
  const rows = (await r.json()) as Array<{ id: string; kommo_lead_id: string }>;
  return rows.map((row) => ({ ticket_id: row.id, kommo_lead_id: row.kommo_lead_id }));
}

async function markKommoSynced(pairs: Array<{ sourceId: string; leadId: string | null; error?: string }>): Promise<number> {
  if (!pairs.length) return 0;
  const now = new Date().toISOString();
  const rows = pairs.map((p) => ({
    id: p.sourceId,
    kommo_lead_id: p.leadId || null,
    kommo_synced_at: p.leadId ? now : null,
    kommo_error: p.leadId ? null : (p.error || "sin lead_id"),
  }));
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tickets?on_conflict=id`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) { console.warn("markKommoSynced:", r.status, await r.text()); return 0; }
  const j = await r.json();
  return Array.isArray(j) ? j.length : 0;
}

// ---------------- Kommo: resolver destino + crear leads ----------------
// Usa matchStagesByName (tolerante a sufijos): el operador renombró en Kommo
// "cliente por atender" → "cliente por atender (atender)" y la igualdad exacta
// que había acá dejó de encontrarla, así que TODA la migración B2C venía
// fallando en silencio. Si hay más de una candidata se falla explícito en vez
// de elegir a ciegas.
function resolveStage(stages: KommoStageLite[], pipelineName: string, statusName: string) {
  const norm = (s: string) => String(s || "").trim().toLowerCase();
  const matches = matchStagesByName(stages, statusName, pipelineName);
  if (matches.length !== 1) {
    const candidates = stages.filter(
      (s) => norm(s.pipelineName) === norm(pipelineName) || norm(s.pipelineName).includes(norm(pipelineName))
    );
    throw new Error(
      matches.length === 0
        ? `No se encontró la etapa "${statusName}" en el embudo "${pipelineName}". ` +
          `Etapas del embudo: ${candidates.map((s) => s.name).join(" | ") || "(embudo no encontrado)"}`
        : `La etapa "${statusName}" es ambigua en "${pipelineName}": ${matches.map((s) => s.name).join(" | ")}. Precisa el nombre.`
    );
  }
  const match = matches[0];
  return { pipelineId: match.pipelineId, statusId: match.id, pipelineName: match.pipelineName, statusName: match.name };
}

const trunc = (s: string | null | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);
const unixSec = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
};

function ticketToLead(t: Ticket, target: { pipelineId: number; statusId: number }) {
  const nombre = trunc(t.subject, 250) || (t.ticket_number ? `Ticket #${t.ticket_number}` : `Ticket ${t.id}`);
  // deno-lint-ignore no-explicit-any
  const lead: any = {
    name: nombre,
    pipeline_id: target.pipelineId,
    status_id: target.statusId,
    created_at: unixSec(t.created_time),
    request_id: String(t.id),
    _embedded: { tags: [{ name: TAG }] },
  };
  const prima = Number(t.monto_prima);
  if (Number.isFinite(prima) && prima > 0) lead.price = Math.round(prima);

  const contactFields: Array<Record<string, unknown>> = [];
  const tel = normalizePhone(t.phone);
  if (t.email) contactFields.push({ field_code: "EMAIL", values: [{ value: String(t.email), enum_code: "WORK" }] });
  if (tel) contactFields.push({ field_code: "PHONE", values: [{ value: tel, enum_code: "WORK" }] });
  const contactName = t.contact_name || t.titular;
  if (contactName || contactFields.length) {
    lead._embedded.contacts = [{
      name: trunc(contactName || t.email || t.phone || "Sin nombre", 250),
      ...(contactFields.length ? { custom_fields_values: contactFields } : {}),
    }];
  }
  return lead;
}

function ticketToNote(t: Ticket): string {
  return [
    "Origen: Zoho Desk",
    t.ticket_number ? `Ticket #${t.ticket_number}` : null,
    t.asesor ? `Asesor: ${t.asesor}` : null,
    t.plan_hcm ? `Plan: ${t.plan_hcm}` : null,
    t.monto_prima ? `Prima anual: ${t.monto_prima} ${t.moneda || ""}`.trim() : null,
    t.web_url ? `Ver en Zoho: ${t.web_url}` : null,
  ].filter(Boolean).join("\n");
}

async function kommoApi(domain: string, token: string, path: string, body: unknown) {
  const res = await fetch(`https://${domain}/api/v4${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const txt = await res.text();
  if (!res.ok) throw new Error(`Kommo POST ${path} -> ${res.status}: ${txt.slice(0, 500)}`);
  return txt ? JSON.parse(txt) : null;
}

async function createLeads(
  items: Ticket[],
  target: { pipelineId: number; statusId: number },
  domain: string,
  token: string
): Promise<Array<{ sourceId: string; leadId: string | null; merged?: boolean; error?: string }>> {
  const out: Array<{ sourceId: string; leadId: string | null; merged?: boolean; error?: string }> = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const payload = chunk.map((t) => ticketToLead(t, target));
    // deno-lint-ignore no-explicit-any
    const res = (await kommoApi(domain, token, "/leads/complex", payload)) as any;
    const arr = Array.isArray(res) ? res : [];
    for (let k = 0; k < chunk.length; k++) {
      const t = chunk[k];
      const hit = arr.find((x: { request_id?: string }) => String(x?.request_id) === String(t.id)) || arr[k];
      if (hit?.id) {
        out.push({ sourceId: t.id, leadId: String(hit.id), merged: Boolean(hit.merged) });
      } else {
        out.push({ sourceId: t.id, leadId: null, error: "Kommo no devolvió id para este registro" });
      }
    }
    await sleep(PAUSE_MS);
  }
  return out;
}

async function addNotes(
  pairs: Array<{ sourceId: string; leadId: string | null }>,
  byId: Map<string, Ticket>,
  domain: string,
  token: string
) {
  const withLead = pairs.filter((p) => p.leadId);
  for (let i = 0; i < withLead.length; i += BATCH) {
    const chunk = withLead.slice(i, i + BATCH);
    const payload = chunk.map((p) => ({
      entity_id: Number(p.leadId),
      note_type: "common",
      params: { text: ticketToNote(byId.get(p.sourceId) as Ticket) },
    }));
    try {
      await kommoApi(domain, token, "/leads/notes", payload);
    } catch (err) {
      console.warn("addNotes lote:", err instanceof Error ? err.message : String(err));
    }
    await sleep(PAUSE_MS);
  }
}

// ---------------- Push genérico (B2C o B2B según los parámetros) ----------------
async function pushOne(opts: {
  label: string;
  since: string | null;
  sinceKey: string;
  totalKey: string;
  errorKey: string;
  filterClause: string;
  pipelineName: string;
  statusName: string;
  domain: string;
  token: string;
  stages: KommoStageLite[];
  limit: number;
}): Promise<{ label: string; creados: number; vinculados: number; error?: string }> {
  if (!opts.since) {
    return { label: opts.label, creados: 0, vinculados: 0, error: "sin corte configurado (sync_state)" };
  }

  const target = resolveStage(opts.stages, opts.pipelineName, opts.statusName);
  let pend = await getPendingTickets(opts.since, opts.filterClause, opts.limit);
  if (!pend.length) return { label: opts.label, creados: 0, vinculados: 0 };

  let vinculadosCount = 0;

  // (1) Duplicados contra lo ya creado en Kommo (cualquiera de los dos embudos).
  const yaEnKommo = await getTicketsYaEnKommo(opts.since);
  const mapaYa = new Map(yaEnKommo.map((x) => [x.ticket_id, x]));
  const vinculados = pend.filter((p) => mapaYa.has(p.id));
  if (vinculados.length) {
    vinculadosCount += vinculados.length;
    await markKommoSynced(vinculados.map((v) => ({ sourceId: v.id, leadId: mapaYa.get(v.id)!.kommo_lead_id })));
    pend = pend.filter((p) => !mapaYa.has(p.id));
  }

  // (2) Duplicados dentro del propio lote.
  const claveTicket = (t: Ticket) =>
    `${(t.subject || "").toLowerCase()}|` +
    `${(t.email || "").toLowerCase() || String(t.phone || "").replace(/\D/g, "") || (t.contact_name || "").toLowerCase()}|` +
    `${(t.titular || "").toLowerCase()}`;
  const primeros = new Map<string, Ticket>();
  const secundarios: Array<{ ticket: Ticket; clave: string }> = [];
  for (const t of pend) {
    const k = claveTicket(t);
    if (primeros.has(k)) secundarios.push({ ticket: t, clave: k });
    else primeros.set(k, t);
  }
  pend = [...primeros.values()];

  if (!pend.length) return { label: opts.label, creados: 0, vinculados: vinculadosCount };

  const pairs = await createLeads(pend, target, opts.domain, opts.token);
  const byId = new Map(pend.map((t) => [t.id, t]));
  await addNotes(pairs, byId, opts.domain, opts.token);

  if (secundarios.length) {
    const leadPorClave = new Map<string, string>();
    for (const p of pairs) {
      if (!p.leadId) continue;
      const t = byId.get(p.sourceId);
      if (t) leadPorClave.set(claveTicket(t), p.leadId);
    }
    const herencia = secundarios
      .map((s) => ({ sourceId: s.ticket.id, leadId: leadPorClave.get(s.clave) ?? null }))
      .filter((x) => x.leadId);
    if (herencia.length) {
      await markKommoSynced(herencia);
      vinculadosCount += herencia.length;
    }
  }

  const ok = await markKommoSynced(pairs);

  const { data: st } = await supabase.from("sync_state").select(opts.totalKey).eq("id", 1).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const prevTotal = Number((st as any)?.[opts.totalKey] ?? 0) || 0;
  const fail = pairs.length - ok;
  await supabase.from("sync_state").update({
    [opts.sinceKey.replace("_since", "_last_run")]: new Date().toISOString(),
    [opts.totalKey]: prevTotal + ok,
    [opts.errorKey]: fail ? `${fail} ticket(s) sin lead` : null,
  }).eq("id", 1);

  return { label: opts.label, creados: ok, vinculados: vinculadosCount, error: fail ? `${fail} sin lead` : undefined };
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") return new Response("zoho-kommo-push OK", { status: 200 });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body: { mode?: "b2c" | "b2b"; limit?: number } = {};
  try { const t = await req.text(); if (t) body = JSON.parse(t); } catch { /* body vacío */ }
  const limit = Math.max(1, Math.min(2000, Number(body.limit) || 200));

  try {
    const cfg = await loadConfig(supabase);
    const domain = cfg.require("KOMMO_API_DOMAIN");
    const token = cfg.require("KOMMO_ACCESS_TOKEN");
    const stages = await fetchPipelineStages(domain, token);

    const { data: state } = await supabase
      .from("sync_state")
      .select("kommo_since, kommo_b2b_since")
      .eq("id", 1)
      .maybeSingle();

    const results: Array<{ label: string; creados: number; vinculados: number; error?: string }> = [];

    if (body.mode !== "b2b") {
      results.push(await pushOne({
        label: "b2c",
        since: (state?.kommo_since as string | null) ?? null,
        sinceKey: "kommo_since", totalKey: "kommo_total", errorKey: "kommo_last_error",
        filterClause: FILTRO_SIN_ASESOR,
        pipelineName: "VENTAS B2C", statusName: "cliente por atender",
        domain, token, stages, limit,
      }));
    }
    if (body.mode !== "b2c") {
      results.push(await pushOne({
        label: "b2b",
        since: (state?.kommo_b2b_since as string | null) ?? null,
        sinceKey: "kommo_b2b_since", totalKey: "kommo_b2b_total", errorKey: "kommo_b2b_last_error",
        filterClause: FILTRO_CON_ASESOR,
        pipelineName: "VENTAS B2B", statusName: "DATA ZOHO DESK",
        domain, token, stages, limit,
      }));
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("zoho-kommo-push:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
