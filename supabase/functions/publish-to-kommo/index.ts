// Edge Function: publish-to-kommo
//
// Toma drafts con status='approved' y los publica a Kommo:
//   1. PATCH /api/v4/leads/{kommo_lead_id} — actualiza el custom field con la respuesta
//   2. POST  /api/v2/salesbot/run — dispara el salesbot que lee el campo y envía al canal
//
// Si publishing_enabled=false en kommo_publish_config, no hace nada (shadow mode).
//
// Soporte de comentarios de Instagram:
//   Si el draft tiene agent_metadata.from_comment=true y agent_metadata.public_reply
//   y comment_reply_enabled=true y están configurados comment_field_id + comment_salesbot_id:
//   - ANTES del flujo normal, escribe la respuesta pública (generada por IA) en
//     comment_field_id y dispara comment_salesbot_id (fail-open: si falla, el DM normal sigue).
//   - El flujo normal (campo normal + salesbot normal) SIEMPRE corre.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { loadConfig } from "../_shared/config.ts";
import { patchLeadField, runSalesbot, fetchLeadStage, KOMMO_WON_STATUS, KOMMO_LOST_STATUS } from "../_shared/kommo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

type KommoConfig = {
  id: string;
  response_custom_field_id: number | null;
  salesbot_id: number | null;
  publishing_enabled: boolean;
  auto_reply_mode: "auto" | "review_only";
  // Línea de corte: nunca publicar drafts anteriores a esta fecha (go-live).
  publish_from: string | null;
  // Comentarios de Instagram
  comment_reply_enabled: boolean;
  comment_salesbot_id: number | null;
  comment_field_id: number | null;
};

async function getConfig(): Promise<KommoConfig | null> {
  const { data, error } = await supabase
    .from("kommo_publish_config")
    .select(
      "id, response_custom_field_id, salesbot_id, publishing_enabled, auto_reply_mode, publish_from, comment_reply_enabled, comment_salesbot_id, comment_field_id"
    )
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`config: ${error.message}`);
  return data;
}

// ---- Selecciona drafts approved no enviados, con info del lead ----
// publishFrom: línea de corte; si está, se ignoran los drafts anteriores
// (borradores de validación viejos que NO deben dispararse al ir a producción).
// Intentos de publicación antes de dar el draft por perdido. El cron reintenta
// uno por ciclo; 3 cubre un error transitorio de Kommo sin insistir para siempre.
const MAX_PUBLISH_ATTEMPTS = 3;

async function pickPending(publishFrom: string | null, limit = 10) {
  let q = supabase
    .from("drafts")
    .select(
      "id, message_id, body, status, agent_metadata, messages!drafts_message_id_fkey(lead_id, leads(kommo_lead_id, display_name))"
    )
    .eq("status", "approved")
    .is("sent_at", null);
  if (publishFrom) q = q.gte("created_at", publishFrom);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(limit);
  if (error) throw new Error(`pick drafts: ${error.message}`);
  return data ?? [];
}

// Cap duro de seguridad en profundidad: 280 chars, cortando en el último espacio.
function capPublicReply(text: string): string {
  const sanitized = text.replace(/[\n\r\t]/g, " ").trim();
  if (sanitized.length <= 280) return sanitized;
  const sub = sanitized.slice(0, 280);
  const lastSpace = sub.lastIndexOf(" ");
  return lastSpace > 0 ? sub.slice(0, lastSpace) : sub;
}

