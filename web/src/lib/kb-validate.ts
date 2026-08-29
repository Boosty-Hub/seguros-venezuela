// server-only: valida que lo que se va a indexar en la KB sea CORRECTO antes
// de que entre a una vertical.
//
// Por qué existe: la extracción puede fallar de formas que ninguna heurística
// ve. Un PDF escaneado puede transcribirse "plausible pero mal" (un precio
// cambiado, una tabla omitida), y un documento perfectamente transcrito puede
// ir a la vertical equivocada — un tarifario de automóvil dentro de "salud"
// hace que el agente le cite coberturas de auto a alguien que pregunta por
// una póliza médica. En ambos casos la KB queda envenenada en silencio.
//
// Dos jueces, cada uno con su alcance:
//   - fidelidad: SOLO cuando el texto vino de visión (ahí sí puede inventar).
//     Compara el documento ORIGINAL contra el texto extraído.
//   - vertical: SIEMPRE. Es barato (solo texto) y aplica hasta al markdown
//     pegado a mano.
//
// Ninguno lanza: ante un fallo del servicio devuelven "no se pudo verificar",
// y el llamador decide (acá: mandar a confirmación humana en vez de bloquear,
// para no trabar la carga por una caída del proveedor).

import { recordWebUsage } from "@/lib/usage";
import { transcribePdfWithVision } from "@/lib/kb-vision";

export type Veredicto = "ok" | "duda" | "mal";

export type ValidacionFidelidad = {
  veredicto: Veredicto;
  problemas: string[];
};

export type ValidacionVertical = {
  veredicto: Veredicto;
  vertical_sugerida: string | null;
  motivo: string | null;
};

type Msg = { role: "user"; content: unknown };

async function askJson(
  apiKey: string,
  model: string,
  messages: Msg[],
  component: string,
  metadata: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 1500, messages }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    await recordWebUsage({
      component,
      model,
      usage: { promptTokens: json.usage?.input_tokens, completionTokens: json.usage?.output_tokens },
      metadata,
    });
    const raw = (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    return extraerJson(raw);
  } catch {
    return null;
  }
}

/**
 * Saca el primer objeto JSON de una respuesta del modelo.
 *
 * Un `match(/\{[\s\S]*\}/)` NO sirve acá: es codicioso y agarra desde la
 * primera llave hasta la ÚLTIMA del texto, arrastrando lo que venga después
 * (cercas ```, comentarios del modelo) y reventando el JSON.parse — pasó en
 * pruebas. Se recorre contando llaves, respetando strings y escapes, y se
 * corta en la llave que cierra el primer objeto.
 */
export function extraerJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
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

/**
 * ¿El texto extraído es fiel y completo respecto del documento original?
 * Solo tiene sentido para texto obtenido por visión.
 */
