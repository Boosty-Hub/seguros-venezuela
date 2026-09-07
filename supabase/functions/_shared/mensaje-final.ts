// Validador del MENSAJE FINAL antes de enviarlo al cliente.
//
// El agente escribe dos cosas en la misma sesión: su razonamiento/trabajo
// interno (leer memoria, llamar tools, escribir conversation.md) y el mensaje
// que el cliente debe leer, que va dentro de <respuesta>...</respuesta>. Cuando
// esa frontera se rompe, lo interno sale al canal.
//
// Pasó CINCO veces en producción, las cinco publicadas al cliente real (barrido
// de los 259 drafts con body, 2026-08-20 → 2026-09-07). Son dos clases:
//
//   FUGA — el acuse interno de haber terminado salió como mensaje:
//     - 2026-08-20, lead 13168640: "✓ Respuesta enviada y memoria actualizada."
//     - 2026-09-03, lead 15742404: "Memoria actualizada. Respuesta enviada al lead."
//   SILENCIO — el agente decidió NO responder y publicó su deliberación:
//     - 2026-08-24: "**Análisis conclusivo**: El mensaje del sistema es una
//       notificación de que EBS VENEZUELA mencionó a Asesora Sofi en un story…"
//     - 2026-08-25: "**Sin respuesta automática.** El lead está compartiendo
//       reels como interacción social sin pregunta explícita…"
//     - 2026-09-03: "No hay respuesta que enviar en este caso. El mensaje
//       'Mentioned you in their story' es una notificación automática…"
//
// En los dos primeros el agente SÍ había redactado antes el mensaje bueno; el
// último `agent.message` de la sesión era su acuse interno y venía sin
// etiquetas, así que el fallback "usa el último texto" lo tomó como la
// respuesta. Ver la corrección del acumulador en generate-response.
//
// La distinción entre las dos clases importa porque el remedio es opuesto: una
// FUGA se le devuelve al agente para que REHAGA el mensaje; un SILENCIO ya es
// la decisión correcta (una mención en un story no se contesta) y lo que
// corresponde es no enviar nada — pedirle que reescriba lo empujaría a
// inventar un mensaje que él mismo concluyó que no hacía falta.
//
// Este módulo es la reja: se usa en dos puntos independientes.
//   1) generate-response, al cerrar el turno del agente — la FUGA se le
//      DEVUELVE al agente en la misma sesión para que rehaga el mensaje.
//   2) publish-to-kommo, justo antes del PATCH a Kommo — última reja, cubre
//      también los drafts que aprobó un humano y cualquier futuro productor.
//
// Sesgo deliberado: solo patrones INEQUÍVOCAMENTE internos. Un falso positivo
// manda el mensaje a revisión humana (visible y recuperable); un falso negativo
// se lo publica al cliente. Pero la cola de revisión ya se limpió una vez por
// exceso de ruido, así que nada de heurísticas de estilo acá: esto detecta
// FUGAS, no defectos de redacción. Medido contra los 259 drafts reales: 5
// rechazos, los 5 verdaderos, 0 falsos positivos en los 254 restantes.

export type RechazoMensaje = {
  /**
   * `fuga`: se le escapó trabajo interno → el agente rehace el mensaje.
   * `silencio`: decidió no responder → no se envía nada, no se rehace.
   */
  tipo: "fuga" | "silencio";
  /** Por qué se rechaza, redactado para devolvérselo al agente. */
  motivo: string;
  /** El fragmento exacto que disparó el rechazo (para el log y para el agente). */
  fragmento: string;
};

// Se evalúan ANTES que las fugas: casi siempre traen también un "el lead", y de
// clasificarse como fuga se le pediría reescribir algo que no hay que enviar.
const SILENCIOS: Array<{ re: RegExp; motivo: string }> = [
  {
    re: /sin\s+respuesta\s+autom[áa]tica|no\s+hay\s+respuesta\s+que\s+enviar|no\s+(?:requiere|amerita|necesita|corresponde)\s+respuesta|no\s+(?:voy\s+a\s+|hace\s+falta\s+)?responder\s+(?:nada|este\s+mensaje)|an[áa]lisis\s+conclusivo/i,
    motivo: "es tu deliberación de no responder, no un mensaje para el cliente",
  },
];

