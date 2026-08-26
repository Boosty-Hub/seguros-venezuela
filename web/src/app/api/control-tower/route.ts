import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValues } from "@/lib/runtime-config";
import { listPendingDreams } from "@/lib/memory-list";

// /dreams/<period>/2026-06-10_00_err_titulo.md — mismo parser que /dreams
// (dreams/page.tsx::parseDreamPath), liviano acá porque solo necesitamos
// título + severidad para la tarjeta de la Torre de Control.
function parsePendingDreamTitle(path: string): { title: string; sev: "sug" | "adv" | "err" | null } {
  const m = path.match(/^\/dreams-pending\/[^/]+\/\d{4}-\d{2}-\d{2}_\d+_(?:(sug|adv|err)_)?(.+)\.md$/);
  return { sev: (m?.[1] as "sug" | "adv" | "err" | undefined) ?? null, title: (m?.[2] ?? path).replace(/_/g, " ") };
}

// Datos agregados para la Torre de Control (campana del header): alertas
// activas, estado del agente, consumo vs topes, y revisiones pendientes.
// Todo de solo lectura acá — las acciones (reactivar, marcar vista) pegan a
// las rutas que ya existen (/api/agent/publish, /api/alerts/...).
export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const dayStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const monthStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const [
    { data: alertRows },
    { data: pubCfg },
    { data: dayRows },
    { data: monthRows },
    capsCfg,
    { count: pendingDrafts },
    { count: needsReview },
  ] = await Promise.all([
    supabase
      .from("alerts")
      .select("id, kind, severity, title, description, created_at, ref_table, ref_id")
      .is("acknowledged_at", null)
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("kommo_publish_config")
      .select("agent_enabled, publishing_enabled, bypass_review")
      .eq("is_active", true)
      .maybeSingle(),
    supabase.from("usage_events").select("estimated_cost_usd").gte("created_at", dayStartIso),
    supabase.from("usage_events").select("estimated_cost_usd").gte("created_at", monthStartIso),
    configValues(["USAGE_DAILY_CAP_USD", "USAGE_MONTHLY_CAP_USD"]),
    supabase.from("drafts").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("requires_human_review", true)
      .is("answered_by_draft_id", null)
      .eq("ignored", false),
  ]);

  const dailySpend = (dayRows ?? []).reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0);
  const monthlySpend = (monthRows ?? []).reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0);

  // Dreams pendientes de aprobación (fail-open: si el memory store hiccupea,
  // la Torre de Control no se cae entera por esto — simplemente no muestra la
  // sección, igual que si no hubiera pendientes).
  let pendingDreams: Array<{ id: string; title: string; sev: "sug" | "adv" | "err" | null }> = [];
  try {
    const pending = await listPendingDreams();
    pendingDreams = pending
      .map((d) => ({ id: d.id, ...parsePendingDreamTitle(d.path) }))
      .slice(0, 20);
  } catch (err) {
    console.warn("control-tower: listPendingDreams failed:", err instanceof Error ? err.message : err);
  }

  // Resolver el lead detrás de cada alerta (vía message/draft) para poder
  // linkear directo a la conversación donde pasó — mismo criterio que /alerts.
  const rows = (alertRows ?? []) as Array<{
    id: string;
    kind: string;
    severity: "info" | "warning" | "critical";
    title: string;
    description: string | null;
    created_at: string;
    ref_table: string | null;
    ref_id: string | null;
  }>;
  const msgRefIds = rows.filter((a) => a.ref_table === "messages" && a.ref_id).map((a) => a.ref_id as string);
  const draftRefIds = rows.filter((a) => a.ref_table === "drafts" && a.ref_id).map((a) => a.ref_id as string);
  const leadByAlert = new Map<string, string>();

  if (msgRefIds.length > 0) {
    const { data: msgs } = await supabase.from("messages").select("id, lead_id").in("id", msgRefIds);
    const leadByMsg = new Map((msgs ?? []).map((m) => [m.id as string, m.lead_id as string]));
    for (const a of rows) {
      if (a.ref_table === "messages" && a.ref_id) {
        const lead = leadByMsg.get(a.ref_id);
        if (lead) leadByAlert.set(a.id, lead);
      }
    }
  }
  if (draftRefIds.length > 0) {
    const { data: drs } = await supabase.from("drafts").select("id, messages(lead_id)").in("id", draftRefIds);
    for (const d of (drs ?? []) as Array<{ id: string; messages: { lead_id: string } | { lead_id: string }[] | null }>) {
      const m = Array.isArray(d.messages) ? d.messages[0] : d.messages;
      if (m?.lead_id) {
        const alert = rows.find((a) => a.ref_table === "drafts" && a.ref_id === d.id);
        if (alert) leadByAlert.set(alert.id, m.lead_id);
      }
    }
  }
  const linkFor = (a: { id: string; ref_table: string | null }): string | null => {
    const leadId = leadByAlert.get(a.id);
    if (leadId) return `/inbox?lead=${leadId}`;
    if (a.ref_table === "messages" || a.ref_table === "drafts") return `/inbox`;
    return null;
  };
  const alertsWithLink = rows.map((a) => ({ ...a, link: linkFor(a) }));

  return NextResponse.json({
    ok: true,
    alerts: alertsWithLink,
    agent: {
      enabled: pubCfg?.agent_enabled !== false,
      publishing: pubCfg?.publishing_enabled === true,
      bypassReview: pubCfg?.bypass_review === true,
    },
    consumption: {
      dailySpend,
      monthlySpend,
      dailyCap: capsCfg.USAGE_DAILY_CAP_USD ? Number(capsCfg.USAGE_DAILY_CAP_USD) : null,
      monthlyCap: capsCfg.USAGE_MONTHLY_CAP_USD ? Number(capsCfg.USAGE_MONTHLY_CAP_USD) : null,
    },
    reviews: {
      pendingDrafts: pendingDrafts ?? 0,
      needsReview: needsReview ?? 0,
    },
    dreams: {
      pending: pendingDreams,
    },
  });
}
