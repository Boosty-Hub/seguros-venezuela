import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Marca o desmarca una conversación como favorita. La marca es del equipo:
// se guarda en `leads`, no por usuario (ver migración 0068).
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { favorite?: boolean };
  const favorito = body.favorite === true;

  const { error } = await supabase
    .from("leads")
    .update({
      favorited_at: favorito ? new Date().toISOString() : null,
      favorited_by: favorito ? user.id : null,
    })
    .eq("id", params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, favorite: favorito });
}
