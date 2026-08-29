import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { configValue } from "@/lib/runtime-config";
import { validarFidelidad } from "@/lib/kb-validate";
import { IMAGE_MEDIA_TYPES } from "@/lib/kb-vision";
import { MODEL_KEYS } from "@/lib/model-config";

export const runtime = "nodejs";
export const maxDuration = 60;

// PASO 2 de la ingesta: VERIFICAR que lo transcrito coincida con el documento.
//
// Va en su propia petición porque el juez tarda ~20s y sumado a la extracción
// no entra en el límite de 26s de Netlify (ver comentario en /api/kb/prepare).
//
// Solo aplica a texto producido por un modelo (visión): el parseo mecánico de
// un PDF con capa de texto no puede inventar nada.

const KB_UPLOADS_BUCKET = "kb-uploads";

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
      text?: string;
    };
    const storagePath = body.storage_path?.trim();
    const texto = body.text ?? "";
    if (!storagePath) return NextResponse.json({ error: "storage_path requerido" }, { status: 400 });
    if (!texto.trim()) return NextResponse.json({ error: "text requerido" }, { status: 400 });

    const apiKey = await configValue("ANTHROPIC_API_KEY");
    if (!apiKey) {
      // Sin clave no se puede verificar: se reporta como duda (el llamador lo
      // manda a revisión humana) en vez de aprobarlo a ciegas.
      return NextResponse.json({
        ok: true,
        veredicto: "duda",
        problemas: ["no se pudo validar automáticamente (falta la clave de Anthropic)"],
      });
    }

    const filename = body.filename?.trim() || storagePath.split("/").pop() || "archivo";
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "application/pdf";

    const storageAdmin = createServiceClient();
    const { data: fileData, error: dlErr } = await storageAdmin.storage
      .from(KB_UPLOADS_BUCKET)
      .download(storagePath);
    if (dlErr || !fileData) {
      return NextResponse.json({
        ok: true,
        veredicto: "duda",
        problemas: ["no se pudo releer el documento original para verificarlo"],
      });
    }

    const judgeModel = (await configValue("KB_JUDGE_MODEL")) || MODEL_KEYS.KB_JUDGE_MODEL;
    const fid = await validarFidelidad(await fileData.arrayBuffer(), texto, {
      apiKey,
      model: judgeModel,
      mediaType,
      filename,
    });

    return NextResponse.json({ ok: true, veredicto: fid.veredicto, problemas: fid.problemas });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("kb/verify:", err);
    return NextResponse.json({ error: `error inesperado: ${msg}` }, { status: 500 });
  }
}
