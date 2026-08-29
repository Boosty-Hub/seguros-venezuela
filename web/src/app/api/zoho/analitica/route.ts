import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Analítica del pipeline, bajo demanda al abrir el panel lateral. No va en el
// render de la página porque la mayoría de las visitas no lo abren, y son
// ~15 agregaciones sobre 14 mil tickets.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { since?: string | null };

  const { data, error } = await supabase.rpc("zoho_pipeline_analitica", {
    p_since: body.since ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, analitica: data });
}
