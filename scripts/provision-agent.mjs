// ============================================================================
// Provisiona el agente de IA (Anthropic Managed Agent + Environment + Memory
// Stores) y carga runtime_config, replicando EXACTAMENTE la lógica del wizard
// /setup del dashboard (web/src/app/api/setup/{agent,memory}/route.ts y
// web/src/lib/agent-prompt.ts), sin pasar por el navegador.
//
//   node scripts/provision-agent.mjs
//
// Requiere en el entorno: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF,
// ANTHROPIC_API_KEY (de sync/.env), y las vars de identidad más abajo.
// ============================================================================
import { readFileSync } from 'node:fs';
// Fuente única del scaffold/composición del system prompt — la misma que usa
// el dashboard (web/src/lib/agent-prompt.ts reexporta este mismo archivo).
// Antes este script traía su propia copia pegada de CORE_SCAFFOLD/composeSystem
// que podía desincronizarse (deuda ya corregida).
import { composeSystem } from '../web/src/lib/agent-prompt-core.mjs';

const SB_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!SB_TOKEN || !REF) throw new Error('Faltan SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF');
if (!ANTHROPIC_KEY) throw new Error('Falta ANTHROPIC_API_KEY');

const MGMT_BASE = 'https://api.supabase.com';

async function sqlQuery(sql) {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Supabase query failed (${res.status}): ${await res.text()}`);
  return res.json();
}

function sqlStr(s) { return `'${String(s).replace(/'/g, "''")}'`; }

async function setConfigValues(values) {
  const rows = Object.entries(values);
  for (const [key, value] of rows) {
    if (value === undefined) continue;
    await sqlQuery(
      `INSERT INTO runtime_config (key, value, updated_at, updated_by) VALUES (${sqlStr(key)}, ${value === null ? 'NULL' : sqlStr(value)}, now(), 'provision-agent.mjs') ` +
      `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`
    );
  }
}

