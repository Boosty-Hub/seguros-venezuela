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
  const since = body.since ?? null;

  // Las dos en paralelo y en una sola petición: el panel las necesita juntas
  // (una pestaña cada una) y así hay un único estado de carga en vez de que
  // cada pestaña parpadee la primera vez que se abre.
  const [cotiz, emis] = await Promise.all([
    supabase.rpc("zoho_pipeline_analitica", { p_since: since }),
    supabase.rpc("zoho_emisiones_analitica", { p_since: since, p_maduracion_dias: 60 }),
  ]);

  if (cotiz.error) return NextResponse.json({ error: cotiz.error.message }, { status: 500 });
  // La de emisiones NO tumba la respuesta: si falla (o aún no hay emisiones
  // cargadas), la pestaña de cotizaciones tiene que seguir funcionando.
  return NextResponse.json({
    ok: true,
    analitica: cotiz.data,
    emisiones: emis.error ? { error: emis.error.message } : emis.data,
  });
}
