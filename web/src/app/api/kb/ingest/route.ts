import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { parseDocument, chunkText } from "@/lib/kb-parsers";
import { embedTexts } from "@/lib/embed";
import { configValue } from "@/lib/runtime-config";
import { transcribePdfWithVision, looksMangled, IMAGE_MEDIA_TYPES } from "@/lib/kb-vision";
import { MODEL_KEYS } from "@/lib/model-config";

// nodejs runtime: pdf-parse y la llamada a Anthropic no corren en Edge.
export const runtime = "nodejs";
// La lectura por visión de un PDF grande puede tardar ~15s, encima del parseo
// y de los embeddings. 60s se quedaba corto en el peor caso.
export const maxDuration = 120;

const ACCEPTED = new Set(["pdf", "docx", "txt", "md", "srt", "vtt"]);
const KB_UPLOADS_BUCKET = "kb-uploads";
// Debajo de esto no hay nada que indexar de verdad (y dispara el fallback por
// visión en PDFs).
const MIN_CHARS = 50;

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
  // El texto vino de la visión de Claude (PDF sin capa de texto), no del
  // parseo directo. Queda en metadata para poder auditar de dónde salió cada
  // documento de la KB.
  let viaVision = false;

  if (storagePath) {
    filename = body.filename?.trim() || storagePath.split("/").pop() || "archivo";
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    // Service role: el objeto lo subió el mismo usuario autenticado (RLS del
    // bucket ya lo verificó al subir), acá solo lo leemos server-to-server.
    const storageAdmin = createServiceClient();
    // El archivo YA está en el bucket: cualquier salida a partir de acá tiene
    // que borrarlo o queda huérfano ocupando espacio para siempre (pasó: dos
    // PNG rechazados por formato quedaron colgados en kb-uploads).
    const limpiar = () =>
      storageAdmin.storage.from(KB_UPLOADS_BUCKET).remove([storagePath]).catch(() => {});

    const esImagen = ext in IMAGE_MEDIA_TYPES;
    if (!ACCEPTED.has(ext) && !esImagen) {
      await limpiar();
      const soportados = [...Array.from(ACCEPTED), ...Object.keys(IMAGE_MEDIA_TYPES)].join(", ");
      return NextResponse.json(
        { error: `formato no soportado: .${ext}. Acepta: ${soportados}` },
        { status: 400 }
      );
    }
    const { data: fileData, error: dlErr } = await storageAdmin.storage
      .from(KB_UPLOADS_BUCKET)
      .download(storagePath);
    if (dlErr || !fileData) {
      await limpiar();
      return NextResponse.json(
        { error: `no se pudo leer el archivo subido: ${dlErr?.message ?? "no encontrado"}` },
        { status: 404 }
      );
    }
    const buf = await fileData.arrayBuffer();

    if (esImagen) {
      // Una imagen (captura de un flyer, foto de un tarifario) no tiene texto
      // que parsear: va directo a visión. Antes se rechazaba por formato.
      const apiKey = await configValue("ANTHROPIC_API_KEY");
      if (!apiKey) {
        await limpiar();
        return NextResponse.json(
          { error: "Para leer imágenes hace falta configurar la clave de Anthropic; mientras tanto, pega el contenido en el campo de markdown." },
          { status: 422 }
        );
      }
      const model = (await configValue("KB_OCR_MODEL")) || MODEL_KEYS.KB_OCR_MODEL;
      const vision = await transcribePdfWithVision(buf, {
        apiKey,
        model,
        filename,
        mediaType: IMAGE_MEDIA_TYPES[ext],
      });
      await limpiar();
      if (!vision.ok) {
        return NextResponse.json(
          { error: `No se pudo leer la imagen: ${vision.reason}. Pega el contenido en el campo de markdown.` },
          { status: 422 }
        );
      }
      // Sigue por el camino común de abajo (validación de largo → chunking →
      // embeddings → insert), igual que cualquier otro documento.
      text = vision.text;
      format = ext;
      viaVision = true;
    } else {
      let parsed: Awaited<ReturnType<typeof parseDocument>>;
      try {
        parsed = await parseDocument(buf, filename);
      } catch (parseErr) {
        await limpiar();
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return NextResponse.json({ error: `no se pudo leer el archivo .${ext}: ${msg}` }, { status: 422 });
      }
      text = parsed.text;
      format = parsed.format;

      // Fallback por visión, en dos casos que antes arruinaban la KB:
      //  a) PDF SIN capa de texto (flyer exportado como imagen) → 0 caracteres,
      //     se rechazaba con "contenido demasiado corto".
      //  b) PDF con capa de texto ROTA (kerning por carácter de
      //     Illustrator/InDesign) → pasaba el umbral pero entraba como basura
      //     ilegible, invisible para la búsqueda semántica (ver looksMangled).
      // Solo aplica a PDF y solo si hace falta: un PDF sano no gasta tokens.
      const sinTexto = text.trim().length < MIN_CHARS;
      const roto = !sinTexto && looksMangled(text);
      if (ext === "pdf" && (sinTexto || roto)) {
        const diagnostico = sinTexto
          ? "Este PDF no tiene texto seleccionable (es una imagen)"
          : "El texto de este PDF se extrae ilegible (es un diseño con el texto vectorizado)";
        const apiKey = await configValue("ANTHROPIC_API_KEY");
        if (!apiKey) {
          await limpiar();
          return NextResponse.json(
            {
              error: `${diagnostico}. Para leerlo automáticamente hace falta configurar la clave de Anthropic; mientras tanto, pega el contenido en el campo de markdown.`,
            },
            { status: 422 }
          );
        }
        const model = (await configValue("KB_OCR_MODEL")) || MODEL_KEYS.KB_OCR_MODEL;
        const vision = await transcribePdfWithVision(buf, { apiKey, model, filename });
        if (!vision.ok) {
          // Con texto roto NO se guarda igual: basura en la KB es peor que
          // nada (el agente citaría texto sin sentido y la búsqueda no lo
          // encuentra).
          await limpiar();
          return NextResponse.json(
            {
              error: `${diagnostico} y no se pudo leer por imagen: ${vision.reason}. Pega el contenido en el campo de markdown.`,
            },
            { status: 422 }
          );
        }
        text = vision.text;
        viaVision = true;
      }

      await limpiar();
    }
  } else if (inlineContent?.trim()) {
    filename = "inline.md";
    text = inlineContent;
    format = "md";
  } else {
    return NextResponse.json({ error: "sube archivo o pega contenido" }, { status: 400 });
  }

  if (text.trim().length < MIN_CHARS) {
    return NextResponse.json(
      { error: `contenido demasiado corto (<${MIN_CHARS} chars) — el documento no tiene texto suficiente para indexar.` },
      { status: 400 }
    );
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
      metadata: { format, ...(viaVision ? { extracted_via: "vision" } : {}) },
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
