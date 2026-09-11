// _shared/kb-extract.ts
// La ÚNICA casa de la extracción de KB: parseo, troceo por páginas,
// transcripción por visión, los dos jueces y el chunker semántico.
//
// Vivía en `web/src/lib/{kb-parsers,kb-vision,kb-validate}.ts` (Node/Netlify).
// Se mudó entero acá el 10-09 por dos razones que empujan en la misma
// dirección: la extracción no cabe en los 26s de una función de Netlify
// (ver 0080), y tener los prompts del transcriptor y del juez en dos runtimes
// es exactamente la forma de la trampa 24 — dos copias de una regla que se
// desincronizan sin que nadie lo note. Netlify ya no extrae nada: sube el
// archivo, encola y muestra el avance.
//
// Nada de acá lanza por un fallo del proveedor: se devuelve un motivo legible
// y el llamador decide si manda a revisión humana o marca la tanda fallida.

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { recordUsage } from "./usage.ts";

// ---------------------------------------------------------------------------
// Límites de la API
// ---------------------------------------------------------------------------

// 32MB de request, y el base64 infla ~33%: el PDF crudo tiene que quedar bien
// por debajo. 20MB es el margen seguro.
export const VISION_MAX_PDF_BYTES = 20 * 1024 * 1024;
// Las imágenes tienen un tope propio, mucho más bajo.
export const VISION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Páginas máximas que acepta un bloque `document`.
 *
 * NO es un número fijo: la API admite 600, pero baja a 100 en los modelos de
 * ventana 200K, porque el documento entero tiene que caberles en el contexto.
 * Haiku 4.5 es de 200K; Sonnet y Opus son de 1M. Como el troceo por tandas
 * (0080) manda rangos de ~10 páginas, esto casi nunca se toca — está para que
 * un cambio de tamaño de tanda no se estrelle contra un 400 del proveedor.
 */
const MODELOS_200K = new Set(["claude-haiku-4-5"]);
export function paginasMaximas(model: string): number {
  return MODELOS_200K.has(model) ? 100 : 600;
}

// Formatos con capa de texto propia.
export const FORMATOS_TEXTO = new Set(["pdf", "docx", "txt", "md", "srt", "vtt"]);
// Formatos que SOLO se pueden leer por visión.
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

// Un archivo más grande que esto no se abre con pdf-lib: el worker tiene 256MB
// y cargar el PDF entero + la copia de las páginas + el base64 lo revienta.
// No limita el tamaño del DOCUMENTO que se puede indexar: cada tanda que se
// manda a la API es un sub-PDF chico, así que el tope de 20MB de visión deja
// de aplicar al documento completo en cuanto se trocea.
export const MAX_BYTES_ARCHIVO = 30 * 1024 * 1024;

export const MIN_CHARS = 50;

// ---------------------------------------------------------------------------
// ¿Este PDF tiene texto de verdad?
// ---------------------------------------------------------------------------

/**
 * ¿El texto extraído está ilegible por culpa del PDF?
 *
 * Los flyers hechos en Illustrator/InDesign traen SÍ una capa de texto, pero
 * con posicionamiento por carácter: se extrae con los espacios donde no van y
 * las palabras pegadas ("Pr ot ecci ónpar at i"). Eso pasa el umbral de tamaño
 * (hay muchos caracteres) pero es basura. Medido sobre la KB real:
 *   sanos → largo medio de palabra 5.5, ~0% de palabras >25 chars
 *   rotos → largo medio 8.8 y 12.7, ~9% de palabras >25 chars
 */
export function looksMangled(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 30) return false;
  const avgLen = tokens.reduce((acc, t) => acc + t.length, 0) / tokens.length;
  const gluedRatio = tokens.filter((t) => t.length > 25).length / tokens.length;
  return avgLen > 8 || gluedRatio > 0.03;
}

