import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { pokeWorker } from "@/lib/kb-queue";

export const runtime = "nodejs";

/**
 * POST — vuelve a procesar un documento desde su archivo original (0085).
 *
 * Es lo que hace útil el original guardado: encola un job apuntando al MISMO
 * objeto del bucket, así que pasa otra vez por la extracción de hoy. Para un
 * escaneo o un flyer con el texto vectorizado eso significa visión en vez del
 * parseo que lo rompió, sin que nadie tenga que buscar el archivo.
 *
 * El documento viejo NO se toca acá: sigue sirviendo al agente hasta que el
 * nuevo esté indexado, y es el ensamblador quien lo borra entonces. Si el
 * reproceso falla, el viejo se queda donde estaba.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: doc, error } = await supabase
    .from("kb_documents")
    .select("id, title, vertical_id, storage_path, source_filename, source_type")
    .eq("id", params.id)
    .single();
  if (error || !doc) return NextResponse.json({ error: "no encontrado" }, { status: 404 });

  if (!doc.storage_path) {
    return NextResponse.json(
      {
        error:
          "Este documento no tiene archivo original guardado, así que no se puede reprocesar: se indexó antes de que se conservaran o su contenido se pegó a mano. Hay que volver a subirlo.",
      },
      { status: 422 }
    );
  }
  if (!doc.vertical_id) {
    return NextResponse.json({ error: "el documento no está atado a ninguna vertical" }, { status: 422 });
  }

  // Un solo reproceso a la vez por documento: dos jobs sobre el mismo archivo
  // acabarían indexándolo dos veces y borrando el viejo dos veces.
  const { data: enCurso } = await supabase
    .from("kb_ingest_jobs")
    .select("id")
    .eq("reemplaza_document_id", doc.id)
    .in("status", ["pendiente", "transcribiendo", "ensamblando", "revision", "aprobado"])
    .limit(1);
  if (enCurso && enCurso.length > 0) {
    return NextResponse.json(
      { error: "ya hay un reproceso en curso para este documento." },
      { status: 409 }
    );
  }

  const filename = (doc.source_filename as string) || `${doc.title}.${doc.source_type ?? "pdf"}`;
  const ext = filename.split(".").pop()?.toLowerCase() || String(doc.source_type ?? "pdf");

  const { data: job, error: eJob } = await supabase
    .from("kb_ingest_jobs")
    .insert({
      vertical_id: doc.vertical_id,
      title: doc.title,
      storage_path: doc.storage_path,
      filename,
      ext,
      created_by: user.id,
      reemplaza_document_id: doc.id,
    })
    .select("id")
    .single();
  if (eJob || !job) {
    return NextResponse.json({ error: eJob?.message ?? "no se pudo encolar" }, { status: 500 });
  }

  // Trocear ya, para que la barra de avance aparezca al instante; transcribir
  // sigue siendo del cron.
  await pokeWorker("kb-transcribe", job.id);
  return NextResponse.json({ ok: true, job_id: job.id });
}
