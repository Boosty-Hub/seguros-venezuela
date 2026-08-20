import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setConfigValues } from "@/lib/runtime-config";

const FREQUENCIES = ["daily", "3d", "7d", "15d"] as const;

// Frecuencia del análisis periódico de Dreams (runtime_config DREAMS_FREQUENCY):
//   daily → todos los días · 3d → cada 3 días · 7d → cada 7 · 15d → cada 15.
// El cron 'dreams-run' (pg_cron) dispara REALMENTE a esa cadencia — no hay
// due-check interno en la función. set_dreams_schedule() reprograma el job en
// la misma transacción que guarda la preferencia (migración 0055).
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { frequency?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const frequency = String(body.frequency ?? "");
  if (!FREQUENCIES.includes(frequency as (typeof FREQUENCIES)[number])) {
    return NextResponse.json(
      { error: `frequency debe ser uno de: ${FREQUENCIES.join(", ")}` },
      { status: 400 }
    );
  }

  await setConfigValues({ DREAMS_FREQUENCY: frequency }, user.email ?? "dashboard");

  // Reprograma el cron real (pg_cron) a la cadencia elegida. Si falla (p.ej.
  // migración 0055 no aplicada todavía en un fork viejo), no bloquea guardar
  // la preferencia — pero avisamos con fail-soft en la respuesta.
  const { error: cronErr } = await supabase.rpc("set_dreams_schedule", { p_frequency: frequency });
  if (cronErr) {
    return NextResponse.json({ ok: true, frequency, cron_warning: cronErr.message });
  }

  return NextResponse.json({ ok: true, frequency });
}