async function configValues(keys) {
  const list = keys.map(sqlStr).join(',');
  const rows = await sqlQuery(`SELECT key, value FROM runtime_config WHERE key IN (${list})`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ─── Anthropic Managed Agents raw client (puerto de web/src/lib/anthropic-managed.ts) ───
const AB = 'https://api.anthropic.com';
const BETA = 'managed-agents-2026-04-01';
function authHeaders() {
  return { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'content-type': 'application/json' };
}
class AnthropicHttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function call(method, path, body) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${AB}${path}${sep}beta=true`, { method, headers: authHeaders(), body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new AnthropicHttpError(`Anthropic ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`, res.status);
  return text ? JSON.parse(text) : {};
}
async function findByName(resource, name) {
  const data = await call('GET', `/v1/${resource}?limit=100`);
  const items = Array.isArray(data.data) ? data.data : [];
  return items.find((x) => x.name === name) ?? null;
}
async function retrieveResource(resource, id) {
  try { return await call('GET', `/v1/${resource}/${id}`); }
  catch (e) { if (e instanceof AnthropicHttpError && e.status === 404) return null; throw e; }
}
async function createEnvironment(body) { return call('POST', '/v1/environments', body); }
async function createAgent(body) { return call('POST', '/v1/agents', body); }
async function createMemoryStore(body) { return call('POST', '/v1/memory_stores', body); }
async function renameResource(resource, id, name) {
  if (resource === 'agents') {
    const doRename = async () => {
      const current = await call('GET', `/v1/agents/${id}`);
      return call('POST', `/v1/agents/${id}`, { version: current.version, name });
    };
    try { return await doRename(); }
    catch (e) { if (e instanceof AnthropicHttpError && e.status === 409) return doRename(); throw e; }
  }
  return call('POST', `/v1/${resource}/${id}`, { name });
}

// ─── identidad ──────────────────────────────────────────────────────────────
const IDENTITY = {
  OPERATOR_NAME: 'Asesora Sofi',
  AGENT_NAME: 'seguros-venezuela-sofi',
  AGENT_ENVIRONMENT_NAME: 'seguros-venezuela-env',
  AGENT_MODEL: 'claude-haiku-4-5',
  AGENT_DESCRIPTION: 'Responde mensajes entrantes de clientes y leads de Seguros Venezuela por WhatsApp e Instagram, en la voz de Asesora Sofi.',
  MEMORY_STORE_MASTER_NAME: 'sv-master',
  MEMORY_STORE_LEADS_NAME: 'sv-leads',
  NEXT_PUBLIC_AGENT_LABEL: 'Agente Seguros Venezuela',
};

const MASTER_DESCRIPTION =
  'Memoria global del operador: voz (reglas, chats reales, transcripciones, respuestas ejemplares), KB destilada y aprendizajes destilados por el job de Dreams. ' +
  'Estructura del filesystem: /voice/rule/<sample_id>_<chunk>.md, /voice/chat_export/<id>_<chunk>.md, /voice/transcript/<id>_<chunk>.md, /voice/example_response/<id>_<chunk>.md, /kb/<doc>/<chunk>.md, /dreams/<date>_<topic>.md. ' +
  'ANTES de redactar cualquier respuesta a un lead: grep por palabras clave del mensaje del lead en /voice/ para reglas y ejemplos aplicables; consulta /kb/ para info factual; mira /dreams/ para aprendizajes recientes que tienen prioridad sobre la voz base.';
const LEADS_DESCRIPTION =
  'Memoria persistente por lead. Estructura: /<lead_id>/conversation.md (timeline de mensajes inbound/outbound), /<lead_id>/learnings.md (observaciones del agente: objeciones recurrentes, contexto, preferencias, vertical asignada). ' +
  'El lead_id es el ID nativo del lead en el CRM. ANTES de responder a un mensaje entrante: leer /<lead_id>/conversation.md y /<lead_id>/learnings.md si existen, para contexto histórico. DESPUÉS de responder: actualizar conversation.md con el nuevo turno y agregar a learnings.md si aprendiste algo nuevo sobre el lead.';

// ─── 1. runtime_config: identidad + system prompt ──────────────────────────
console.log('1) Escribiendo identidad + system prompt en runtime_config...');
const systemPromptRaw = readFileSync('agent/system-prompt.md', 'utf8');
await setConfigValues({ ...IDENTITY, ANTHROPIC_API_KEY: ANTHROPIC_KEY, SYSTEM_PROMPT: systemPromptRaw });
console.log('   OK');

// ─── 2. Environment ─────────────────────────────────────────────────────────
console.log('2) Environment...');
let envId;
{
  const existing = await findByName('environments', IDENTITY.AGENT_ENVIRONMENT_NAME);
  if (existing) { envId = existing.id; console.log(`   ya existe: ${envId}`); }
  else {
    const env = await createEnvironment({
      name: IDENTITY.AGENT_ENVIRONMENT_NAME,
      description: 'Environment estándar para el agente. Networking sin restricciones (las llamadas autenticadas se hacen vía custom tools del orchestrator, no desde el container).',
      config: { type: 'cloud', networking: { type: 'unrestricted' } },
    });
    envId = env.id;
    console.log(`   creado: ${envId}`);
  }
}

// ─── 3. Agent ───────────────────────────────────────────────────────────────
console.log('3) Managed Agent...');
const system = composeSystem(
  systemPromptRaw,
  {
    operatorName: IDENTITY.OPERATOR_NAME,
    masterStoreName: IDENTITY.MEMORY_STORE_MASTER_NAME,
    leadsStoreName: IDENTITY.MEMORY_STORE_LEADS_NAME,
  },
  [], // sin tools http habilitadas al arrancar
  [], // sin tools de CRM declaradas al arrancar (shadow mode)
  { hasVoice: false } // /voice/ vacío al arrancar
);
const tools = [
  { type: 'custom', name: 'search_kb', description: 'Busca información factual en la base de conocimiento (RAG).', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { type: 'agent_toolset_20260401', default_config: { enabled: true } },
];
let agentId, agentVersion;
{
  const existing = await findByName('agents', IDENTITY.AGENT_NAME);
  if (existing) {
    agentId = existing.id; agentVersion = existing.version ?? 0;
    console.log(`   ya existe: ${agentId} (v${agentVersion}) -- no se reconfigura, usa el dashboard /agent para editarlo`);
  } else {
    const created = await createAgent({
      name: IDENTITY.AGENT_NAME,
      model: IDENTITY.AGENT_MODEL,
      description: IDENTITY.AGENT_DESCRIPTION,
      system,
      tools,
    });
    agentId = created.id; agentVersion = created.version ?? 0;
    console.log(`   creado: ${agentId} (v${agentVersion})`);
  }
}

// ─── 4. Memory Stores ───────────────────────────────────────────────────────
console.log('4) Memory Stores...');
async function ensureStore(name, description) {
  const existing = await findByName('memory_stores', name);
  if (existing) { console.log(`   ${name}: ya existe (${existing.id})`); return existing.id; }
  const created = await createMemoryStore({ name, description });
  console.log(`   ${name}: creado (${created.id})`);
  return created.id;
}
const masterId = await ensureStore(IDENTITY.MEMORY_STORE_MASTER_NAME, MASTER_DESCRIPTION);
const leadsId = await ensureStore(IDENTITY.MEMORY_STORE_LEADS_NAME, LEADS_DESCRIPTION);

// ─── 5. Guardar IDs resultantes ─────────────────────────────────────────────
await setConfigValues({
  ANTHROPIC_ENVIRONMENT_ID: envId,
  ANTHROPIC_AGENT_ID: agentId,
  ANTHROPIC_AGENT_VERSION: String(agentVersion),
  ANTHROPIC_MEMORY_MASTER_ID: masterId,
  ANTHROPIC_MEMORY_LEADS_ID: leadsId,
});

console.log('\nListo. Resumen:');
console.log({ envId, agentId, agentVersion, masterId, leadsId });
