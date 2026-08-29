import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Detalle de UN corredor bajo demanda: sus clientes y las cotizaciones de cada
// uno. Va por endpoint y no en el render de la página porque son 535
// corredores — traer el detalle de todos de una vez sería un payload enorme
// para mostrar el de uno.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { asesor?: string; since?: string | null };
  const asesor = body.asesor?.trim();
  if (!asesor) return NextResponse.json({ error: "asesor requerido" }, { status: 400 });

  const { data, error } = await supabase.rpc("zoho_corredor_detalle", {
    p_asesor: asesor,
    p_since: body.since ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, detalle: data });
}
