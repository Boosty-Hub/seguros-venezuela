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

Deno.serve(async (req) => {
  try {
    let payload: any = {};
    try { payload = await req.json(); } catch { /* body vacio */ }

    // Zoho puede enviar el id como ticketId, id, o dentro de payload.ticket
    const ticketId = payload.ticketId || payload.id || payload?.ticket?.id || null;
    const token = await zohoToken();
    let rows: any[] = [];

    if (ticketId) {
      // Actualizacion instantanea de UN ticket (webhook)
      const d = await deskGet(`tickets/${ticketId}`, { include: "contacts,assignee" }, token);
      if (d?.id) rows = [ticketToRow(d)];
    } else {
      // Incremental: tickets modificados recientemente
      const minutes = Number(payload.minutes ?? 15);
      const cutoff = Date.now() - minutes * 60_000;
      let from = 1;
      outer: for (let p = 0; p < 20; p++) {
        const j = await deskGet("tickets", {
          departmentId: DEPT, from: String(from), limit: "100",
          sortBy: "-modifiedTime", include: "contacts,assignee",
        }, token);
        const list = j.data || [];
        if (!list.length) break;
        for (const t of list) {
          const mt = t.modifiedTime ? new Date(t.modifiedTime).getTime() : 0;
          if (mt < cutoff) break outer;
          const d = await deskGet(`tickets/${t.id}`, { include: "contacts,assignee" }, token);
          if (d?.id) rows.push(ticketToRow(d));
        }
        from += 100;
        if (list.length < 100) break;
      }
    }

    const n = await upsert(rows);
    return new Response(JSON.stringify({ ok: true, upserted: n }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
