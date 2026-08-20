import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValues } from "@/lib/runtime-config";

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

  return NextResponse.json({
    ok: true,
    alerts: alertRows ?? [],
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
  });
}
