import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { parseDocument } from "@/lib/kb-parsers";
import { configValue } from "@/lib/runtime-config";
import { transcribePdfWithVision, looksMangled, IMAGE_MEDIA_TYPES } from "@/lib/kb-vision";
import { MODEL_KEYS } from "@/lib/model-config";

export const runtime = "nodejs";
export const maxDuration = 60;

// PASO 1 de la ingesta: EXTRAER el texto del archivo ya subido a Storage.
//
// Está separado de /api/kb/ingest por un límite duro de la plataforma: las
// funciones síncronas de Netlify cortan a los 26s (plan Pro) y una ingesta
// completa medida en producción ya consumía 18.9s solo con transcribir +
// chunkear + embeber. Meter además el juez de fidelidad (~20s) la reventaba.
// Por eso el trabajo se parte en pasos que el navegador encadena, cada uno
// holgadamente bajo el límite: prepare (acá) → verify → ingest.
//
// NO borra el objeto de Storage: los pasos siguientes (verificar, reprocesar)
// necesitan el documento original. Lo borra /api/kb/ingest al final.

const ACCEPTED = new Set(["pdf", "docx", "txt", "md", "srt", "vtt"]);
const KB_UPLOADS_BUCKET = "kb-uploads";
const MIN_CHARS = 50;

export async function POST(request: Request) {
  try {
    const supabase = createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await request.json()) as {
      storage_path?: string;
      filename?: string;
      /** true = reproceso: usa el modelo capaz en vez del barato. */
      capable?: boolean;
    };
    const storagePath = body.storage_path?.trim();
    if (!storagePath) return NextResponse.json({ error: "storage_path requerido" }, { status: 400 });
    const filename = body.filename?.trim() || storagePath.split("/").pop() || "archivo";
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";

    const storageAdmin = createServiceClient();
    const limpiar = () =>
      storageAdmin.storage.from(KB_UPLOADS_BUCKET).remove([storagePath]).catch(() => {});

    const esImagen = ext in IMAGE_MEDIA_TYPES;
    if (!ACCEPTED.has(ext) && !esImagen) {
      await limpiar();
      const soportados = [...Array.from(ACCEPTED), ...Object.keys(IMAGE_MEDIA_TYPES)].join(", ");
      return NextResponse.json({ error: `formato no soportado: .${ext}. Acepta: ${soportados}` }, { status: 400 });
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

    const apiKey = await configValue("ANTHROPIC_API_KEY");
    const ocrModel = body.capable
      ? (await configValue("KB_JUDGE_MODEL")) || MODEL_KEYS.KB_JUDGE_MODEL
      : (await configValue("KB_OCR_MODEL")) || MODEL_KEYS.KB_OCR_MODEL;

    // --- Imagen: no hay texto que parsear, va directo a visión ---
    if (esImagen) {
      if (!apiKey) {
        await limpiar();
        return NextResponse.json(
          { error: "Para leer imágenes hace falta configurar la clave de Anthropic; pega el contenido en el campo de markdown." },
          { status: 422 }
        );
      }
      const vision = await transcribePdfWithVision(buf, {
        apiKey,
        model: ocrModel,
        filename,
        mediaType: IMAGE_MEDIA_TYPES[ext],
      });
      if (!vision.ok) {
        await limpiar();
        return NextResponse.json(
          { error: `No se pudo leer la imagen: ${vision.reason}. Pega el contenido en el campo de markdown.` },
          { status: 422 }
        );
      }
      return NextResponse.json({
        ok: true,
        text: vision.text,
        format: ext,
        filename,
        viaVision: true,
        needsFidelity: true,
      });
    }

    // --- Documento con posible capa de texto ---
    let parsed: Awaited<ReturnType<typeof parseDocument>>;
    try {
      parsed = await parseDocument(buf, filename);
    } catch (parseErr) {
      await limpiar();
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return NextResponse.json({ error: `no se pudo leer el archivo .${ext}: ${msg}` }, { status: 422 });
    }

    const sinTexto = parsed.text.trim().length < MIN_CHARS;
    const roto = !sinTexto && looksMangled(parsed.text);
    // Un PDF sano NO pasa por visión: se devuelve el texto parseado tal cual y
    // no gasta ni un token.
    if (ext !== "pdf" || (!sinTexto && !roto)) {
      if (sinTexto) {
        await limpiar();
        return NextResponse.json(
          { error: `El archivo no tiene texto suficiente para indexar (menos de ${MIN_CHARS} caracteres).` },
          { status: 422 }
        );
      }
      return NextResponse.json({
        ok: true,
        text: parsed.text,
        format: parsed.format,
        filename,
        viaVision: false,
        needsFidelity: false,
      });
    }

    // PDF sin texto o con la capa de texto ilegible → visión.
    const diagnostico = sinTexto
      ? "Este PDF no tiene texto seleccionable (es una imagen)"
      : "El texto de este PDF se extrae ilegible (es un diseño con el texto vectorizado)";
    if (!apiKey) {
      await limpiar();
      return NextResponse.json(
        { error: `${diagnostico}. Para leerlo automáticamente hace falta configurar la clave de Anthropic; pega el contenido en el campo de markdown.` },
        { status: 422 }
      );
    }
    const vision = await transcribePdfWithVision(buf, {
      apiKey,
      model: ocrModel,
      filename,
      mediaType: "application/pdf",
    });
    if (!vision.ok) {
      await limpiar();
      return NextResponse.json(
        { error: `${diagnostico} y no se pudo leer por imagen: ${vision.reason}. Pega el contenido en el campo de markdown.` },
        { status: 422 }
      );
    }
    return NextResponse.json({
      ok: true,
      text: vision.text,
      format: "pdf",
      filename,
      viaVision: true,
      needsFidelity: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("kb/prepare:", err);
    return NextResponse.json({ error: `error inesperado: ${msg}` }, { status: 500 });
  }
}
