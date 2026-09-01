import { configValues } from "@/lib/runtime-config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getShopifyStatus } from "@/lib/shopify";
import { retrieveAgent } from "@/lib/anthropic-managed";
import { Badge, PageShell, SectionCard } from "@/components/ui";
import { AgentForm } from "./agent-form";
import { AgentTabs } from "./agent-tabs";
import { AgentPublishPanel, type PublishState, type ReviewMode } from "./agent-publish-panel";
import type { Rule, VerticalLite } from "./filters-panel";
import type { CommentsConfig } from "./comments-panel";
import { KommoBody } from "../config/kommo/kommo-body";
import { ToolsBody } from "../tools/tools-body";
import { SeguimientoBody } from "../seguimiento/seguimiento-body";
import { SettingsBody } from "../settings/settings-body";

export const dynamic = "force-dynamic";

// "Configuración" unificada: Identidad/Comportamiento/Acciones (del agente) +
// Kommo + Herramientas + Seguimiento + Ajustes, todo en una sola pestaña de
// nivel superior (ver agent-tabs.tsx). Usuarios queda AFUERA a propósito
// (nav.tsx la deja como su propio ítem).
export default async function AgentPage({
  searchParams,
}: {
  searchParams: {
    saved?: string;
    sync?: string;
    error?: string;
    tab?: string;
    kommo_saved?: string;
    asub?: string;
  };
}) {
  const cfg = await configValues([
    "OPERATOR_NAME",
    "AGENT_NAME",
    "NEXT_PUBLIC_AGENT_LABEL",
    "ANTHROPIC_AGENT_ID",
    "ANTHROPIC_AGENT_VERSION",
    "BCV_RATE_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ]);

  // System prompt COMPLETO tal cual vive HOY en Anthropic (operatorPrompt +
  // CORE_SCAFFOLD + tools ya sustituidos) — se lee EN VIVO del agente real, no
  // se recompone localmente, para que sea la fuente de verdad exacta de "qué
  // hay dentro de Anthropic" y nunca pueda desincronizarse de lo editable de
  // arriba. Fail-soft: si el fetch falla, se muestra el aviso en vez de tirar
  // la página entera.
  let liveSystemPrompt: string | null = null;
  let liveSystemPromptError: string | null = null;
  if (cfg.ANTHROPIC_AGENT_ID && cfg.ANTHROPIC_API_KEY) {
    try {
      const liveAgent = await retrieveAgent(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_AGENT_ID);
      const sys = (liveAgent as unknown as { system?: unknown }).system;
      liveSystemPrompt = typeof sys === "string" ? sys : null;
    } catch (e) {
      liveSystemPromptError = e instanceof Error ? e.message : String(e);
    }
  }

  const supabase = createSupabaseServerClient();
  const [rulesRes, pubRes, vertRes, seenRes, shopifyStatus, fuRes] = await Promise.all([
    supabase
      .from("agent_skip_rules")
      .select("id, pattern, match_type, case_sensitive, enabled, description")
      .order("created_at", { ascending: true }),
    supabase
      .from("kommo_publish_config")
      .select(
        "response_cooldown_seconds, max_responses_per_lead, cooldown_window_hours, ignored_channels, ignored_stage_ids, response_debounce_seconds, answer_max_age_hours, respond_to_images, respond_to_documents, respond_to_audio, agent_off_field_id, agent_off_field_name, crm_actions_enabled, crm_can_move_stage, crm_can_update_lead, crm_can_update_contact, crm_can_send_image, shopify_actions_enabled, shopify_can_search, shopify_can_orders, shopify_can_checkout, bcv_rate_enabled, respond_to_comments, comment_reply_enabled, comment_salesbot_id, comment_field_id, comment_reply_rules, comment_instructions, comment_source_ids, agent_enabled, publishing_enabled, bypass_review, auto_reply_mode"
      )
      .eq("is_active", true)
      .maybeSingle(),
    supabase.from("verticals").select("id, slug, name, ignore").order("slug"),
    // Canales realmente vistos en mensajes (para mostrarlos como opciones).
    supabase.from("messages").select("source").not("source", "is", null).limit(1000),
    getShopifyStatus(),
    // Horario laboral (single source of truth compartida con Seguimiento).
    supabase
      .from("follow_up_config")
      .select("timezone, business_hours, business_hours_start, business_hours_end, active_days")
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  const rules = (rulesRes.data ?? []) as Rule[];
  const limits = {
    cooldown: pubRes.data?.response_cooldown_seconds ?? 0,
    max: pubRes.data?.max_responses_per_lead ?? 0,
    window: pubRes.data?.cooldown_window_hours ?? 24,
  };
  const verticals = (vertRes.data ?? []) as VerticalLite[];
  const seenChannels = Array.from(
    new Set(
      ((seenRes.data ?? []) as { source: string | null }[])
        .map((m) => m.source)
        .filter((s): s is string => Boolean(s))
    )
  );
  const channels = {
    seen: seenChannels,
    ignored: (pubRes.data?.ignored_channels ?? []) as string[],
  };
  const ignoredStageIds = (pubRes.data?.ignored_stage_ids ?? []) as number[];
  const debounce = (pubRes.data?.response_debounce_seconds ?? 45) as number;
  const freshness = (pubRes.data?.answer_max_age_hours ?? 1) as number;
  const media = {
    images: pubRes.data?.respond_to_images === true,
    documents: pubRes.data?.respond_to_documents === true,
    audio: pubRes.data?.respond_to_audio === true,
  };
  const agentOff = {
    fieldId: (pubRes.data?.agent_off_field_id as number | null) ?? null,
    fieldName: (pubRes.data?.agent_off_field_name as string | null) ?? null,
  };
  // Encendido y publicación: el tri-estado de Revisión fusiona auto_reply_mode +
  // bypass_review en un solo control (mismo mapeo que /api/agent/publish).
  const publishingEnabled = pubRes.data?.publishing_enabled === true;
  // bypass_review es independiente de publishing_enabled — ver invariantes en
  // /api/agent/publish. "Sin revisión" puede estar activo en modo sombra.
  const reviewMode: ReviewMode =
    pubRes.data?.bypass_review === true
      ? "sin"
      : pubRes.data?.auto_reply_mode === "review_only"
        ? "todo"
        : "normal";
  const publish: PublishState = {
    agentEnabled: pubRes.data?.agent_enabled !== false, // default ON
    publishing: publishingEnabled,
    reviewMode,
  };
  const crm = {
    enabled: pubRes.data?.crm_actions_enabled === true,
    moveStage: pubRes.data?.crm_can_move_stage === true,
    updateLead: pubRes.data?.crm_can_update_lead === true,
    updateContact: pubRes.data?.crm_can_update_contact === true,
    sendImage: pubRes.data?.crm_can_send_image === true,
  };
  const shopify = {
    enabled: pubRes.data?.shopify_actions_enabled === true,
    search: pubRes.data?.shopify_can_search === true,
    orders: pubRes.data?.shopify_can_orders === true,
    checkout: pubRes.data?.shopify_can_checkout === true,
  };
  const shopifyConnected = shopifyStatus.configured;
  const bcvEnabled = pubRes.data?.bcv_rate_enabled === true;
  const bcvHasCustomSource = Boolean(cfg.BCV_RATE_URL);
  const businessHours = fuRes.data ?? null;
  const comments: CommentsConfig = {
    respond_to_comments: pubRes.data?.respond_to_comments === true,
    comment_reply_enabled: pubRes.data?.comment_reply_enabled === true,
    comment_salesbot_id: (pubRes.data?.comment_salesbot_id as number | null) ?? null,
    comment_field_id: (pubRes.data?.comment_field_id as number | null) ?? null,
    comment_reply_rules: (pubRes.data?.comment_reply_rules as string | null) ?? null,
    comment_instructions: (pubRes.data?.comment_instructions as string | null) ?? null,
    comment_source_ids: ((pubRes.data?.comment_source_ids ?? []) as number[]).map(Number),
  };

  const saved = searchParams.saved === "1";
  const sync = searchParams.sync;
  const errorMsg = searchParams.error;
  const provisioned = Boolean(cfg.ANTHROPIC_AGENT_ID);
  const VALID_TABS = ["agente", "kommo", "herramientas", "seguimiento", "ajustes"] as const;
  // Alias legacy: links viejos a las pestañas fusionadas (identidad/filtros/
  // acciones) siguen aterrizando en "agente" en vez de romperse.
  const rawTab = searchParams.tab ?? "";
  const legacyTab = rawTab === "identidad" || rawTab === "filtros" || rawTab === "acciones" ? "agente" : rawTab;
  const initialTab = (VALID_TABS as readonly string[]).includes(legacyTab)
    ? (legacyTab as (typeof VALID_TABS)[number])
    : "agente";

  return (
    <PageShell
      title="Configuración"
      description="Todo lo que gobierna al agente: identidad, comportamiento, acciones, Kommo, herramientas, seguimiento y ajustes."
    >
      {saved && sync === "ok" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          ✓ Guardado y sincronizado con Anthropic
          {cfg.ANTHROPIC_AGENT_VERSION ? ` (v${cfg.ANTHROPIC_AGENT_VERSION})` : ""}.
        </div>
      )}
      {saved && sync === "pending" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ✓ Guardado en la plataforma. El agente todavía NO está aprovisionado —
          completa el <a className="font-medium underline" href="/setup">setup</a> para
          crearlo en Anthropic con este prompt.
        </div>
      )}
      {saved && sync === "error" && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          ✓ Guardado en la plataforma, pero la sincronización con Anthropic
          falló: <span className="font-mono">{errorMsg}</span>
        </div>
      )}
      {!saved && errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          ✗ {errorMsg}
        </div>
      )}

      <AgentTabs
        initialTab={initialTab}
        rules={rules}
        limits={limits}
        verticals={verticals}
        channels={channels}
        ignoredStageIds={ignoredStageIds}
        debounce={debounce}
        freshness={freshness}
        media={media}
        hasOpenaiKey={Boolean(cfg.OPENAI_API_KEY)}
        crm={crm}
        shopify={shopify}
        shopifyConnected={shopifyConnected}
        bcvEnabled={bcvEnabled}
        bcvHasCustomSource={bcvHasCustomSource}
        businessHours={businessHours}
        comments={comments}
        kommoSlot={<KommoBody kommoSaved={searchParams.kommo_saved === "1"} />}
        toolsSlot={<ToolsBody />}
        seguimientoSlot={<SeguimientoBody />}
        ajustesSlot={<SettingsBody asub={searchParams.asub} />}
      >
        {/* Panel: Identidad */}
        <div className="space-y-6">
          {/* Encendido y publicación: el único lugar para prender el agente,
              publicación y revisión + apagado por lead. */}
          <AgentPublishPanel initial={publish} agentOff={agentOff} />

          <SectionCard
            title="Estado en Anthropic"
            action={
              <Badge color={provisioned ? "green" : "amber"}>
                {provisioned ? "Aprovisionado" : "Pendiente"}
              </Badge>
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                <p className="text-xs uppercase tracking-wide text-neutral-500">Agent ID</p>
                <p className="mt-1 font-mono text-xs text-neutral-900 break-all">
                  {cfg.ANTHROPIC_AGENT_ID ?? "(no configurado — corre /setup)"}
                </p>
              </div>
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                <p className="text-xs uppercase tracking-wide text-neutral-500">Versión</p>
                <p className="mt-1 font-mono text-sm text-neutral-900">
                  {cfg.ANTHROPIC_AGENT_VERSION ? `v${cfg.ANTHROPIC_AGENT_VERSION}` : "—"}
                </p>
              </div>
            </div>
          </SectionCard>

          <AgentForm
            initial={{
              operatorName: cfg.OPERATOR_NAME ?? "",
              agentName: cfg.AGENT_NAME ?? "",
              agentLabel: cfg.NEXT_PUBLIC_AGENT_LABEL ?? "",
            }}
            liveSystemPrompt={liveSystemPrompt}
            liveSystemPromptError={liveSystemPromptError}
          />
        </div>
      </AgentTabs>
    </PageShell>
  );
}
