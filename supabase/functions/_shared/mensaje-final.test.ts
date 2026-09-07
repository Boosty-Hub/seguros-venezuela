// _shared/mensaje-final.test.ts
// Deno test para revisarMensajeFinal(). Correr con:
//   deno test supabase/functions/_shared/mensaje-final.test.ts

import { assertEquals, assert } from "jsr:@std/assert@^1.0.0";
import { revisarMensajeFinal } from "./mensaje-final.ts";

// ---- Los CINCO casos REALES que se publicaron al cliente ----
// Los 5 rechazos que salieron del barrido de los 259 drafts con body.

Deno.test("caso real 2026-09-03 (lead 15742404) → fuga", () => {
  const r = revisarMensajeFinal("Memoria actualizada. Respuesta enviada al lead.");
  assert(r, "tiene que rechazarse");
  assertEquals(r.tipo, "fuga");
});

Deno.test("caso real 2026-08-20 (lead 13168640) → fuga", () => {
  // El ✓ ya lo quita sanitizeEmojiForKommo; se prueba el texto tal como llega.
  const r = revisarMensajeFinal("Respuesta enviada y memoria actualizada.");
  assert(r, "tiene que rechazarse");
  assertEquals(r.tipo, "fuga");
});

Deno.test("caso real 2026-08-24 (mención en un story) → silencio, no fuga", () => {
  const r = revisarMensajeFinal(
    "**Análisis conclusivo**:\n\nEl mensaje del sistema es una notificación de que EBS VENEZUELA mencionó a Asesora Sofi en un story de Instagram. Revisé la memoria y veo que ya respondí ayer a exactamente lo mismo."
  );
  assert(r, "tiene que rechazarse");
  // Clave: NO se le pide reescribir. Callar ya era la decisión correcta.
  assertEquals(r.tipo, "silencio");
});

Deno.test("caso real 2026-08-25 (reels como interacción social) → silencio", () => {
  const r = revisarMensajeFinal(
    "---\n\n**Sin respuesta automática.**\n\nEl lead está compartiendo reels de Seguros Venezuela como interacción social sin pregunta explícita."
  );
  assert(r);
  assertEquals(r.tipo, "silencio");
});

Deno.test("caso real 2026-09-03 15:33 (notificación de Instagram) → silencio", () => {
  const r = revisarMensajeFinal(
    'No hay respuesta que enviar en este caso.\n\nEl mensaje "Mentioned you in their story" es una **notificación automática de Instagram**, no una consulta real del lead.'
  );
  assert(r);
  assertEquals(r.tipo, "silencio");
});

// ---- Otras fugas internas ----

Deno.test("rutas de la memoria → rechazado", () => {
  assert(revisarMensajeFinal("Ya escribí el turno en conversation.md"));
  assert(revisarMensajeFinal("Guardé el dato en /mnt/memory/sv-leads/abc/learnings.md"));
});

Deno.test("nombre de tool interna → rechazado", () => {
  assert(revisarMensajeFinal("Voy a usar search_kb para confirmarte el precio."));
  assert(revisarMensajeFinal("Listo, llamé a mover_etapa y ya quedaste con un asesor."));
});

Deno.test("etiquetas del formato interno → rechazado", () => {
  assert(revisarMensajeFinal("<respuesta>Hola, ¿en qué te ayudo?</respuesta>"));
  assert(revisarMensajeFinal("[CONTEXTO] Hola, ¿en qué te ayudo?"));
});

Deno.test("hablar del cliente en tercera persona → rechazado", () => {
  assert(revisarMensajeFinal("El lead pregunta por el plan Oro, le explico las coberturas."));
});

Deno.test("mencionar las instrucciones internas → rechazado", () => {
  assert(revisarMensajeFinal("Según mi system prompt no puedo darte ese dato."));
});

Deno.test("el motivo y el fragmento vienen poblados (van de vuelta al agente)", () => {
  const r = revisarMensajeFinal("Memoria actualizada. Respuesta enviada al lead.");
  assert(r);
  assert(r.motivo.length > 10, "el motivo se le muestra al agente");
  assertEquals(r.fragmento.toLowerCase(), "memoria actualizada");
});

Deno.test("un silencio con 'el lead' se clasifica como silencio, no como fuga", () => {
  // Los silencios reales casi siempre traen también un "el lead". El orden de
  // evaluación importa: clasificarlo como fuga lo mandaría a reescribir.
  const r = revisarMensajeFinal("Sin respuesta automática. El lead solo mandó un emoji.");
  assert(r);
  assertEquals(r.tipo, "silencio");
});

// ---- Mensajes LEGÍTIMOS: ninguno puede rechazarse ----
// Sacados de respuestas reales del agente en producción. Un falso positivo acá
// manda a revisión humana un mensaje que estaba perfecto.

Deno.test("respuestas legítimas → aceptadas", () => {
  const buenos = [
    "Perfecto, solo tu bulldog. Tenemos planes desde $47 anuales: Bronce ($47, consulta y telemedicina), Plata ($106, más coberturas), Oro ($116, amplio). ¿Cuál te interesa o quieres detalles de qué cubre cada uno?",
    "Andrea, entiendo tu molestia y tienes toda la razón en reclamar. Escríbele a servicio.cliente@segurosvenezuela.com con tu cédula y número de póliza para que quede formalmente registrado y le den seguimiento. Ya pasé tu caso al equipo de reclamos.",
    "Claro que sí. Pásame tu nombre completo, fecha de nacimiento, cédula y correo y te armo la cotización.",
    "Ya un asesor tiene tu caso y te dará seguimiento. El call center es 0501 SV INFORMA (784-63-67), de lunes a sábado de 09:00 a 20:00.",
    "Buenos días. Sí, cubrimos maternidad después de 10 meses de póliza activa. ¿La cobertura es solo para ti?",
    "Gracias por escribirnos. ¿Buscas cobertura para ti sola o para tu grupo familiar?",
    // "actualizar" en su sentido normal, sin ser la memoria del agente.
    "Para actualizar los datos de tu póliza escríbele a servicio.cliente@segurosvenezuela.com con tu cédula.",
    // "enviar" en su sentido normal.
    "¿Prefieres enviar los datos por aquí?",
  ];
  for (const t of buenos) {
    assertEquals(revisarMensajeFinal(t), null, `falso positivo en: ${t.slice(0, 60)}…`);
  }
});

Deno.test("vacío → null (tiene su propio tratamiento, no es una fuga)", () => {
  assertEquals(revisarMensajeFinal(""), null);
  assertEquals(revisarMensajeFinal("   \n "), null);
  assertEquals(revisarMensajeFinal(null), null);
  assertEquals(revisarMensajeFinal(undefined), null);
});
