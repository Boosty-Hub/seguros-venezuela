// ============================================================================
// Supabase Edge Function: zoho-sync
// ----------------------------------------------------------------------------
// Actualizacion INSTANTANEA del pipeline. Se puede invocar de 3 formas:
//
//   1) Webhook de Zoho Desk (al crear/actualizar un ticket)
//        POST .../zoho-sync   body: { ticketId: "977937..." }  (o payload Zoho)
//   2) pg_cron + pg_net (programado dentro de Supabase, cada minuto)
//        POST .../zoho-sync   body: { mode: "incremental", minutes: 10 }
//   3) Manual (curl / navegador)
//
// Requiere estos secrets en el proyecto (supabase/secrets):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN,
//   ZOHO_ORG_ID, ZOHO_DEPARTMENT_ID
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY se inyectan automaticamente.
// ============================================================================

const ACCOUNTS = Deno.env.get("ZOHO_ACCOUNTS_HOST") ?? "https://accounts.zoho.com";
const DESK = Deno.env.get("ZOHO_DESK_HOST") ?? "https://desk.zoho.com";
const ORG_ID = Deno.env.get("ZOHO_ORG_ID")!;
const DEPT = Deno.env.get("ZOHO_DEPARTMENT_ID")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function zohoToken(): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: Deno.env.get("ZOHO_REFRESH_TOKEN")!,
    client_id: Deno.env.get("ZOHO_CLIENT_ID")!,
    client_secret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
    grant_type: "refresh_token",
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("No se pudo refrescar el token Zoho");
  return j.access_token;
}

function parseVzNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s === "--") return null;
  if (!/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(s) && !/^-?\d+(,\d+)?$/.test(s)) return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
const fullName = (o: any) => o ? ([o.firstName, o.lastName].filter(Boolean).join(" ").trim() || null) : null;
const toInt = (v: any) => { if (v == null || v === "") return null; const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10); return Number.isFinite(n) ? n : null; };

function ticketToRow(t: any) {
  const cf = t.customFields || null;
  const row: any = {
    id: String(t.id),
    ticket_number: t.ticketNumber ?? null,
    subject: t.subject ?? null,
    status: t.status ?? null,
    status_type: t.statusType ?? null,
    channel: t.channel ?? null,
    priority: t.priority ?? null,
    category: t.category ?? null,
    sub_category: t.subCategory ?? null,
    department_id: t.departmentId ?? null,
    contact_id: t.contactId ?? null,
    contact_name: fullName(t.contact),
    email: t.email ?? t.contact?.email ?? null,
    phone: t.phone ?? t.contact?.phone ?? null,
    assignee_id: t.assigneeId ?? null,
    assignee_name: fullName(t.assignee),
    team_id: t.teamId ?? null,
    created_time: t.createdTime ?? null,
    modified_time: t.modifiedTime ?? t.createdTime ?? null,
    closed_time: t.closedTime ?? null,
    due_date: t.dueDate ?? null,
    customer_response_time: t.customerResponseTime ?? null,
    thread_count: toInt(t.threadCount),
    comment_count: toInt(t.commentCount),
    is_spam: !!t.isSpam,
    is_overdue: !!t.isOverDue,
    web_url: t.webUrl ?? null,
    raw: t,
    synced_at: new Date().toISOString(),
  };
  if (cf) {
    row.custom_fields = cf;
    row.ramo = cf["Ramo"] ?? null;
    row.plan_hcm = cf["Plan HCM"] ?? null;
    row.asesor = cf["Asesor"] ?? null;
    row.titular = cf["Nombre y apellido del Titular"] ?? cf["Nombre del Beneficiario"] ?? null;
    row.tipo_documento = cf["Tipo de documento"] ?? null;
    row.edad = toInt(cf["Edad"]);
    row.moneda = cf["Moneda de Pago"] ?? null;
    row.monto_prima = parseVzNumber(cf["Monto Prima - Anual"]) ?? parseVzNumber(cf["Monto Prima"]) ?? null;
  }
  return row;
}

async function deskGet(path: string, params: Record<string, string>, token: string) {
  const url = new URL(`${DESK}/api/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}`, orgId: ORG_ID } });
  if (r.status === 204) return { data: [] };
  if (!r.ok) throw new Error(`Zoho ${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function upsert(rows: any[]) {
  if (!rows.length) return 0;
  const r = await fetch(`${SB_URL}/rest/v1/tickets?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase upsert HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return rows.length;
}

async function sbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Ticket mas nuevo que ya tenemos. Es el corte del incremental. */
async function watermark(): Promise<string | null> {
  const j = await sbGet("tickets?select=created_time&order=created_time.desc.nullslast&limit=1");
  return j[0]?.created_time ?? null;
}

