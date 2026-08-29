import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { chunkText } from "@/lib/kb-parsers";
import { embedTexts } from "@/lib/embed";
import { configValue } from "@/lib/runtime-config";
import { validarVertical } from "@/lib/kb-validate";
import { MODEL_KEYS } from "@/lib/model-config";

// nodejs runtime: la llamada a Anthropic no corre en Edge.
export const runtime = "nodejs";
export const maxDuration = 60;

const KB_UPLOADS_BUCKET = "kb-uploads";
const MIN_CHARS = 50;

export async function POST(request: Request) {
  // Handler envuelto: sin esto, una excepción se escapaba como un 500 sin
  // cuerpo JSON — el frontend hacía `res.json()` sobre eso, explotaba en
  // silencio, y el usuario veía "no pasó nada" sin ningún error.
  try {
    return await handleIngest(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("kb/ingest: unhandled error:", err);
    return NextResponse.json({ error: `error inesperado: ${msg}` }, { status: 500 });
  }
}

// PASO 3 (final) de la ingesta: valida la VERTICAL e indexa.
//
// El texto ya viene extraído por /api/kb/prepare y verificado por
// /api/kb/verify — el trabajo está partido en tres peticiones porque las
// funciones síncronas de Netlify cortan a los 26s y todo junto no entra
// (medido en producción: 18.9s solo extraer+indexar, y el juez suma ~20s).
//
// Acá llega siempre `content` (texto). `storage_path` es opcional y solo sirve
// para borrar el archivo temporal del bucket al terminar.
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
    /** Solo para limpiar el temporal del bucket. */
    storage_path?: string;
    filename?: string;
    format?: string;
    /** El texto lo produjo un modelo (visión), no el parseo mecánico. */
    via_vision?: boolean;
    /** El humano revisó y aprobó este texto en la vista previa. */
    confirmed?: boolean;
    /** Reparos que traía de la verificación de fidelidad. */
    issues?: string[];
  };

  const title = body.title?.trim();
  const verticalId = body.vertical_id?.trim();
  const text = body.content ?? "";
  const confirmed = body.confirmed === true;
  const filename = body.filename?.trim() || "inline.md";
  const format = body.format?.trim() || "md";
  const viaVision = body.via_vision === true;

  if (!title) return NextResponse.json({ error: "title requerido" }, { status: 400 });
  if (!verticalId) return NextResponse.json({ error: "vertical_id requerido" }, { status: 400 });

  const storageAdmin = createServiceClient();
  const storagePath = body.storage_path?.trim();
  const limpiar = () =>
    storagePath
      ? storageAdmin.storage.from(KB_UPLOADS_BUCKET).remove([storagePath]).catch(() => {})
      : Promise.resolve();

  if (text.trim().length < MIN_CHARS) {
    await limpiar();
    return NextResponse.json(
      { error: `contenido demasiado corto (<${MIN_CHARS} chars) — no hay texto suficiente para indexar.` },
      { status: 400 }
    );
  }

  // ---- Control de calidad antes de que la data entre a la vertical ----
  // Nada entra sin verificarse. Los reparos de fidelidad vienen del paso
  // anterior; acá se agrega el chequeo de vertical, que aplica a TODO
  // documento (incluido el markdown pegado a mano). `confirmed` salta el
  // gate: ya pasó por revisión humana, que es más autoridad que el juez.
  const dudas: string[] = Array.isArray(body.issues) ? body.issues.filter(Boolean).map(String) : [];
  if (!confirmed) {
    const apiKey = await configValue("ANTHROPIC_API_KEY");
    if (!apiKey) {
      dudas.push("no se pudo validar automáticamente (falta la clave de Anthropic)");
    } else {
      const judgeModel = (await configValue("KB_JUDGE_MODEL")) || MODEL_KEYS.KB_JUDGE_MODEL;
      const { data: vs } = await supabase.from("verticals").select("id, slug, name, description");
      const todas = (vs ?? []) as Array<{ id: string; slug: string; name: string; description: string | null }>;
      const destino = todas.find((v) => v.id === verticalId);
      if (destino) {
        const ver = await validarVertical(text, {
          apiKey,
          model: judgeModel,
          verticalSlug: destino.slug,
          verticalNombre: destino.name,
          verticalDescripcion: destino.description,
          otrasVerticales: todas
            .filter((v) => v.id !== verticalId)
            .map((v) => ({ slug: v.slug, description: v.description })),
          filename,
        });
        // Vertical equivocada = BLOQUEO. Un tarifario de auto dentro de
        // "salud" hace que el agente le cite coberturas de auto a alguien que
        // pregunta por una póliza médica.
        if (ver.veredicto === "mal") {
          await limpiar();
          const sugerencia = ver.vertical_sugerida ? ` Parece pertenecer a "${ver.vertical_sugerida}".` : "";
          return NextResponse.json(
            {
              error: `Este documento no corresponde a la vertical "${destino.slug}".${sugerencia} ${ver.motivo ?? ""} No se indexó — súbelo en la vertical correcta.`.trim(),
            },
            { status: 422 }
          );
        }
        if (ver.veredicto === "duda") {
          dudas.push(
            ver.motivo
              ? `encaje con la vertical "${destino.slug}" no es claro: ${ver.motivo}`
              : `no está claro si corresponde a la vertical "${destino.slug}"`
          );
        }
      }
    }
  }

  // Hay observaciones: NO se indexa. Se devuelve el texto para que el humano
  // lo revise (y edite si hace falta) y confirme. Ese POST vuelve con
  // `confirmed: true` y entra directo.
  if (dudas.length > 0) {
    await limpiar();
    return NextResponse.json({
      ok: false,
      needsConfirmation: true,
      text,
      issues: dudas,
      format,
      filename,
      viaVision,
      chars: text.trim().length,
    });
  }

  await limpiar();

  const chunks = chunkText(text, { maxTokens: 450, overlapTokens: 60 });
  if (chunks.length === 0) {
    return NextResponse.json({ error: "chunking produjo 0 chunks" }, { status: 400 });
  }

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
      metadata: {
        format,
        ...(viaVision ? { extracted_via: "vision" } : {}),
        // Trazabilidad de CÓMO pasó el control de calidad.
        validation: confirmed ? "humano" : "automatico",
      },
      vertical_id: verticalId,
    })
    .select("id")
    .single();
  if (docErr || !doc) {
    return NextResponse.json({ error: docErr?.message ?? "no se pudo crear documento" }, { status: 500 });
  }

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(chunks);
  } catch (err) {
    await supabase.from("kb_documents").delete().eq("id", doc.id);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `embed: ${msg}` }, { status: 502 });
  }

  const { error: chunksErr } = await supabase.from("kb_chunks").insert(
    chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: embeddings[i],
      token_count: Math.ceil(content.split(/\s+/).length * 1.8),
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
