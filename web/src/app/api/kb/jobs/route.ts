import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { pokeWorker } from "@/lib/kb-queue";

export const runtime = "nodejs";

// Cola de ingesta de KB. Netlify ya NO extrae, transcribe ni embebe nada: eso
// vive en las Edge Functions kb-transcribe y kb-assemble (0080), que tienen
// ~400s de wall clock en vez de los 26s de una función síncrona de Netlify.
// Acá solo se encola y se consulta el avance.
//
// Formatos: el worker valida la extensión de verdad (es quien sabe leerlas);
// esta lista es solo para rechazar temprano lo obvio y dar un mensaje útil.
const ACEPTADOS = new Set([
  "pdf", "docx", "txt", "md", "srt", "vtt",
  "png", "jpg", "jpeg", "webp", "gif",
]);

/** POST — encola un documento. */
export async function POST(request: Request) {
  try {
    const supabase = createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await request.json()) as {
      title?: string;
      vertical_id?: string;
      /** Archivo ya subido al bucket kb-uploads por el navegador. */
      storage_path?: string;
      filename?: string;
      /** …o markdown pegado a mano. */
      content?: string;
    };

    const title = body.title?.trim();
    const verticalId = body.vertical_id?.trim();
    const storagePath = body.storage_path?.trim() || null;
    const contenido = body.content?.trim() || null;
    if (!title) return NextResponse.json({ error: "falta el título" }, { status: 400 });
    if (!verticalId) return NextResponse.json({ error: "falta la vertical" }, { status: 400 });
    if (!storagePath && !contenido) {
      return NextResponse.json({ error: "falta el archivo o el contenido" }, { status: 400 });
    }

    const filename = body.filename?.trim() || storagePath?.split("/").pop() || "inline.md";
    const ext = storagePath ? (filename.split(".").pop()?.toLowerCase() ?? "") : "md";
    if (storagePath && !ACEPTADOS.has(ext)) {
      return NextResponse.json(
        { error: `formato no soportado: .${ext}. Acepta: ${Array.from(ACEPTADOS).join(", ")}` },
        { status: 400 }
      );
    }

    const { data: job, error } = await supabase
      .from("kb_ingest_jobs")
      .insert({
        vertical_id: verticalId,
        title,
        storage_path: storagePath,
        filename,
        ext,
        inline_content: contenido,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error || !job) {
      return NextResponse.json({ error: error?.message ?? "no se pudo encolar" }, { status: 500 });
    }

    // Arranque inmediato en vez de esperar hasta un minuto al cron. Para un
    // archivo esto solo crea las tandas (el troceo es barato) y así la barra
    // de avance aparece al instante; transcribir sigue siendo del cron. Para
    // markdown pegado a mano hace además el ensamblado, que son segundos.
    // Si falla, no pasa nada: el cron lo recoge igual.
    await pokeWorker("kb-transcribe", job.id);
    if (!storagePath) await pokeWorker("kb-assemble", job.id);

    return NextResponse.json({ ok: true, job_id: job.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("kb/jobs POST:", err);
    return NextResponse.json({ error: `error inesperado: ${msg}` }, { status: 500 });
  }
}

/** GET ?vertical_id= — avance de las cargas de esa vertical. */
export async function GET(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const verticalId = new URL(request.url).searchParams.get("vertical_id");
  if (!verticalId) return NextResponse.json({ error: "falta vertical_id" }, { status: 400 });

  // La vista no trae `texto` a propósito: el raw_text de un condicionado son
  // cientos de KB y esto se consulta cada pocos segundos. El texto se pide
  // aparte, solo cuando el operador abre una revisión.
  const { data, error } = await supabase
    .from("kb_ingest_avance")
    .select("*")
    .eq("vertical_id", verticalId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, jobs: data ?? [] });
}