/** Abiertos que llevan mas tiempo sin refrescar (para ver cambios de estado). */
async function abiertosRancios(limit: number): Promise<string[]> {
  const j = await sbGet(
    `tickets?select=id&status_type=in.(Open,"On Hold")&order=synced_at.asc.nullsfirst&limit=${limit}`,
  );
  return j.map((x: any) => String(x.id));
}

/** Detalle en paralelo acotado: el runtime de Edge no aguanta 200 secuenciales. */
async function detalles(ids: string[], token: string, concurrencia = 5) {
  const out: any[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrencia, ids.length) }, async () => {
      while (i < ids.length) {
        const id = ids[i++];
        try {
          const d = await deskGet(`tickets/${id}`, { include: "contacts,assignee" }, token);
          if (d?.id) out.push(ticketToRow(d));
        } catch { /* un ticket que falla no tumba la corrida; vuelve al siguiente ciclo */ }
      }
    }),
  );
  return out;
}

Deno.serve(async (req) => {
  try {
    let payload: any = {};
    try { payload = await req.json(); } catch { /* body vacio */ }

    // Zoho puede enviar el id como ticketId, id, o dentro de payload.ticket
    const ticketId = payload.ticketId || payload.id || payload?.ticket?.id || null;
    const token = await zohoToken();
    let rows: any[] = [];
    const info: Record<string, unknown> = {};

    if (ticketId) {
      // Actualizacion instantanea de UN ticket (webhook)
      const d = await deskGet(`tickets/${ticketId}`, { include: "contacts,assignee" }, token);
      if (d?.id) rows = [ticketToRow(d)];
    } else {
      // Incremental: tickets NUEVOS desde el ultimo que tenemos.
      //
      // El corte es `createdTime`, NO `modifiedTime`: el listado de /tickets de
      // Zoho no devuelve `modifiedTime` (viene solo en el detalle). La version
      // anterior filtraba por `modifiedTime` y, como siempre era undefined,
      // cortaba en el PRIMER ticket de la lista y sincronizaba cero — en
      // silencio, respondiendo ok:true, upserted:0 cada 5 minutos. Se detecto
      // con 3 dias de tickets sin entrar.
      const wm = await watermark();
      const wmMs = wm ? new Date(wm).getTime() : 0;
      info.watermark = wm;

      const nuevos: { id: string; ct: number }[] = [];
      let from = 1;
      outer: for (let p = 0; p < 20; p++) {
        const j = await deskGet("tickets", {
          departmentId: DEPT, from: String(from), limit: "100",
          sortBy: "-createdTime", include: "contacts,assignee",
        }, token);
        const list = j.data || [];
        if (!list.length) break;
        for (const t of list) {
          const ct = t.createdTime ? new Date(t.createdTime).getTime() : 0;
          if (ct <= wmMs) break outer; // llegamos a lo ya sincronizado
          nuevos.push({ id: String(t.id), ct });
        }
        from += 100;
        if (list.length < 100) break;
      }

      // De mas viejo a mas nuevo y acotado: si hay un atraso grande, esta
      // corrida trae un pedazo y el watermark avanza solo hasta ahi, asi que
      // el siguiente ciclo sigue justo donde quedo. Al reves (los mas nuevos
      // primero) el watermark saltaria al final y se perderia el hueco.
      nuevos.sort((a, b) => a.ct - b.ct);
      const MAX_POR_CORRIDA = 80;
      const lote = nuevos.slice(0, MAX_POR_CORRIDA);
      info.nuevos_detectados = nuevos.length;
      info.pendientes = Math.max(0, nuevos.length - lote.length);

      rows = await detalles(lote.map((x) => x.id), token);

      // Refresco de estado de los abiertos mas rancios. Sin esto, un ticket
      // que cambia de estado en Zoho nunca se entera de este lado (el listado
      // no permite filtrar por modificacion).
      const refrescar = Number(payload.refresh ?? 40);
      if (refrescar > 0) {
        const ids = await abiertosRancios(refrescar);
        const rr = await detalles(ids, token);
        info.refrescados = rr.length;
        rows = rows.concat(rr);
      }
    }

    const n = await upsert(rows);
    Object.assign(info, { upserted: n });

    // El push a Kommo (B2C/B2B según el campo Asesor) NO se encadena desde
    // acá: se probó con fetch + EdgeRuntime.waitUntil (fire-and-forget) y no
    // quedó registro confiable de que el request llegara a completarse antes
    // de que el runtime matara la función. En vez de dejar un "encadenado"
    // que aparenta funcionar sin estarlo, la cobertura real es el cron
    // independiente "zoho-kommo-push-safety" (cada 5 min, ver migración
    // 0060_zoho_kommo_cron.sql) — drena lo que este sync acaba de traer en,
    // como mucho, unos minutos de diferencia.
    return new Response(JSON.stringify({ ok: true, ...info }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
