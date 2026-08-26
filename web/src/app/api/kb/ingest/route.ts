import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { parseDocument, chunkText } from "@/lib/kb-parsers";
import { embedTexts } from "@/lib/embed";

export const maxDuration = 60;

const ACCEPTED = new Set(["pdf", "docx", "txt", "md", "srt", "vtt"]);
const KB_UPLOADS_BUCKET = "kb-uploads";

export async function POST(request: Request) {
  // Handler completo envuelto: sin esto, una excepción durante el parseo de
  // PDF/DOCX se escapaba como un 500 sin cuerpo JSON — el frontend hacía
  // `res.json()` sobre eso, explotaba en silencio, y el usuario veía "no pasó
  // nada" sin ningún error ni el documento en la lista.
  try {
    return await handleIngest(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("kb/ingest: unhandled error:", err);
    return NextResponse.json({ error: `error inesperado: ${msg}` }, { status: 500 });
  }
}

// El archivo NO viaja en este request: las funciones de Netlify cortan la
// conexión en payloads grandes (probado en vivo: un PDF de 18.5MB nunca
// llegaba a completarse, sin ningún error legible). El frontend lo sube antes,
// directo desde el navegador a Supabase Storage (bucket privado `kb-uploads`,
// hasta 50MB — 0061_kb_uploads_bucket.sql), y acá solo llega el `storage_path`
// — este endpoint lo descarga server-to-server (sin ese límite) y lo borra al
// terminar. `content` (texto pegado) sigue viniendo inline, es siempre chico.
async function handleIngest(request: Request): Promise<Response> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json()) as {
    title?: string;
    vertical_id?: string;
    content?: string;
    storage_path?: string;
    filename?: string;
  };
  const title = body.title?.trim();
  const inlineContent = body.content;
  const storagePath = body.storage_path?.trim();
  // El agente SIEMPRE responde dentro de una vertical — no existe el concepto
  // de "documento general" — así que todo documento debe estar atado a una.
  const verticalId = body.vertical_id?.trim();

  if (!title) return NextResponse.json({ error: "title requerido" }, { status: 400 });
  if (!verticalId) return NextResponse.json({ error: "vertical_id requerido" }, { status: 400 });

  let text: string;
  let format: string;
  let filename: string;

  if (storagePath) {
    filename = body.filename?.trim() || storagePath.split("/").pop() || "archivo";
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    if (!ACCEPTED.has(ext)) {
      return NextResponse.json(
        { error: `formato no soportado: .${ext}. Acepta: ${Array.from(ACCEPTED).join(", ")}` },
        { status: 400 }
      );
    }
    // Service role: el objeto lo subió el mismo usuario autenticado (RLS del
    // bucket ya lo verificó al subir), acá solo lo leemos server-to-server.
    const storageAdmin = createServiceClient();
    const { data: fileData, error: dlErr } = await storageAdmin.storage
      .from(KB_UPLOADS_BUCKET)
      .download(storagePath);
    if (dlErr || !fileData) {
      return NextResponse.json(
        { error: `no se pudo leer el archivo subido: ${dlErr?.message ?? "no encontrado"}` },
        { status: 404 }
      );
    }
    const buf = await fileData.arrayBuffer();
    let parsed: Awaited<ReturnType<typeof parseDocument>>;
    try {
      parsed = await parseDocument(buf, filename);
    } catch (parseErr) {
      await storageAdmin.storage.from(KB_UPLOADS_BUCKET).remove([storagePath]);
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return NextResponse.json({ error: `no se pudo leer el archivo .${ext}: ${msg}` }, { status: 422 });
    }
    await storageAdmin.storage.from(KB_UPLOADS_BUCKET).remove([storagePath]);
    text = parsed.text;
    format = parsed.format;
  } else if (inlineContent?.trim()) {
    filename = "inline.md";
    text = inlineContent;
    format = "md";
  } else {
    return NextResponse.json({ error: "sube archivo o pega contenido" }, { status: 400 });
  }

  if (text.trim().length < 50) {
    return NextResponse.json({ error: "contenido demasiado corto (<50 chars)" }, { status: 400 });
  }

  // Chunkear
  const chunks = chunkText(text, { maxTokens: 450, overlapTokens: 60 });
  if (chunks.length === 0) {
    return NextResponse.json({ error: "chunking produjo 0 chunks" }, { status: 400 });
  }

  // Crear documento maestro
  const { data: doc, error: docErr } = await supabase
    .from("kb_documents")
    .insert({
      title,
      source_type: format,
      source_filename: filename,
      raw_text: text,
      embeddings_provider: "supabase_ai_gte_small",
      embeddings_dim: 384,
      total_chunks: chunks.length,
      metadata: { format },
      vertical_id: verticalId,
    })
    .select("id")
    .single();
  if (docErr || !doc) {
    return NextResponse.json({ error: docErr?.message ?? "no se pudo crear documento" }, { status: 500 });
  }

  // Embeber chunks
  let embeddings: number[][];
  try {
    embeddings = await embedTexts(chunks);
  } catch (err) {
    await supabase.from("kb_documents").delete().eq("id", doc.id);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `embed: ${msg}` }, { status: 502 });
  }

  // Insertar chunks
  const { error: chunksErr } = await supabase.from("kb_chunks").insert(
    chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: embeddings[i],
      token_count: Math.ceil(content.split(/\s+/).length * 1.3),
      metadata: {},
    }))
  );
  if (chunksErr) {
    await supabase.from("kb_documents").delete().eq("id", doc.id);
    return NextResponse.json({ error: chunksErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    document_id: doc.id,
    chunks: chunks.length,
    chars: text.length,
  });
}
