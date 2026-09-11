import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

const BUCKET = "kb-uploads";

function safeName(base: string): string {
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "documento";
}

/**
 * GET — descarga.
 *
 *   ?original=1  el ARCHIVO tal como se subió (0084). Es lo que permite
 *                reprocesar un documento mal extraído sin pedírselo otra vez
 *                al operador. NULL en los documentos anteriores a la 0084 y en
 *                el markdown pegado a mano, que nunca tuvo archivo.
 *   (sin nada)   el texto extraído, que es lo que el agente realmente ve.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("kb_documents")
    .select("title, raw_text, source_filename, storage_path")
    .eq("id", params.id)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "no encontrado" }, { status: 404 });
  }

  const quiereOriginal = new URL(request.url).searchParams.get("original") === "1";
  if (quiereOriginal) {
    if (!data.storage_path) {
      return NextResponse.json(
        {
          error:
            "Este documento no tiene archivo original guardado: se indexó antes de que se conservaran (0084) o su contenido se pegó a mano.",
        },
        { status: 404 }
      );
    }
    // El bucket es privado, así que se sirve con la clave de servicio en vez
    // de exponer una URL firmada al navegador.
    const admin = createServiceClient();
    const { data: blob, error: dlErr } = await admin.storage
      .from(BUCKET)
      .download(data.storage_path as string);
    if (dlErr || !blob) {
      return NextResponse.json(
        { error: `no se pudo leer el original: ${dlErr?.message ?? "no encontrado"}` },
        { status: 404 }
      );
    }
    const nombre = safeName((data.source_filename as string) || data.title);
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": blob.type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${nombre}"`,
      },
    });
  }

  const base = data.source_filename
    ? data.source_filename.replace(/\.[^.]+$/, "")
    : data.title;
  return new Response(data.raw_text ?? "", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName(base)}.txt"`,
    },
  });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // El original se borra con el documento: es su dueño. Se lee ANTES del
  // delete, porque después la fila ya no está para saber qué objeto tocar.
  const { data: doc } = await supabase
    .from("kb_documents")
    .select("storage_path")
    .eq("id", params.id)
    .single();

  // ON DELETE CASCADE en kb_chunks → se borran solos
  const { error } = await supabase.from("kb_documents").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (doc?.storage_path) {
    // El archivo se comparte durante un reproceso (0085): el job nuevo y el
    // documento nuevo apuntan al MISMO objeto. Borrarlo acá a ciegas dejaría
    // al que queda sin original, que es justo el problema que la 0084 vino a
    // arreglar. Solo se borra si ya nadie lo referencia.
    const [{ count: otrosDocs }, { count: jobsVivos }] = await Promise.all([
      supabase
        .from("kb_documents")
        .select("id", { count: "exact", head: true })
        .eq("storage_path", doc.storage_path as string),
      supabase
        .from("kb_ingest_jobs")
        .select("id", { count: "exact", head: true })
        .eq("storage_path", doc.storage_path as string)
        .in("status", ["pendiente", "transcribiendo", "ensamblando", "revision", "aprobado"]),
    ]);
    if ((otrosDocs ?? 0) === 0 && (jobsVivos ?? 0) === 0) {
      const admin = createServiceClient();
      await admin.storage.from(BUCKET).remove([doc.storage_path as string]).catch(() => {});
    }
  }
  return NextResponse.json({ ok: true });
}
