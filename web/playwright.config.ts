import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Carga .env.local a mano (parser mínimo, sin dependencias nuevas) para que los
// tests vean E2E_EMAIL / E2E_PASSWORD sin que las credenciales acaben en
// ningún fichero versionado. Las que ya vengan del entorno mandan.
function cargarEnvLocal() {
  try {
    const texto = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const linea of texto.split(/\r?\n/)) {
      const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const clave = m[1];
      if (process.env[clave] !== undefined) continue;
      let valor = m[2].trim();
      if (
        (valor.startsWith('"') && valor.endsWith('"')) ||
        (valor.startsWith("'") && valor.endsWith("'"))
      ) {
        valor = valor.slice(1, -1);
      }
      process.env[clave] = valor;
    }
  } catch {
    // Sin .env.local los tests fallan con un mensaje claro en su propio setup.
  }
}
cargarEnvLocal();

const PUERTO = Number(process.env.E2E_PORT ?? 3000);
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${PUERTO}`;

export default defineConfig({
  testDir: "./e2e",
  // Un solo worker: los tests tocan datos compartidos de verdad (cargan el
  // Reporte de Emisión, ligan alias) y en paralelo se pisarían entre sí.
  workers: 1,
  fullyParallel: false,
  // Sin reintentos: un test que solo pasa al segundo intento está ocultando
  // una condición de carrera que preferimos ver.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  use: {
    baseURL: BASE,
    // El dashboard hace bastante trabajo en el servidor (RPCs contra Supabase
    // real), así que las acciones necesitan más margen que el default.
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Reutiliza el dev server si ya está levantado; si no, lo arranca.
  webServer: {
    command: `pnpm dev --port ${PUERTO}`,
    url: BASE,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