export async function validarFidelidad(
  buffer: ArrayBuffer,
  texto: string,
  opts: { apiKey: string; model: string; mediaType: string; filename?: string }
): Promise<ValidacionFidelidad> {
  const isPdf = opts.mediaType === "application/pdf";
  // Prompt ACOTADO a propósito. Un juez que compara palabra por palabra marca
  // "mal" hasta la transcripción correcta (probado: se quejaba de "viento" vs
  // "ventarrón") y entonces nada se puede subir nunca. Solo importa lo que
  // haría que un asesor le diera un dato FALSO a un cliente.
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

  const out = await askJson(
    opts.apiKey,
    opts.model,
    [
      {
        role: "user",
        content: [
          {
            type: isPdf ? "document" : "image",
            source: { type: "base64", media_type: opts.mediaType, data: Buffer.from(buffer).toString("base64") },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    "kb_validate_fidelidad",
    { filename: opts.filename ?? null }
  );

  if (!out) return { veredicto: "duda", problemas: ["no se pudo verificar la transcripción con el documento"] };
  const v = String(out.veredicto ?? "").toLowerCase();
  const problemas = Array.isArray(out.problemas) ? out.problemas.map(String).filter(Boolean) : [];
  if (v === "ok") return { veredicto: "ok", problemas: [] };
  if (v === "mal") return { veredicto: "mal", problemas: problemas.length ? problemas : ["la transcripción no es fiel al documento"] };
  return { veredicto: "duda", problemas };
}

/**
 * ¿El contenido corresponde a la vertical donde se está subiendo?
 * Aplica a TODO documento, venga de donde venga.
 */
export async function validarVertical(
  texto: string,
  opts: {
    apiKey: string;
    model: string;
    verticalSlug: string;
    verticalNombre: string;
    verticalDescripcion: string | null;
    otrasVerticales: Array<{ slug: string; description: string | null }>;
    filename?: string;
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

  const out = await askJson(
    opts.apiKey,
    opts.model,
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    "kb_validate_vertical",
    { filename: opts.filename ?? null, vertical: opts.verticalSlug }
  );

  if (!out) return { veredicto: "duda", vertical_sugerida: null, motivo: "no se pudo verificar la vertical" };
  const v = String(out.veredicto ?? "").toLowerCase();
  const sugerida = out.vertical_sugerida ? String(out.vertical_sugerida) : null;
  const motivo = out.motivo ? String(out.motivo) : null;
  if (v === "ok") return { veredicto: "ok", vertical_sugerida: null, motivo: null };
  if (v === "mal") return { veredicto: "mal", vertical_sugerida: sugerida, motivo };
  return { veredicto: "duda", vertical_sugerida: sugerida, motivo };
}

/**
 * Transcribe un documento por visión y VERIFICA el resultado antes de
 * devolverlo. Si la verificación lo rechaza, REPROCESA con un modelo más
 * capaz y vuelve a verificar.
 *
 * Por qué el reproceso vale la pena: la transcripción no es determinista. En
 * pruebas reales sobre el mismo flyer, el modelo barato leyó "Remodelación y
 * limpieza de escombros" donde el documento dice "Remoción" (cambia el
 * beneficio) y "deficiencias" donde dice "afectaciones" (cambia el criterio de
 * exclusión). El juez lo detectó, el reproceso con el modelo capaz salió
 * limpio y el documento entró solo, sin molestar al operador.
 *
 * Devuelve `dudas` no vacío cuando quedó algo sin resolver: el llamador debe
 * mandarlo a revisión humana en vez de indexarlo a ciegas.
 */
export async function transcribirYVerificar(
  buffer: ArrayBuffer,
  opts: {
    apiKey: string;
    ocrModel: string;
    judgeModel: string;
    mediaType: string;
    filename?: string;
  }
): Promise<{ ok: true; text: string; dudas: string[]; reprocesado: boolean } | { ok: false; reason: string }> {
  // Intento 1: modelo barato.
  const primero = await transcribePdfWithVision(buffer, {
    apiKey: opts.apiKey,
    model: opts.ocrModel,
    filename: opts.filename,
    mediaType: opts.mediaType,
  });
  if (!primero.ok) return primero;

  const v1 = await validarFidelidad(buffer, primero.text, {
    apiKey: opts.apiKey,
    model: opts.judgeModel,
    mediaType: opts.mediaType,
    filename: opts.filename,
  });
  if (v1.veredicto === "ok") return { ok: true, text: primero.text, dudas: [], reprocesado: false };

  // Intento 2 (reproceso): el modelo capaz vuelve a leer el documento desde
  // cero. No se "corrige" el texto anterior a propósito — arrastraría sus
  // errores.
  const segundo = await transcribePdfWithVision(buffer, {
    apiKey: opts.apiKey,
    model: opts.judgeModel,
    filename: opts.filename,
    mediaType: opts.mediaType,
  });
  if (!segundo.ok) {
    // El reproceso falló: queda lo del primer intento, con sus reparos.
    return { ok: true, text: primero.text, dudas: v1.problemas, reprocesado: true };
  }

  const v2 = await validarFidelidad(buffer, segundo.text, {
    apiKey: opts.apiKey,
    model: opts.judgeModel,
    mediaType: opts.mediaType,
    filename: opts.filename,
  });
  if (v2.veredicto === "ok") return { ok: true, text: segundo.text, dudas: [], reprocesado: true };

  // Sigue sin pasar limpio: se devuelve la MEJOR versión (la del modelo capaz)
  // con los reparos, para que un humano decida.
  return { ok: true, text: segundo.text, dudas: v2.problemas, reprocesado: true };
}
