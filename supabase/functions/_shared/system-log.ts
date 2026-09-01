// _shared/system-log.ts
// Bitácora propia (tabla `system_logs`, migración 0069) para los puntos que
// ya causaron incidentes reales sin rastro — el webhook de Kommo apagándose
// en silencio, la transcripción de audio fallando con un motivo genérico —
// y que los logs nativos de Supabase (retención corta) no cubren.
//
// Fail-soft a propósito: un fallo al escribir el log NUNCA debe tumbar la
// función que lo llama.
//
// Uso:
//   import { logEvent } from "../_shared/system-log.ts";
//   await logEvent(supabase, "kommo-webhook", "error", "insert falló", { detail });

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type LogLevel = "debug" | "info" | "warn" | "error";

export async function logEvent(
  supabase: SupabaseClient,
  functionName: string,
  level: LogLevel,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await (supabase as any).from("system_logs").insert({
      function_name: functionName,
      level,
      message: message.slice(0, 2000),
      metadata: metadata ?? {},
    });
    if (error) console.warn("system_logs insert falló:", error.message);
  } catch (err) {
    console.warn("system_logs insert falló:", err instanceof Error ? err.message : String(err));
  }
}