/**
 * ¿El PDF trae capa de texto, o solo restos?
 *
 * Un umbral ABSOLUTO de caracteres no distingue "documento corto" de "escaneo
 * de 40 páginas con el folio impreso": lo que los separa es cuánto texto hay
 * POR PÁGINA. Una página real trae cientos de caracteres; una escaneada trae
 * 0, o un puñado si el PDF lleva foliado, un sello del escáner o una marca de
 * agua. 25 queda lejos de los dos extremos, y equivocarse hacia este lado no
 * rompe nada: manda el documento a visión, que lee mejor que el parseo.
 *
 * Esto es la trampa 38 con otro nombre. La versión anterior comparaba contra
 * 50 caracteres absolutos y el separador de páginas que el parser intercalaba
 * ("-- 1 of 4 --") ya los superaba solo, así que ningún escaneo de 4 páginas o
 * más llegaba nunca a la visión.
 */
export const MIN_CHARS_POR_PAGINA = 25;
export function sinCapaDeTexto(text: string, pages: number | undefined): boolean {
  if (!pages || pages <= 0) return false;
  return text.trim().length / pages < MIN_CHARS_POR_PAGINA;
}

// ---------------------------------------------------------------------------
// Lectura del archivo
// ---------------------------------------------------------------------------

export type SondeoPdf = { pages: number; textoCapa: string };

/**
 * Cuenta las páginas y lee la capa de texto de un PDF.
 *
 * `unpdf` es un pdf.js empaquetado para runtimes serverless (sin canvas ni
 * nada nativo). Falla BLANDO a propósito: si la librería no carga o el PDF la
 * rompe, se devuelve 0 caracteres, el llamador lo trata como escaneo y lo
 * manda a visión. Peor caso: se gastan tokens en un PDF que tenía texto. Que
 * una dependencia se caiga no puede dejar la carga bloqueada.
 */
export async function sondearPdf(bytes: Uint8Array): Promise<SondeoPdf> {
  try {
    const { getDocumentProxy, extractText } = await import("npm:unpdf@0.12.1");
    const pdf = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return { pages: totalPages, textoCapa: String(text ?? "") };
  } catch (err) {
    console.warn("sondearPdf: no se pudo leer la capa de texto —", err);
    return { pages: await contarPaginas(bytes), textoCapa: "" };
  }
}

