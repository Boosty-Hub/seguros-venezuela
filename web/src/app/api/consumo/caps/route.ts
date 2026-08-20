import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setConfigValues } from "@/lib/runtime-config";

// Topes de consumo (diario/mensual, USD) — al superarse, alerts-scan apaga
// el agente por completo (agent_enabled=false) y crea una alerta crítica.
// Vacío/0 = sin tope. Ver supabase/functions/alerts-scan (detectAndEnforceUsageCaps).
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { daily?: unknown; monthly?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  function parseCap(v: unknown): string | null {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return n > 0 ? String(n) : null;
  }

  const daily = parseCap(body.daily);
  const monthly = parseCap(body.monthly);

  await setConfigValues(
    { USAGE_DAILY_CAP_USD: daily, USAGE_MONTHLY_CAP_USD: monthly },
    user.email ?? "dashboard"
  );

  return NextResponse.json({ ok: true, daily, monthly });
}
