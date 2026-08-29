// server-only: transcripción de PDFs SIN capa de texto (flyers, folletos y
// escaneos) usando la visión de Claude.
//
// Por qué existe: mucho material comercial de la aseguradora son piezas de
// diseño exportadas como PDF de una sola imagen — `pdf-parse` devuelve 0
// caracteres y la ingesta los rechazaba con "contenido demasiado corto",
// dejando fuera de la KB justo los documentos con planes, primas y coberturas
// (comprobado con flyer-combinado-residencial: 0 chars por parseo → 2.7k
// caracteres útiles por visión).
//
// Se manda el PDF entero a la API (soporta `document` nativo, sin necesidad de
// rasterizar ni de @napi-rs/canvas). Solo se invoca como FALLBACK, cuando el
// parseo normal no dio texto — un PDF con texto real nunca gasta tokens acá.

import { recordWebUsage } from "@/lib/usage";

// Límite duro de la API de Anthropic: 32MB de request y 100 páginas. El base64
// infla ~33%, así que el PDF crudo debe quedar bien por debajo de 32MB. 20MB es
// el margen seguro (el bucket de subida permite hasta 50MB, ver 0061).
export const VISION_MAX_PDF_BYTES = 20 * 1024 * 1024;
// Las imágenes tienen un tope propio (mucho más bajo) en la API.
export const VISION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Extensiones que SOLO se pueden leer por visión (no tienen capa de texto).
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const PROMPT =
  "Transcribe TODO el texto visible de este documento, en orden de lectura. " +
  "Incluye títulos, coberturas, montos, primas, condiciones, exclusiones y datos de contacto tal cual aparecen. " +
  "Las tablas transcríbelas como líneas legibles, manteniendo la relación entre cada concepto y su valor. " +
  "No resumas, no interpretes y no agregues comentarios: SOLO el texto del documento. " +
  "Si el documento no tiene texto legible, responde exactamente: SIN_TEXTO_LEGIBLE";

export type VisionResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

// Presupuesto de salida. Arranca alto porque un folleto de 60 páginas no entra
// en 8k tokens, y si se pasa la transcripción se corta A LA MITAD sin avisar
// (comprobado: la API devuelve stop_reason="max_tokens" y el texto queda
// truncado en media frase). El reintento sube al techo del modelo.
const MAX_TOKENS_FIRST = 16000;
const MAX_TOKENS_RETRY = 64000;

/**
 * ¿El texto extraído está ilegible por culpa del PDF?
 *
 * Los flyers hechos en Illustrator/InDesign traen SÍ una capa de texto, pero
 * con posicionamiento por carácter: `pdf-parse` la extrae con los espacios
 * donde no van y las palabras pegadas, quedando algo como
 * "Pr ot ecci ónpar at i , par al osdemásypar at ut r anqui l i dad".
 * Eso pasa el umbral de tamaño (hay muchos caracteres) pero es basura: la
 * búsqueda semántica no lo encuentra y, si lo encontrara, el agente citaría
 * texto sin sentido. Medido sobre la KB real:
 *   sanos → largo medio de palabra 5.5, ~0% de palabras >25 chars
 *   rotos → largo medio 8.8 y 12.7, ~9% de palabras >25 chars
 * Los umbrales (8 y 3%) quedan lejos de ambos extremos para no marcar como
 * roto un documento legítimo.
 */
export function looksMangled(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  // Con muy pocas palabras la estadística no dice nada.
  if (tokens.length < 30) return false;
  const avgLen = tokens.reduce((acc, t) => acc + t.length, 0) / tokens.length;
  const gluedRatio = tokens.filter((t) => t.length > 25).length / tokens.length;
  return avgLen > 8 || gluedRatio > 0.03;
}

/**
 * Devuelve el texto transcrito del documento (PDF o imagen), o un motivo
 * legible de por qué no se pudo. NUNCA lanza: el llamador decide si degradar
 * a un error de validación.
 */
export async function transcribePdfWithVision(
  buffer: ArrayBuffer,
  opts: { apiKey: string; model: string; filename?: string; mediaType?: string }
): Promise<VisionResult> {
  // Un PDF viaja como bloque `document`; una imagen como bloque `image`, y
  // cada uno tiene su propio tope de tamaño en la API.
  const mediaType = opts.mediaType ?? "application/pdf";
  const isPdf = mediaType === "application/pdf";
  const maxBytes = isPdf ? VISION_MAX_PDF_BYTES : VISION_MAX_IMAGE_BYTES;
  if (buffer.byteLength > maxBytes) {
    const mb = (buffer.byteLength / (1024 * 1024)).toFixed(1);
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return {
      ok: false,
      reason: `${isPdf ? "el PDF" : "la imagen"} pesa ${mb}MB y no se puede leer por imagen (máximo ${maxMb}MB para eso)`,
    };
  }

  const attempt = async (maxTokens: number) => {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: maxTokens,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: isPdf ? "document" : "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: Buffer.from(buffer).toString("base64"),
                  },
                },
                { type: "text", text: PROMPT },
              ],
            },
          ],
        }),
      });
    } catch (err) {
      return { error: `no se pudo contactar el servicio de lectura: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return { error: `el servicio de lectura respondió ${res.status}: ${detail}` };
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    // fail-open: el consumo es contabilidad, no puede tumbar la ingesta.
    await recordWebUsage({
      component: "kb_ocr",
      model: opts.model,
      usage: {
        promptTokens: json.usage?.input_tokens,
        completionTokens: json.usage?.output_tokens,
      },
      metadata: { filename: opts.filename ?? null, bytes: buffer.byteLength, max_tokens: maxTokens },
    });
    return {
      text: (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim(),
      truncated: json.stop_reason === "max_tokens",
    };
  };

  let out = await attempt(MAX_TOKENS_FIRST);
  // Reproceso por truncado: el documento no entró en el presupuesto y el texto
  // quedó cortado a la mitad. Se reintenta una vez con el techo del modelo.
  if (!("error" in out) && out.truncated) {
    const retry = await attempt(MAX_TOKENS_RETRY);
    if (!("error" in retry)) out = retry;
  }
  if ("error" in out) return { ok: false, reason: out.error! };
  if (out.truncated) {
    return {
      ok: false,
      reason: "el documento es demasiado largo y la transcripción quedó incompleta; divídelo en partes más chicas",
    };
  }
  const text = out.text!;

  if (!text || text.includes("SIN_TEXTO_LEGIBLE")) {
    return { ok: false, reason: "el documento no tiene texto legible" };
  }
  return { ok: true, text };
}
