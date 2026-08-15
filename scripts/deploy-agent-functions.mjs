// ============================================================================
// Despliega las Edge Functions del agente de IA (supabase/functions/*, salvo
// _shared y zoho-sync) vía la Management API de Supabase, replicando
// exactamente el bundle layout de scripts/embed-provision.mjs del template:
//
//   <slug>/index.ts   <- entrypoint
//   _shared/<file>     <- sibling de <slug>/, para que "../_shared/x.ts" resuelva
//
// verify_jwt SIEMPRE false (Kommo y pg_cron llaman sin JWT de usuario).
//
//   node scripts/deploy-agent-functions.mjs            despliega las que falten
//   node scripts/deploy-agent-functions.mjs <slug>      despliega una puntual (redeploy)
//
// Requiere en el entorno: SUPABASE_ACCESS_TOKEN (sbp_...), SUPABASE_PROJECT_REF
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
if (!TOKEN || !REF) throw new Error('Faltan SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF en el entorno');

const MGMT_BASE = 'https://api.supabase.com';
const FUNCTIONS_DIR = join(process.cwd(), 'supabase', 'functions');
const EXCLUDE = new Set(['_shared', 'zoho-sync']);

async function listFunctions() {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${REF}/functions`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`listFunctions -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function deployFunction(slug, files, entrypoint) {
  const form = new FormData();
  const metadata = { name: slug, entrypoint_path: entrypoint, verify_jwt: false };
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  for (const file of files) {
    form.append('file', new Blob([file.body], { type: 'application/typescript' }), file.path);
  }
  const res = await fetch(`${MGMT_BASE}/v1/projects/${REF}/functions/deploy?slug=${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`deployFunction '${slug}' -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---- construir el bundle igual que embed-provision.mjs -------------------
const sharedDir = join(FUNCTIONS_DIR, '_shared');
const sharedFiles = readdirSync(sharedDir)
  .filter((f) => !f.startsWith('.'))
  .map((filename) => ({ path: `_shared/${filename}`, body: readFileSync(join(sharedDir, filename), 'utf8') }));

const allSlugs = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !EXCLUDE.has(d.name))
  .map((d) => d.name)
  .sort();

function bundleFor(slug) {
  const indexPath = join(FUNCTIONS_DIR, slug, 'index.ts');
  const indexBody = readFileSync(indexPath, 'utf8');
  return {
    slug,
    entrypoint: `${slug}/index.ts`,
    files: [{ path: `${slug}/index.ts`, body: indexBody }, ...sharedFiles],
  };
}

// ---- entry point -----------------------------------------------------------
const explicitSlug = process.argv[2];
const deployed = await listFunctions();
const deployedSlugs = new Set(deployed.map((f) => f.slug));

const targets = explicitSlug ? [explicitSlug] : allSlugs.filter((s) => !deployedSlugs.has(s));
if (!targets.length) {
  console.log('Nada por desplegar: todas las funciones ya estan presentes.');
  process.exit(0);
}

console.log(`Desplegando ${targets.length} funcion(es): ${targets.join(', ')}`);
for (const slug of targets) {
  if (!allSlugs.includes(slug)) throw new Error(`Slug desconocido: ${slug}`);
  process.stdout.write(`  ${slug} ... `);
  const { entrypoint, files } = bundleFor(slug);
  await deployFunction(slug, files, entrypoint);
  console.log('OK');
}
console.log('Listo.');
