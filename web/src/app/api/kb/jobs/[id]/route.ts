import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { pokeWorker } from "@/lib/kb-queue";

export const runtime = "nodejs";

const BUCKET = "kb-uploads";

/** GET — el texto extraído de un job, para la pantalla de revisión. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("kb_ingest_jobs")
    .select("id, title, filename, status, texto, issues, last_error, total_pages")
    .eq("id", params.id)
    .single();
  if (error || !data) return NextResponse.json({ error: "no encontrado" }, { status: 404 });
  return NextResponse.json({ ok: true, job: data });
}

/**
 * PATCH — el humano revisó (y quizá corrigió) el texto y lo aprueba.
 *
 * Su palabra vale más que la del juez: el job pasa a 'aprobado' y el
 * ensamblador lo indexa saltándose las dos validaciones. Se despierta al
 * worker en el momento porque indexar un texto ya aprobado son segundos.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { texto?: string };
  const texto = body.texto?.trim();
  if (!texto) return NextResponse.json({ error: "falta el texto a indexar" }, { status: 400 });

  const { error } = await supabase
    .from("kb_ingest_jobs")
    .update({ texto, status: "aprobado", last_error: null })
    .eq("id", params.id)
    .eq("status", "revision");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await pokeWorker("kb-assemble", params.id);
  return NextResponse.json({ ok: true });
}

/**
 * DELETE — descartar una carga.
 *
 * Borra también el temporal del bucket: si el job muere acá, nadie más lo va
 * a limpiar (el ensamblador solo borra el suyo al terminar bien).
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: job } = await supabase
    .from("kb_ingest_jobs")
    .select("storage_path")
    .eq("id", params.id)
    .single();

  if (job?.storage_path) {
    const admin = createServiceClient();
    await admin.storage.from(BUCKET).remove([job.storage_path as string]).catch(() => {});
  }

  // ON DELETE CASCADE en kb_ingest_tandas → se van solas.
  const { error } = await supabase.from("kb_ingest_jobs").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