const FUGAS: Array<{ re: RegExp; motivo: string }> = [
  {
    // "Memoria actualizada.", "Ya actualicé la memoria del lead"
    re: /memoria\s+(?:del\s+lead\s+)?actualizada|actualic[ée]\s+(?:la\s+)?memoria|actualizando\s+(?:la\s+)?memoria|memory\s*store/i,
    motivo: "reporta tu trabajo interno con la memoria en vez de hablarle al cliente",
  },
  {
    // "Respuesta enviada al lead.", "Mensaje enviado al cliente"
    re: /respuesta\s+(?:ya\s+)?enviada|mensaje\s+enviado\s+al\s+(?:lead|cliente)|respond[ií]\s+al\s+(?:lead|cliente)/i,
    motivo: "narra que ya enviaste la respuesta, y eso es una nota interna, no el mensaje",
  },
  {
    // Hablar del destinatario en tercera persona: el mensaje va dirigido A él.
    re: /\b(?:el|al|del)\s+lead\b|\blead_id\b/i,
    motivo: 'habla del cliente en tercera persona ("el lead"), pero el mensaje va dirigido a él',
  },
  {
    re: /conversation\.md|learnings\.md|\/mnt\/memory|\/dreams/i,
    motivo: "menciona rutas de archivos internos",
  },
  {
    // Nombres de tools: todos llevan guion bajo, no colisionan con lenguaje natural.
    re: /\b(?:search_kb|mover_etapa|marcar_perdido|actualizar_lead|actualizar_contacto|enviar_imagen|agregar_nota|etiquetar_lead|transferir_asesor|tasa_bcv|buscar_producto|ver_categorias|consultar_pedido|crear_link_pago)\b/i,
    motivo: "menciona el nombre de una tool interna",
  },
  {
    re: /<\/?respuesta>|<\/?accion>|<\/?variables>|\[CONTEXTO\]|\[MENSAJE DEL LEAD\]|\[MENSAJES DEL LEAD/i,
    motivo: "trae etiquetas del formato interno en vez de solo el texto",
  },
  {
    re: /system\s*prompt|aprendizajes_del_operador|instrucciones_de_la_vertical|requires_human_review/i,
    motivo: "menciona tus instrucciones internas",
  },
];

/**
 * ¿Este texto es un mensaje para el cliente, o se le escapó algo interno?
 *
 * Devuelve `null` cuando el mensaje está bien. Un texto vacío también devuelve
 * `null` a propósito: "vacío" no es una fuga y tiene su propio tratamiento
 * (ante un "Ok, gracias" que cierra la conversación, callar es lo correcto —
 * ver `esCierreOAcuse` en generate-response).
 */
export function revisarMensajeFinal(texto: string | null | undefined): RechazoMensaje | null {
  const t = String(texto ?? "");
  if (!t.trim()) return null;
  for (const { re, motivo } of SILENCIOS) {
    const m = t.match(re);
    if (m) return { tipo: "silencio", motivo, fragmento: m[0] };
  }
  for (const { re, motivo } of FUGAS) {
    const m = t.match(re);
    if (m) return { tipo: "fuga", motivo, fragmento: m[0] };
  }
  return null;
}

/**
 * El mensaje que se le devuelve al agente para que REHAGA la respuesta, en la
 * misma sesión (ya tiene todo el contexto y el trabajo interno hecho). Solo
 * aplica a `tipo: "fuga"` — un `silencio` no se rehace, se respeta.
 */
export function promptDeCorreccion(r: RechazoMensaje): string {
  return `[MENSAJE RECHAZADO — NO se envió al cliente]

El texto que pusiste dentro de <respuesta> no es un mensaje para el cliente: ${r.motivo}. Fragmento detectado: "${r.fragmento}".

El trabajo interno que ya hiciste (memoria, tools, búsquedas) está bien y no hay que repetirlo — el cliente no lo ve y no se le menciona. Vuelve a redactar SOLO el texto que el cliente debe leer, con la voz y el largo de tu system prompt, y devuélvelo dentro de <respuesta>...</respuesta> como único contenido del bloque.`;
}
