// ============================================================================
// Aplica las migraciones de supabase/migrations/*.sql vía la Management API
// de Supabase, replicando exactamente el algoritmo del wizard /first-run del
// template (web/src/app/api/provision/migrate/route.ts): tabla _migrations
// como registro de control, orden lexico por nombre de archivo, sustitucion
// de ${SUPABASE_URL}, una migracion a la vez, idempotente.
//
//   node scripts/migrate-agent.mjs
//
// Requiere en el entorno: SUPABASE_ACCESS_TOKEN (sbp_...), SUPABASE_PROJECT_REF
// (cargar desde .env.local: set -a && . ./.env.local && set +a && node ...)
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF;
if (!TOKEN || !REF) throw new Error('Faltan SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF en el entorno');

const MGMT_BASE = 'https://api.supabase.com';
const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

async function runQuery(sql) {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Management API query failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function ensureMigrationsTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `.trim());
}

async function getApplied() {
  try {
    const result = await runQuery('SELECT filename FROM _migrations ORDER BY filename');
    return new Set(result.map((r) => r.filename));
  } catch {
    return new Set();
  }
}

async function recordApplied(filename) {
  await runQuery(`INSERT INTO _migrations (filename) VALUES ('${filename.replace(/'/g, "''")}') ON CONFLICT DO NOTHING`);
}

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
console.log(`${files.length} archivo(s) de migracion encontrados en supabase/migrations/`);

await ensureMigrationsTable();
const applied = await getApplied();
console.log(`${applied.size} ya aplicada(s) previamente`);

const projectUrl = `https://${REF}.supabase.co`;
let done = 0;
for (const filename of files) {
  if (applied.has(filename)) { done++; continue; }
  const raw = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
  const sql = raw.replaceAll('${SUPABASE_URL}', projectUrl);
  process.stdout.write(`  aplicando ${filename} ... `);
  try {
    await runQuery(sql);
    await recordApplied(filename);
    console.log('OK');
    done++;
  } catch (e) {
    console.log('FALLO');
    console.error(`\nError en ${filename}:`, e.message);
    process.exit(1);
  }
}
console.log(`Listo: ${done}/${files.length} migraciones aplicadas.`);
