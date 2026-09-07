import { test, expect } from "@playwright/test";
import { entrar, irAPipeline } from "./util";

// Revisión manual de alias de corredor (PENDIENTE 8).
//
// Este test SÍ escribe: liga un alias de verdad contra la base de producción.
// Por eso al final lo desliga, dejando el estado como estaba. El nombre que
// usa sale de la propia lista de pendientes (por definición sin alias), así
// que desligarlo no puede borrar un mapeo legítimo previo.

test.beforeEach(async ({ page }) => {
  await entrar(page);
  await irAPipeline(page);
});

test("el panel lista los pendientes ordenados por volumen", async ({ page }) => {
  await page.getByRole("button", { name: /Revisar corredores/i }).click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByText(/nombres de Zoho sin código del sistema central/i)).toBeVisible();

  // Ordenar por volumen es lo que hace útil la revisión: mapear el de 213
  // cotizaciones mueve los porcentajes, el de 1 no.
  const filas = modal.locator("div").filter({ hasText: /cotizaciones · .* clientes/ });
  await expect(filas.first()).toBeVisible();

  const textos = await filas.allInnerTexts();
  const cotiz = textos
    .map((t) => t.match(/([\d.]+) cotizaciones/)?.[1])
    .filter((v): v is string => !!v)
    .map((v) => Number(v.replace(/\./g, "")));
  expect(cotiz.length).toBeGreaterThan(0);
  expect(cotiz).toEqual([...cotiz].sort((a, b) => b - a));
});

test("ligar un alias a mano y volver a desligarlo", async ({ page }) => {
  // Se elige un pendiente que tenga al menos un candidato sugerido.
  const pend = await page.evaluate(async () => {
    const r = await fetch("/api/pipeline/alias?vista=pendientes&limite=25");
    const j = await r.json();
    const fila = (j.filas ?? []).find(
      (f: { candidatos: unknown[] }) => Array.isArray(f.candidatos) && f.candidatos.length > 0
    );
    return fila ?? null;
  });
  test.skip(!pend, "No hay ningún pendiente con candidatos para probar.");

  const nombre: string = pend.asesor_norm;
  const candidato = pend.candidatos[0] as { cod: string; nombre: string };

  await page.getByRole("button", { name: /Revisar corredores/i }).click();
  const modal = page.getByRole("dialog");

  // Buscarlo por nombre para no depender de en qué página cayó.
  await modal.getByPlaceholder("Buscar nombre…").fill(nombre);
  await expect(modal.getByText(nombre, { exact: true })).toBeVisible();

  // El botón del candidato lleva su nombre canónico y el % de parecido.
  await modal.getByRole("button", { name: new RegExp(escapar(candidato.nombre), "i") }).first().click();

  // Confirmación en la propia fila.
  await expect(modal.getByText(new RegExp(`ligado a ${escapar(candidato.nombre)}`, "i"))).toBeVisible();

  // Tiene que estar guardado de verdad, con origen manual.
  const guardado = await page.evaluate(async (n) => {
    const r = await fetch(`/api/pipeline/alias?vista=asignados&q=${encodeURIComponent(n)}&limite=10`);
    const j = await r.json();
    return (j.filas ?? []).find((f: { asesor_norm: string }) => f.asesor_norm === n) ?? null;
  }, nombre);
  expect(guardado).not.toBeNull();
  expect(guardado.origen).toBe("manual");
  expect(guardado.cod_intermediario).toBe(candidato.cod);

  // ── Restaurar: desligarlo desde la pestaña "Ya ligados" ────────────────
  await modal.getByRole("button", { name: /^Ya ligados$/i }).click();
  await modal.getByPlaceholder("Buscar nombre…").fill(nombre);
  await expect(modal.getByText(nombre, { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: /^Desligar$/i }).first().click();

  await expect
    .poll(
      async () =>
        await page.evaluate(async (n) => {
          const r = await fetch(`/api/pipeline/alias?vista=asignados&q=${encodeURIComponent(n)}&limite=10`);
          const j = await r.json();
          return (j.filas ?? []).some((f: { asesor_norm: string }) => f.asesor_norm === n);
        }, nombre),
      { timeout: 20_000 }
    )
    .toBe(false);
});

test("la API rechaza un código de intermediario que no existe", async ({ page }) => {
  const res = await page.evaluate(async () => {
    const r = await fetch("/api/pipeline/alias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accion: "fijar", asesor_norm: "NOMBRE QUE NO EXISTE E2E", cod_intermediario: "00-no-existe" }),
    });
    return { status: r.status, json: await r.json() };
  });
  expect(res.status).toBe(400);
  // Mensaje entendible, no un error crudo de la FK de Postgres.
  expect(res.json.error).toMatch(/no está en el registro de intermediarios/i);
});

/** Escapa un literal para meterlo en un RegExp. */
function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