/** Páginas con pdf-lib, que es también quien luego parte el archivo. */
export async function contarPaginas(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await import("npm:pdf-lib@1.17.1");
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

/**
 * Devuelve un PDF nuevo con las páginas [from, to] (1-indexado, inclusive).
 * Es lo que hace que cada llamada a la API entre en el wall clock, en el tope
 * de páginas y en la ventana de contexto del modelo.
 */
export async function partirPdf(
  bytes: Uint8Array,
  from: number,
  to: number
): Promise<Uint8Array> {
  const { PDFDocument } = await import("npm:pdf-lib@1.17.1");
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  const desde = Math.max(1, from);
  const hasta = Math.min(total, to);
  const indices: number[] = [];
  for (let p = desde; p <= hasta; p++) indices.push(p - 1);
  const out = await PDFDocument.create();
  const paginas = await out.copyPages(src, indices);
  for (const p of paginas) out.addPage(p);
  return await out.save();
}

/** Texto de un DOCX/TXT/MD/SRT/VTT. Los PDF y las imágenes no pasan por acá. */
export async function leerTextoPlano(bytes: Uint8Array, ext: string): Promise<string> {
  if (ext === "docx") {
    const mammoth = (await import("npm:mammoth@1.12.0")).default;
    // mammoth tipa (y espera) un Buffer de Node, no un Uint8Array pelado.
    const { Buffer } = await import("node:buffer");
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return String(result.value ?? "");
  }
  const raw = new TextDecoder("utf-8").decode(bytes);
  if (ext === "srt") {
    return raw
      .replace(/^\d+\s*$/gm, "")
      .replace(/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}.*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  if (ext === "vtt") {
    return raw
      .replace(/^WEBVTT.*$/m, "")
      .replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Transcripción por visión
// ---------------------------------------------------------------------------

const PROMPT_OCR =
  "Transcribe TODO el texto visible de este documento, en orden de lectura. " +
  "Incluye títulos, coberturas, montos, primas, condiciones, exclusiones y datos de contacto tal cual aparecen. " +
  "Las tablas transcríbelas como líneas legibles, manteniendo la relación entre cada concepto y su valor. " +
  "No resumas, no interpretes y no agregues comentarios: SOLO el texto del documento. " +
  "Si el documento no tiene texto legible, responde exactamente: SIN_TEXTO_LEGIBLE";

// Presupuesto de salida. Una tanda de ~10 páginas escaneadas rinde 6-10k
// tokens; 16k deja aire de sobra y mantiene la respuesta lejos del timeout
// HTTP (por eso NO se usa el techo de 64k que tenía la versión anterior: sin
// streaming, un max_tokens así se cuelga antes de contestar).
const MAX_TOKENS_OCR = 16000;

export type VisionResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Transcribe un PDF (o una imagen) por visión. NUNCA lanza.
 */
export async function transcribirPorVision(
  supabase: SupabaseClient,
  bytes: Uint8Array,
  opts: {
    apiKey: string;
    model: string;
    filename?: string;
    mediaType?: string;
    paginas?: number;
    pricingOverrideRaw?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<VisionResult> {
  const mediaType = opts.mediaType ?? "application/pdf";
  const isPdf = mediaType === "application/pdf";
  const maxBytes = isPdf ? VISION_MAX_PDF_BYTES : VISION_MAX_IMAGE_BYTES;
  if (bytes.byteLength > maxBytes) {
    const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return {
      ok: false,
      reason: `${isPdf ? "el PDF" : "la imagen"} pesa ${mb}MB y no se puede leer por imagen (máximo ${maxMb}MB)`,
    };
  }
  const tope = paginasMaximas(opts.model);
  if (isPdf && (opts.paginas ?? 0) > tope) {
    return {
      ok: false,
      reason: `son ${opts.paginas} páginas y ${opts.model} admite ${tope} por lectura`,
    };
  }

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
        max_tokens: MAX_TOKENS_OCR,
        messages: [
          {
            role: "user",
            content: [
              {
                type: isPdf ? "document" : "image",
                source: { type: "base64", media_type: mediaType, data: aBase64(bytes) },
              },
              { type: "text", text: PROMPT_OCR },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `no se pudo contactar el servicio de lectura: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, reason: `el servicio de lectura respondió ${res.status}: ${detail}` };
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // fail-open: el consumo es contabilidad, no puede tumbar la ingesta.
  await recordUsage(supabase, {
    component: "kb_ocr",
    model: opts.model,
    inputTokens: json.usage?.input_tokens ?? null,
    outputTokens: json.usage?.output_tokens ?? null,
    metadata: { filename: opts.filename ?? null, bytes: bytes.byteLength, ...(opts.metadata ?? {}) },
    pricingOverrideRaw: opts.pricingOverrideRaw,
  });

  if (json.stop_reason === "max_tokens") {
    // La tanda es demasiado densa para el presupuesto. Se reporta en vez de
    // indexar media transcripción: el operador puede bajar KB_PAGINAS_POR_TANDA.
    return {
      ok: false,
      reason: "la transcripción quedó cortada por tamaño; reduce las páginas por tanda",
    };
  }
  const text = (json.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  if (!text || text.includes("SIN_TEXTO_LEGIBLE")) {
    return { ok: false, reason: "el documento no tiene texto legible" };
  }
  return { ok: true, text };
}

/** base64 sin reventar la pila con spread sobre arrays grandes. */
function aBase64(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Jueces
// ---------------------------------------------------------------------------

export type Veredicto = "ok" | "duda" | "mal";

async function preguntarJson(
  supabase: SupabaseClient,
  opts: {
    apiKey: string;
    model: string;
    content: unknown;
    component: string;
    metadata: Record<string, unknown>;
    pricingOverrideRaw?: string | null;
  }
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 1500,
        messages: [{ role: "user", content: opts.content }],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    await recordUsage(supabase, {
      component: opts.component,
      model: opts.model,
      inputTokens: json.usage?.input_tokens ?? null,
      outputTokens: json.usage?.output_tokens ?? null,
      metadata: opts.metadata,
      pricingOverrideRaw: opts.pricingOverrideRaw,
    });
    const raw = (json.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return extraerJson(raw);
  } catch {
    return null;
  }
}

/**
 * Saca el primer objeto JSON de una respuesta del modelo.
 *
 * Un `match(/\{[\s\S]*\}/)` NO sirve: es codicioso y agarra desde la primera
 * llave hasta la ÚLTIMA del texto, arrastrando cercas ``` y comentarios del
 * modelo, y reventando el JSON.parse. Se recorre contando llaves, respetando
 * strings y escapes.
 */
export function extraerJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export type ValidacionFidelidad = { veredicto: Veredicto; problemas: string[] };

/**
 * ¿La transcripción es fiel al documento? Solo tiene sentido sobre texto que
 * produjo un modelo, y se corre POR TANDA: el juez compara el sub-PDF de esas
 * páginas contra su propia transcripción, así ve poco material por vez (que es
 * cuando mejor detecta) y un reparo reprocesa una tanda, no el documento.
 *
 * El prompt está ACOTADO a propósito. Un juez que compara palabra por palabra
 * marca "mal" hasta la transcripción correcta (probado: se quejaba de "viento"
 * vs "ventarrón") y entonces nada se puede subir nunca. Solo importa lo que
 * haría que un asesor le diera un dato FALSO a un cliente.
 */
export async function validarFidelidad(
  supabase: SupabaseClient,
  bytes: Uint8Array,
  texto: string,
  opts: {
    apiKey: string;
    model: string;
    mediaType: string;
    filename?: string;
    pricingOverrideRaw?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<ValidacionFidelidad> {
  const isPdf = opts.mediaType === "application/pdf";
  const prompt =
    "Eres control de calidad de una base de conocimiento de seguros. Te doy un documento y una TRANSCRIPCIÓN de él.\n\n" +
    "Detecta SOLO errores que harían que un asesor le diera información FALSA a un cliente:\n" +
    "1. CIFRAS distintas a las del documento (primas, sumas aseguradas, plazos, edades, teléfonos, porcentajes).\n" +
    "2. SECCIONES ENTERAS del documento que no aparecen en la transcripción.\n" +
    "3. DATOS INVENTADOS: coberturas, planes o condiciones que NO están en el documento.\n" +
    "4. Una palabra mal transcrita que CAMBIE EL SIGNIFICADO de una cobertura, beneficio o exclusión.\n" +
    "5. Transcripción cortada a la mitad.\n\n" +
    "IGNORA por completo (NO son problemas): sinónimos que no cambian el sentido, ortografía, tildes, " +
    "formato, orden, saltos de línea, cómo se representa una tabla, y que no se describan logos o iconos.\n\n" +
    'Responde SOLO un JSON: {"veredicto":"ok"|"duda"|"mal","problemas":["..."]}\n' +
    '- "ok": ninguna cifra mal, ninguna sección faltante, nada inventado. problemas: []\n' +
    '- "duda": algo incierto que no pudiste verificar (ej. una fila ilegible en el original).\n' +
    '- "mal": encontraste al menos uno de los 5 puntos de arriba.\n\n' +
    `TRANSCRIPCIÓN A VERIFICAR:\n"""\n${texto.slice(0, 60000)}\n"""`;

  const out = await preguntarJson(supabase, {
    apiKey: opts.apiKey,
    model: opts.model,
    content: [
      {
        type: isPdf ? "document" : "image",
        source: { type: "base64", media_type: opts.mediaType, data: aBase64(bytes) },
      },
      { type: "text", text: prompt },
    ],
    component: "kb_validate_fidelidad",
    metadata: { filename: opts.filename ?? null, ...(opts.metadata ?? {}) },
    pricingOverrideRaw: opts.pricingOverrideRaw,
  });

  if (!out) return { veredicto: "duda", problemas: ["no se pudo verificar la transcripción con el documento"] };
  const v = String(out.veredicto ?? "").toLowerCase();
  const problemas = Array.isArray(out.problemas) ? out.problemas.map(String).filter(Boolean) : [];
  if (v === "ok") return { veredicto: "ok", problemas: [] };
  if (v === "mal") {
    return { veredicto: "mal", problemas: problemas.length ? problemas : ["la transcripción no es fiel al documento"] };
  }
  return { veredicto: "duda", problemas };
}

export type ValidacionVertical = {
  veredicto: Veredicto;
  vertical_sugerida: string | null;
  motivo: string | null;
};

/**
 * ¿El contenido corresponde a la vertical donde se está subiendo? Aplica a
 * TODO documento, venga de donde venga: un tarifario de automóvil dentro de
 * "salud" hace que el agente le cite coberturas de auto a alguien que pregunta
 * por una póliza médica. Es barato (solo texto) y corre una vez, al ensamblar.
 */
export async function validarVertical(
  supabase: SupabaseClient,
  texto: string,
  opts: {
    apiKey: string;
    model: string;
    verticalSlug: string;
    verticalNombre: string;
    verticalDescripcion: string | null;
    otrasVerticales: Array<{ slug: string; description: string | null }>;
    filename?: string;
    pricingOverrideRaw?: string | null;
  }
): Promise<ValidacionVertical> {
  const catalogo = opts.otrasVerticales
    .map((v) => `- ${v.slug}: ${v.description ?? "(sin descripción)"}`)
    .join("\n");
  const prompt =
    "Eres el control de calidad de una base de conocimiento de una aseguradora. " +
    "Cada documento vive dentro de UNA vertical (línea de producto) y el agente SOLO lo consulta cuando la conversación es de esa vertical.\n\n" +
    `VERTICAL DESTINO: ${opts.verticalSlug} — ${opts.verticalNombre}\n` +
    `Descripción: ${opts.verticalDescripcion ?? "(sin descripción)"}\n\n` +
    `OTRAS VERTICALES DISPONIBLES:\n${catalogo}\n\n` +
    "¿El documento corresponde a la vertical destino?\n" +
    'Responde SOLO un JSON: {"veredicto":"ok"|"duda"|"mal","vertical_sugerida":"slug o null","motivo":"una frase"}\n' +
    '- "ok": el contenido es de esa vertical, o es institucional/transversal (aplica a toda la empresa).\n' +
    '- "duda": podría encajar pero no es claro, o cubre varias verticales.\n' +
    '- "mal": es claramente de OTRA vertical (ej. un tarifario de automóvil en la vertical de salud). Indica cuál en vertical_sugerida.\n\n' +
    `DOCUMENTO (primeros caracteres):\n"""\n${texto.slice(0, 6000)}\n"""`;

  const out = await preguntarJson(supabase, {
    apiKey: opts.apiKey,
    model: opts.model,
    content: [{ type: "text", text: prompt }],
    component: "kb_validate_vertical",
    metadata: { filename: opts.filename ?? null, vertical: opts.verticalSlug },
    pricingOverrideRaw: opts.pricingOverrideRaw,
  });

  if (!out) return { veredicto: "duda", vertical_sugerida: null, motivo: "no se pudo verificar la vertical" };
  const v = String(out.veredicto ?? "").toLowerCase();
  const sugerida = out.vertical_sugerida ? String(out.vertical_sugerida) : null;
  const motivo = out.motivo ? String(out.motivo) : null;
  if (v === "ok") return { veredicto: "ok", vertical_sugerida: null, motivo: null };
  if (v === "mal") return { veredicto: "mal", vertical_sugerida: sugerida, motivo };
  return { veredicto: "duda", vertical_sugerida: sugerida, motivo };
}

// ---------------------------------------------------------------------------
// Chunker semántico
// ---------------------------------------------------------------------------

// Tokens por palabra, para traducir el presupuesto en tokens a palabras.
//
// Era 1.3 (razonable para prosa) pero subestima MUCHO en el contenido real de
// esta KB: tablas de tarifas y directorios de clínicas están llenos de siglas,
// nombres propios en mayúsculas, montos y teléfonos, que el tokenizador parte
// en muchos pedazos. Comprobado en producción: con 1.3, cuatro chunks de una
// tabla de proveedores superaron la ventana de 512 tokens de gte-small y el
// modelo solo embebió su prefijo común — embeddings IDÉNTICOS entre chunks
// distintos y la cola del texto invisible para el buscador. 1.8 deja margen.
const TOKENS_PER_WORD = 1.8;

export function chunkText(
  text: string,
  opts: { maxTokens?: number; overlapTokens?: number } = {}
): string[] {
  const maxTokens = opts.maxTokens ?? 400;
  const overlapTokens = opts.overlapTokens ?? 60;
  const wordsPerChunk = Math.floor(maxTokens / TOKENS_PER_WORD);
  const overlapWords = Math.floor(overlapTokens / TOKENS_PER_WORD);
  // El overlap que se arrastra del chunk anterior también ocupa lugar, así que
  // se descuenta: el total (overlap + texto nuevo) nunca pasa de wordsPerChunk.
  const segmentCap = Math.max(1, wordsPerChunk - overlapWords);

  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const p of paragraphs) {
    if (countWords(p) <= segmentCap) { sentences.push(p); continue; }
    for (const part of p.split(/(?<=[.!?])\s+/)) {
      if (countWords(part) <= segmentCap) { sentences.push(part); continue; }
      // Corte DURO por palabras: una tabla o lista sin puntuación es UNA sola
      // "oración" gigante que si no se parte acá pasa entera al chunk (el
      // bucle de abajo solo vacía el buffer, no parte el segmento) — de ahí
      // salían chunks de 600+ palabras.
      const words = part.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += segmentCap) {
        sentences.push(words.slice(i, i + segmentCap).join(" "));
      }
    }
  }

  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferWords = 0;

  const flush = () => {
    const t = buffer.join(" ");
    chunks.push(t);
    // Overlap por PALABRAS, no por segmentos completos: arrastrar la última
    // entrada entera hacía que, si esa entrada ya era del tamaño del tope, el
    // chunk siguiente arrancara lleno y terminara con el DOBLE del tope.
    const words = t.split(/\s+/).filter(Boolean);
    const tail = words.slice(Math.max(0, words.length - overlapWords));
    buffer = tail.length > 0 ? [tail.join(" ")] : [];
    bufferWords = tail.length;
  };

  for (const s of sentences) {
    const w = countWords(s);
    if (bufferWords + w > wordsPerChunk && buffer.length > 0) flush();
    buffer.push(s);
    bufferWords += w;
  }
  if (buffer.length > 0) chunks.push(buffer.join(" "));
  return chunks.filter((c) => c.trim().length > 20);
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

// La Edge Function `embed` acepta hasta 8 inputs por llamada, pero con batch 8
// y concurrencia 4 tiró WORKER_RESOURCE_LIMIT (el modelo ONNX no da abasto).
// 3 y 3 es el punto medio medido: bastante más rápido que uno a la vez sin
// saturarlo.
const EMBED_BATCH = 3;
const EMBED_CONCURRENCY = 3;
const EMBED_MAX_RETRIES = 5;

export async function embedTexts(
  texts: string[],
  opts: { supabaseUrl: string; serviceRole: string }
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    batches.push(texts.slice(i, i + EMBED_BATCH));
  }
  const results: number[][][] = new Array(batches.length);
  let cursor = 0;

  const uno = async (batch: string[], attempt = 1): Promise<number[][]> => {
    try {
      const res = await fetch(`${opts.supabaseUrl}/functions/v1/embed`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.serviceRole}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: batch }),
      });
      if (res.ok) {
        const { embeddings } = (await res.json()) as { embeddings: number[][] };
        return embeddings;
      }
      const body = await res.text();
      const retryable =
        res.status >= 500 ||
        res.status === 429 ||
        body.includes("WORKER_RESOURCE_LIMIT") ||
        body.includes("BOOT_ERROR");
      if (retryable && attempt < EMBED_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** (attempt - 1))));
        return uno(batch, attempt + 1);
      }
      throw new Error(`embed: ${res.status} ${body.slice(0, 200)}`);
    } catch (err) {
      if (attempt < EMBED_MAX_RETRIES && err instanceof Error && err.message.includes("error sending request")) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        return uno(batch, attempt + 1);
      }
      throw err;
    }
  };

  const worker = async () => {
    while (cursor < batches.length) {
      const idx = cursor++;
      results[idx] = await uno(batches[idx]);
      if (cursor < batches.length) await new Promise((r) => setTimeout(r, 150));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(EMBED_CONCURRENCY, batches.length) }, worker)
  );
  return results.flat();
}
