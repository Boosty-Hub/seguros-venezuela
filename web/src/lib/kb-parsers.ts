// Parsers para documentos de KB: PDF, DOCX, TXT, MD, SRT, VTT.

import mammoth from "mammoth";
import { PDF_WORKER_DATA_URL } from "./pdf-worker-data-url";

export type ParsedDocument = {
  text: string;
  format: "pdf" | "docx" | "txt" | "md" | "srt" | "vtt";
};

// pdf-parse (pdfjs-dist por debajo) espera `DOMMatrix` global para las
// transformaciones de texto — existe en navegadores pero NO en el runtime
// Node/Lambda de Netlify (confirmado en producción: "DOMMatrix is not
// defined", 100% de los PDFs fallaban). Local funcionaba porque Next.js
// bundlea distinto en dev; en Netlify Functions el global no existe. Polyfill
// afín (2D, suficiente para extracción de texto — no se necesita 3D/CSS).
function ensureDomMatrixPolyfill(): void {
  const g = globalThis as unknown as { DOMMatrix?: unknown };
  if (g.DOMMatrix) return;
  class DOMMatrixPolyfill {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(init?: number[]) {
      if (Array.isArray(init) && init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    }
    multiply(other: DOMMatrixPolyfill): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([
        this.a * other.a + this.c * other.b,
        this.b * other.a + this.d * other.b,
        this.a * other.c + this.c * other.d,
        this.b * other.c + this.d * other.d,
        this.a * other.e + this.c * other.f + this.e,
        this.b * other.e + this.d * other.f + this.f,
      ]);
    }
    translate(tx: number, ty: number): DOMMatrixPolyfill {
      return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, tx, ty]));
    }
    scale(sx: number, sy: number = sx): DOMMatrixPolyfill {
      return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
    }
    invertSelf(): DOMMatrixPolyfill {
      const det = this.a * this.d - this.b * this.c;
      const a = this.d / det, b = -this.b / det, c = -this.c / det, d = this.a / det;
      const e = -(a * this.e + c * this.f), f = -(b * this.e + d * this.f);
      this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
      return this;
    }
    transformPoint(point: { x: number; y: number }): { x: number; y: number } {
      return { x: this.a * point.x + this.c * point.y + this.e, y: this.b * point.x + this.d * point.y + this.f };
    }
  }
  g.DOMMatrix = DOMMatrixPolyfill;
}

export async function parseDocument(
  buffer: ArrayBuffer,
  filename: string
): Promise<ParsedDocument> {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".pdf")) {
    ensureDomMatrixPolyfill();
    const { PDFParse } = await import("pdf-parse");
    // pdfjs-dist calcula el path de su worker en runtime relativo al chunk
    // bundleado (no es un import estático) — el file tracing de Next.js no lo
    // detecta solo, así que el .mjs quedaba fuera del bundle serverless de
    // Netlify y esto fallaba con "Cannot find module .../pdf.worker.mjs" en
    // TODO PDF (confirmado en vivo). Usamos el worker embebido como data: URL
    // (pdf-worker-data-url.ts) — self-contained, sin depender de ningún
    // archivo externo que un bundler pueda dejar afuera.
    PDFParse.setWorker(PDF_WORKER_DATA_URL);
    const parser = new PDFParse({ data: Buffer.from(buffer) });
    const result = await parser.getText();
    return { text: result.text, format: "pdf" };
  }

  if (lower.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    return { text: result.value, format: "docx" };
  }

  // Texto plano: utf-8
  const raw = new TextDecoder("utf-8").decode(buffer);

  if (lower.endsWith(".srt")) {
    return { text: stripSrt(raw), format: "srt" };
  }
  if (lower.endsWith(".vtt")) {
    return { text: stripVtt(raw), format: "vtt" };
  }
  if (lower.endsWith(".md")) {
    return { text: raw, format: "md" };
  }
  return { text: raw, format: "txt" };
}

function stripSrt(raw: string): string {
  return raw
    .replace(/^\d+\s*$/gm, "") // números de subtítulo
    .replace(/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripVtt(raw: string): string {
  return raw
    .replace(/^WEBVTT.*$/m, "")
    .replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Tokens por palabra, para traducir el presupuesto en tokens a palabras.
//
// Era 1.3 (razonable para prosa) pero subestima MUCHO en el contenido real de
// esta KB: tablas de tarifas y directorios de clínicas están llenos de siglas,
// nombres propios en mayúsculas, montos y teléfonos, que el tokenizador parte
// en muchos pedazos. Comprobado en producción: con 1.3, cuatro chunks de una
// tabla de proveedores quedaron tan largos que superaron la ventana de 512
// tokens de gte-small y el modelo solo embebió su prefijo común — resultado:
// embeddings IDÉNTICOS entre chunks distintos (indistinguibles en la búsqueda)
// y la cola del texto invisible para el buscador. 1.8 deja margen real.
const TOKENS_PER_WORD = 1.8;

// Chunker simple para KB: por palabras, con overlap
export function chunkText(
  text: string,
  opts: { maxTokens?: number; overlapTokens?: number } = {}
): string[] {
  const maxTokens = opts.maxTokens ?? 400;
  const overlapTokens = opts.overlapTokens ?? 60;
  const wordsPerChunk = Math.floor(maxTokens / TOKENS_PER_WORD);
  const overlapWords = Math.floor(overlapTokens / TOKENS_PER_WORD);
  // Presupuesto para el texto NUEVO de cada chunk: el overlap que se arrastra
  // del anterior también ocupa lugar, así que se descuenta. Así el total
  // (overlap + texto nuevo) nunca pasa de wordsPerChunk.
  const segmentCap = Math.max(1, wordsPerChunk - overlapWords);

  // Primero partir por párrafos. Si un párrafo es demasiado grande, partir por oraciones.
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const p of paragraphs) {
    if (countWords(p) <= segmentCap) {
      sentences.push(p);
      continue;
    }
    // Split por oraciones aproximadas
    for (const part of p.split(/(?<=[.!?])\s+/)) {
      if (countWords(part) <= segmentCap) {
        sentences.push(part);
        continue;
      }
      // Corte DURO por palabras: una tabla o lista sin puntuación es UNA sola
      // "oración" gigante que antes pasaba entera al chunk (el bucle de abajo
      // solo vacía el buffer, no parte el segmento) — de ahí salían chunks de
      // 600+ palabras. Sin esto, el tope de tamaño no se respeta nunca.
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
    const text = buffer.join(" ");
    chunks.push(text);
    // Overlap por PALABRAS, no por segmentos completos: antes arrastraba la
    // última entrada entera, así que si esa entrada ya era del tamaño del tope,
    // el chunk siguiente arrancaba lleno y terminaba con el DOBLE del tope
    // (comprobado: chunks de 410 palabras con tope 250). Cortar por palabras
    // acota el arrastre a overlapWords y hace que el tope se respete siempre.
    const words = text.split(/\s+/).filter(Boolean);
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
