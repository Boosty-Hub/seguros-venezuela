// _shared/provider-errors.test.ts
// Deno test para isCreditError() y esFalloDeCuenta(). Correr con:
//   deno test supabase/functions/_shared/provider-errors.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { esFalloDeCuenta, isCreditError } from "./provider-errors.ts";

Deno.test("anthropic 400 + 'credit balance' → true", () => {
  assertEquals(
    isCreditError("anthropic", 400, JSON.stringify({ error: { message: "Your credit balance is too low to access the Anthropic API." } })),
    true,
  );
});

Deno.test("anthropic 429 (rate limit) → false, aunque el mensaje mencione crédito", () => {
  // 429 es rate limit — un tipo de error completamente distinto. NUNCA debe
  // disparar la detección de crédito agotado, incluso si el body menciona
  // "credit balance" por accidente.
  assertEquals(
    isCreditError("anthropic", 429, JSON.stringify({ error: { message: "credit balance low, rate limited" } })),
    false,
  );
});

Deno.test("anthropic 400 con otro mensaje (no crédito) → false", () => {
  assertEquals(
    isCreditError("anthropic", 400, JSON.stringify({ error: { message: "messages: roles must alternate between \"user\" and \"assistant\"" } })),
    false,
  );
});

Deno.test("openai 429 + 'insufficient_quota' → true", () => {
  assertEquals(
    isCreditError("openai", 429, JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } })),
    true,
  );
});

Deno.test("openai 400 → false, aunque el mensaje mencione insufficient_quota", () => {
  assertEquals(
    isCreditError("openai", 400, JSON.stringify({ error: { message: "insufficient_quota" } })),
    false,
  );
});

// ---------------------------------------------------------------------------
// esFalloDeCuenta: decide si un fallo GASTA un intento de la cola. La usan
// `process-inbound` (mensajes) y `kb-transcribe` (tandas de KB), así que un
// falso negativo acá condena trabajo sano — es la trampa 30.

Deno.test("fallos de cuenta/plataforma → NO gastan intento", () => {
  for (const msg of [
    "Your credit balance is too low to access the Anthropic API.",
    "el servicio de lectura respondió 429: rate_limit_error",
    "el servicio de lectura respondió 529: overloaded_error",
    "el servicio de lectura respondió 500: internal server error",
    "authentication_error: invalid x-api-key",
    "no se pudo contactar el servicio de lectura: fetch failed",
    "request timeout",
  ]) {
    assertEquals(esFalloDeCuenta(msg), true, msg);
  }
});

Deno.test("fallos del documento → SÍ gastan intento", () => {
  for (const msg of [
    "el documento no tiene texto legible",
    "la transcripción quedó cortada por tamaño; reduce las páginas por tanda",
    "el PDF pesa 41.2MB y no se puede leer por imagen (máximo 20MB)",
    "son 140 páginas y claude-haiku-4-5 admite 100 por lectura",
    "la tanda no tiene archivo asociado",
  ]) {
    assertEquals(esFalloDeCuenta(msg), false, msg);
  }
});
