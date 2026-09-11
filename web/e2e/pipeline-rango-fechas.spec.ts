import { test, expect, type Page } from "@playwright/test";
import { entrar } from "./util";

// Filtro de rango de fechas de /pipeline (0081).
//
// Lo que hay que comprobar acá no es que los botones existan, sino las tres
// cosas que se rompen en silencio y que un typecheck no ve:
//   1. que el filtro REALMENTE filtre (el número baja, no se queda igual),
//   2. que el periodo sobreviva al cambiar de pestaña y al recargar,
//   3. que la pestaña activa no se pierda al filtrar.
// El caso 1 es el importante: con las vistas viejas (v_kpis y compañía) el
// filtro se pintaba pero los totales seguían siendo los del histórico entero.

test.beforeEach(async ({ page }) => {
  await entrar(page);
});

/** Total de tickets de la pestaña "Embudo Zoho", como número. */
async function totalEmbudo(page: Page): Promise<number> {
  const tarjeta = page.locator("div").filter({ hasText: /^Total tickets/ }).last();
  await expect(tarjeta).toBeVisible({ timeout: 60_000 });
  const txt = await tarjeta.innerText();
  const m = txt.match(/[\d.]+/);
  return Number((m?.[0] ?? "0").replace(/\./g, ""));
}

test("un rango acotado devuelve menos tickets que todo el histórico", async ({ page }) => {
  await page.goto("/pipeline?vista=embudo");
  const todo = await totalEmbudo(page);
  expect(todo).toBeGreaterThan(0);

  // "Hoy" es el corte más estrecho posible: tiene que dar menos que el
  // histórico completo. Si diera lo mismo, el filtro no está llegando a la
  // consulta — que es exactamente lo que pasaba con las vistas sin parámetros.
  await page.getByRole("button", { name: /^Hoy$/ }).click();
  await expect(page).toHaveURL(/desde=\d{4}-\d{2}-\d{2}/);
  const hoy = await totalEmbudo(page);
  expect(hoy).toBeLessThan(todo);
});

test("el atajo 'Mes pasado' arma un rango cerrado y lo describe", async ({ page }) => {
  await page.goto("/pipeline?vista=embudo");
  await page.getByRole("button", { name: /^Mes pasado$/ }).click();

  // Rango CERRADO: las dos puntas en la URL. Un "desde" suelto sería el bug
  // que tenía el módulo antes (solo existía p_since).
  await expect(page).toHaveURL(/desde=\d{4}-\d{2}-\d{2}/);
  await expect(page).toHaveURL(/hasta=\d{4}-\d{2}-\d{2}/);

  const url = new URL(page.url());
  const desde = url.searchParams.get("desde")!;
  const hasta = url.searchParams.get("hasta")!;
  expect(desde.endsWith("-01")).toBe(true);           // arranca el día 1
  expect(desde.slice(0, 7)).toBe(hasta.slice(0, 7));  // y termina en el mismo mes

  // El periodo se redacta en la descripción de la cabecera. Se localiza por su
  // texto propio y no por /del .* al .*/, que también machea el panel de
  // alertas de la Torre y rompe el modo estricto de Playwright.
  await expect(
    page.getByText(/Embudo de ventas sincronizado desde Zoho Desk — del .* al .*/)
  ).toBeVisible();
});

test("el periodo sobrevive al cambiar de pestaña", async ({ page }) => {
  await page.goto("/pipeline");
  await page.getByRole("button", { name: /^30 días$/ }).click();
  await expect(page).toHaveURL(/desde=/);
  const desde = new URL(page.url()).searchParams.get("desde")!;

  await page.getByRole("link", { name: /Embudo Zoho/ }).click();
  await expect(page).toHaveURL(/vista=embudo/);
  expect(new URL(page.url()).searchParams.get("desde")).toBe(desde);

  await page.getByRole("link", { name: /B2C \/ B2B por corredor/ }).click();
  expect(new URL(page.url()).searchParams.get("desde")).toBe(desde);
});

test("filtrar la tabla de tickets conserva pestaña y periodo", async ({ page }) => {
  // Un <form method=get> reemplaza el query string entero: sin los hidden que
  // arrastran vista/desde/hasta, filtrar por canal te devolvía a la pestaña
  // por defecto y sin periodo.
  await page.goto("/pipeline?vista=embudo");
  await page.getByRole("button", { name: /^7 días$/ }).click();
  await expect(page).toHaveURL(/desde=/);

  await page.getByRole("button", { name: /^Filtrar$/ }).click();
  await expect(page).toHaveURL(/vista=embudo/);
  await expect(page).toHaveURL(/desde=\d{4}-\d{2}-\d{2}/);
});

test("un rango escrito a mano se aplica y se puede volver a Todo", async ({ page }) => {
  await page.goto("/pipeline?vista=embudo");
  await page.getByLabel("Fecha de inicio").fill("2026-08-01");
  await page.getByLabel("Fecha de fin").fill("2026-08-31");
  await page.getByRole("button", { name: /^Aplicar$/ }).click();

  await expect(page).toHaveURL(/desde=2026-08-01/);
  await expect(page).toHaveURL(/hasta=2026-08-31/);
  const agosto = await totalEmbudo(page);

  await page.getByRole("button", { name: /^Todo$/ }).click();
  await expect(page).not.toHaveURL(/desde=/);
  expect(await totalEmbudo(page)).toBeGreaterThanOrEqual(agosto);
});

test("el selector de emisiones filtra por mes de suscripción", async ({ page }) => {
  // Con un solo mes cargado los números se entendían sin decir de cuándo eran.
  // En cuanto entre otro mes dejan de significar nada sin este filtro, así que
  // lo que se comprueba es que el chip del mes acote de verdad, no que exista.
  await page.goto("/pipeline");
  const chips = page.getByText("Suscritas en:").locator("..");
  await expect(chips).toBeVisible({ timeout: 60_000 });

  // El primer mes con datos (el más reciente). Su etiqueta lleva el conteo.
  const mes = chips.getByRole("button").nth(1);
  const etiqueta = (await mes.innerText()).trim();
  await mes.click();

  // Acota el rango global a un mes cerrado: primer día y último día del mismo.
  await expect(page).toHaveURL(/desde=\d{4}-\d{2}-01/);
  const url = new URL(page.url());
  const d = url.searchParams.get("desde")!;
  const h = url.searchParams.get("hasta")!;
  expect(d.slice(0, 7)).toBe(h.slice(0, 7));
  expect(etiqueta).toContain(d.slice(0, 4)); // la etiqueta nombra ese año

  // Y se puede salir: "Todo" limpia las dos puntas.
  await chips.getByRole("button", { name: /^Todo$/ }).click();
  await expect(page).not.toHaveURL(/desde=/);
});
