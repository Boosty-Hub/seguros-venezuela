// server-only: shared helpers for provisioning / updating the Managed Agent.
// Centralizes the placeholder substitution and the tool builder so the
// Phase 2 identity editor (/api/agent) and the Phase 3 setup wizard
// (/api/setup/agent) stay in sync — both must send the SAME tools and the
// SAME placeholder semantics.
//
// SINGLE SOURCE OF TRUTH for the actual scaffold/composition LOGIC is
// ./agent-prompt-core.mjs (plain JS, no types) — it's the same file imported
// verbatim by scripts/provision-agent.mjs (a standalone Node script outside
// the Next.js build). This file only adds TypeScript types on top; do NOT
// redefine CORE_SCAFFOLD or composeSystem here — edit agent-prompt-core.mjs
// so both the dashboard and the CLI provisioning script stay identical.
//
// SINGLE SOURCE OF TRUTH: tool definitions live in the `agent_tools` DB table
// (migration 0019). buildAgentTools() renders the rows it receives; callers
// filter them first with filterToolRowsByGates() so that GATED-OFF system
// tools are NOT declared to the agent (their schema costs input tokens on
// every internal turn of every session and invites hallucinated calls).
// The `agent_toolset_20260401` row gets its native Anthropic type; every other
// row (system or http) is rendered as a custom tool.

import type Anthropic from "@anthropic-ai/sdk";
import {
  CORE_SCAFFOLD as CORE_SCAFFOLD_JS,
  CRM_ACTION_PHRASES as CRM_ACTION_PHRASES_JS,
  buildCrmActionsBlock as buildCrmActionsBlockJs,
  substitutePlaceholders as substitutePlaceholdersJs,
  composeSystem as composeSystemJs,
  filterToolRowsByGates as filterToolRowsByGatesJs,
  buildAgentTools as buildAgentToolsJs,
} from "./agent-prompt-core.mjs";

// Derive the tools param type straight from the SDK client method so the
// definitions are checked against the real API shape (no fragile casts at
// call sites). create() and update() share this same tools union.
export type AgentTools = NonNullable<
  Parameters<Anthropic["beta"]["agents"]["update"]>[1]["tools"]
>;

/**
 * A row from agent_tools that buildAgentTools() can render.
 * Matches the DB schema columns used at tool-definition time.
 */
export type AgentToolRow = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  } | null;
  tool_type?: string;
};

/**
 * Gate flags from kommo_publish_config that decide which SYSTEM tools get
 * DECLARED to the Managed Agent. All optional: the template's clones may lack
 * some columns (older migration sets) — a missing flag reads as OFF, and the
 * corresponding tool row won't exist in agent_tools there either.
 */
export type ToolGateFlags = {
  crm_actions_enabled?: boolean | null;
  crm_can_move_stage?: boolean | null;
  crm_can_update_lead?: boolean | null;
  crm_can_update_contact?: boolean | null;
  crm_can_add_note?: boolean | null;
  crm_can_handoff?: boolean | null;
  crm_can_tag?: boolean | null;
  shopify_actions_enabled?: boolean | null;
  shopify_can_search?: boolean | null;
  shopify_can_orders?: boolean | null;
  shopify_can_checkout?: boolean | null;
  bcv_rate_enabled?: boolean | null;
};

/**
 * Drops the system tool rows whose gate is OFF so their schemas never reach
 * the agent definition. gates=null (no kommo_publish_config row yet, e.g.
 * mid-setup) declares only ungated tools — fail-closed, matching the gates'
 * default false.
 */
export function filterToolRowsByGates(
  rows: AgentToolRow[],
  gates: ToolGateFlags | null | undefined
): AgentToolRow[] {
  return filterToolRowsByGatesJs(rows, gates) as AgentToolRow[];
}

export type PlaceholderValues = {
  operatorName: string;
  masterStoreName: string;
  leadsStoreName: string;
};

/**
 * Replaces the {{...}} placeholders in the raw system prompt with the
 * operator's real identity + memory-store paths.
 *
 * Optional 4th argument: list of enabled HTTP tools. When provided, the
 * {{TOOLS_LIST}} placeholder is replaced with a one-line summary. If the
 * system prompt omits the placeholder nothing changes (additive replaceAll).
 */
export function substitutePlaceholders(
  raw: string,
  values: PlaceholderValues,
  enabledHttpTools: AgentToolRow[] = []
): string {
  return substitutePlaceholdersJs(raw, values, enabledHttpTools);
}

/**
 * Builds the Anthropic tools array from DB-fetched rows.
 *
 * All enabled rows are passed in (system + http). The builder applies one
 * type-specific branch: agent_toolset_20260401 → native Anthropic type.
 * Everything else → custom tool. This is rendering, not a duplicated
 * definition — the DB is the single source of truth.
 *
 * Protection against accidental removal: the CRUD API rejects
 * delete/disable of any tool_type='system' row (403), and system rows are
 * seeded with enabled=true. So the builder always receives them.
 */
export function buildAgentTools(rows: AgentToolRow[]): AgentTools {
  return buildAgentToolsJs(rows) as unknown as AgentTools;
}

/**
 * CORE_SCAFFOLD — the FIXED operating contract appended to every agent's system
 * prompt. It is IDENTICAL for every client and the runtime DEPENDS on it:
 *   - generate-response parses <respuesta>...</respuesta> (the output format),
 *   - the master/leads Memory Stores are mounted at {{MASTER_PATH}}/{{LEADS_PATH}},
 *   - search_kb is the factual-retrieval tool.
 * It is NOT shown in the editable /agent prompt (so a non-technical operator
 * can't break the machinery) and is NOT generated by the AI. It is always sent
 * behind the scenes via composeSystem(). Defined once in ./agent-prompt-core.mjs
 * — edit THERE, not here (this re-export exists only for TS callers).
 */
export const CORE_SCAFFOLD: string = CORE_SCAFFOLD_JS;

export const CRM_ACTION_PHRASES: Record<string, string> = CRM_ACTION_PHRASES_JS;

/**
 * Renders the "Acciones en el CRM" scaffold block from the tools actually
 * declared to the agent. Empty string (block omitted) when no CRM tool is
 * declared, so the prompt never promises capabilities the agent doesn't have.
 */
export function buildCrmActionsBlock(declaredToolNames: string[]): string {
  return buildCrmActionsBlockJs(declaredToolNames);
}

/**
 * Composes the FULL system prompt sent to the Managed Agent: the operator's
 * editable prompt (identity/voice/business) FIRST, then the fixed CORE_SCAFFOLD
 * (machinery + security), with all {{...}} placeholders substituted. This is the
 * single composition point — both syncAgentTools and /api/setup/agent use it, so
 * the scaffold is always present and identical no matter how the agent is synced.
 * scripts/provision-agent.mjs (CLI provisioning) imports the SAME logic from
 * ./agent-prompt-core.mjs directly, so there is exactly one implementation.
 *
 * declaredToolNames: names of the tools DECLARED to the agent (post gate
 * filter). Drives the CRM actions block; defaults to [] (block omitted) so a
 * stale caller can never produce dangling tool references.
 *
 * There is no separate "voice" memory store anymore — voice/identity lives
 * entirely in the operator's editable prompt (the /agent textarea).
 */
export function composeSystem(
  operatorPrompt: string,
  values: PlaceholderValues,
  enabledHttpTools: AgentToolRow[] = [],
  declaredToolNames: string[] = []
): string {
  return composeSystemJs(operatorPrompt, values, enabledHttpTools, declaredToolNames);
}