async function publishOne(
  draft: {
    id: string;
    body: string;
    agent_metadata: Record<string, unknown> | null;
    // deno-lint-ignore no-explicit-any
    messages: any;
  },
  config: KommoConfig,
  kommoDomain: string,
  kommoToken: string
) {
  const kommoLeadId = draft.messages?.leads?.kommo_lead_id;
  if (!kommoLeadId) throw new Error("kommo_lead_id missing");
  if (!config.response_custom_field_id) throw new Error("response_custom_field_id no configurado");
  if (!config.salesbot_id) throw new Error("salesbot_id no configurado");

  const leadId = Number(kommoLeadId);
  const meta = draft.agent_metadata ?? {};

  // ---- Respuesta pública IA (comentario de Instagram) — fail-open ----
  // Usa meta.public_reply generado por Haiku en generate-response.
  // Corre ANTES del flujo normal; si falla, el DM normal sigue igual.
  const rawPublicReply = typeof meta.public_reply === "string" ? meta.public_reply : null;
  if (
    meta.from_comment === true &&
    config.comment_reply_enabled &&
    config.comment_salesbot_id != null &&
    config.comment_field_id != null &&
    rawPublicReply
  ) {
    try {
      const publicText = capPublicReply(rawPublicReply);
      await patchLeadField(leadId, config.comment_field_id, publicText, kommoDomain, kommoToken);
      await runSalesbot(config.comment_salesbot_id, leadId, kommoDomain, kommoToken);
    } catch (err) {
      console.warn(
        `publish-to-kommo: respuesta pública comentario (draft ${draft.id}) falló — continúa con DM:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ---- Flujo normal: DM por campo + salesbot estándar ----
  // SIEMPRE corre, independientemente de si la parte pública falló.
  await patchLeadField(leadId, config.response_custom_field_id, draft.body, kommoDomain, kommoToken);
  await runSalesbot(config.salesbot_id, leadId, kommoDomain, kommoToken);
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("publish-to-kommo OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // Resolve config at request time: DB-first, then env fallback.
    const runtimeCfg = await loadConfig(supabase);
    const kommoDomain = runtimeCfg.require("KOMMO_API_DOMAIN");
    const kommoToken = runtimeCfg.require("KOMMO_ACCESS_TOKEN");

    const config = await getConfig();
    if (!config) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "no config" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (!config.publishing_enabled) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "publishing disabled (shadow mode)" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    const pending = await pickPending(config.publish_from);
    if (pending.length === 0) {
      return new Response(JSON.stringify({ ok: true, published: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    let published = 0;
    let failed = 0;
    const errors: Array<{ draft_id: string; error: string }> = [];

    for (const d of pending) {
      // Un body vacío no se publica: mandaría un mensaje en blanco al cliente.
      // Es terminal — reintentar no lo va a llenar.
      if (!String(d.body ?? "").trim()) {
        await supabase
          .from("drafts")
          .update({
            status: "failed",
            agent_metadata: { ...(d.agent_metadata ?? {}), publish_error: "body vacío — no se publica" },
          })
          .eq("id", d.id);
        errors.push({ draft_id: d.id, error: "body vacío" });
        failed++;
        continue;
      }

      try {
        await publishOne(d, config, kommoDomain, kommoToken);
        await supabase
          .from("drafts")
          .update({ status: "auto_sent", sent_at: new Date().toISOString() })
          .eq("id", d.id);
        published++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Kommo devuelve errores TRANSITORIOS (visto en producción: un 400
        // "Not enough rights" en 2 de 128 envíos, con el token intacto y
        // permisos de admin — al reintentar el mismo PATCH a mano dio 200).
        // Antes cualquier fallo dejaba el draft en 'failed' para siempre y
        // NADIE lo reintentaba: el cliente se quedaba sin respuesta y en
        // silencio. Ahora se deja en 'approved' para que el próximo ciclo del
        // cron lo retome, hasta MAX_PUBLISH_ATTEMPTS.
        //
        // Dos motivos NO transitorios que SÍ se vieron en producción gastando
        // los 3 intentos igual (nunca iban a tener éxito, el estado que los
        // causa no cambia solo):
        //   - "Lead not found": el lead ya no existe en Kommo (borrado/fusionado).
        //   - "Not enough rights" con el lead YA en Ganado/Perdido (confirmado:
        //     2 casos reales, ambos con el lead en Perdido/143) — Kommo bloquea
        //     escrituras de custom_fields en leads cerrados para esta integración.
        // En ambos, terminal de una (sin gastar los 3 intentos) con un motivo
        // específico en vez del 400 crudo.
        let terminalReason: string | null = null;
        if (/lead not found/i.test(msg)) {
          terminalReason = "lead_not_found";
        } else if (/not enough rights/i.test(msg)) {
          const kommoLeadId = Number(d.messages?.leads?.kommo_lead_id);
          if (Number.isFinite(kommoLeadId)) {
            try {
              const stage = await fetchLeadStage(kommoLeadId, kommoDomain, kommoToken);
              if (stage.statusId === KOMMO_WON_STATUS || stage.statusId === KOMMO_LOST_STATUS) {
                terminalReason = "lead_closed";
              }
            } catch {
              // No se pudo confirmar la etapa — se trata como transitorio
              // (comportamiento previo: reintentar).
            }
          }
        }

        const prev = (d.agent_metadata ?? {}) as Record<string, unknown>;
        const attempts = Number(prev.publish_attempts ?? 0) + 1;
        const giveUp = terminalReason !== null || attempts >= MAX_PUBLISH_ATTEMPTS;
        await supabase
          .from("drafts")
          .update({
            // OJO: merge, no reemplazo. Antes se pisaba agent_metadata entero
            // y se perdían session_id / tool_calls / model / vertical — o sea
            // la trazabilidad y la atribución de consumo del draft.
            status: giveUp ? "failed" : "approved",
            agent_metadata: {
              ...prev,
              publish_error: terminalReason === "lead_closed"
                ? `lead cerrado (Ganado/Perdido) — Kommo no permite escribirle: ${msg}`
                : msg,
              publish_attempts: attempts,
              ...(terminalReason ? { publish_error_kind: terminalReason } : {}),
            },
          })
          .eq("id", d.id);
        errors.push({
          draft_id: d.id,
          error: `${msg}${giveUp ? (terminalReason ? ` (terminal: ${terminalReason})` : "") : ` (intento ${attempts}, se reintenta)`}`,
        });
        failed++;
      }
    }

    // Después de publicar, disparar evaluación de outcomes (fire-and-forget)
    if (published > 0) {
      const promise = fetch(`${SUPABASE_URL}/functions/v1/evaluate-outcomes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch((e) => console.warn("trigger evaluate-outcomes:", e));
      // @ts-ignore EdgeRuntime de Supabase
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(promise);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, published, failed, errors }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("publish-to-kommo error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
