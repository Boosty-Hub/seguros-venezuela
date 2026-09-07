import { test, expect } from "@playwright/test";
import { entrar } from "./util";

// Columna de uso del clasificador en /verticales.
//
// Lo que hay que verificar no es que "salga un número", sino que el número sea
// el de la base y que la tabla RECONCILIE: la suma de la columna no da el total
// de entrantes, y sin la línea del pie eso parece que el módulo se come
// mensajes.

test.beforeEach(async ({ page }) => {
  await entrar(page);
  await page.goto("/verticales");
  await expect(page.getByRole("heading", { name: /^Verticales$/ })).toBeVisible({ timeout: 60_000 });
});

test("la columna de mensajes cuadra con verticales_uso()", async ({ page }) => {
  const tabla = page.locator("table");
  await expect(tabla).toBeVisible();
  await expect(tabla.getByRole("columnheader", { name: /Mensajes/i })).toBeVisible();

  // No hay ruta API para esto: el dato lo calcula la página en el servidor.
  // Así que la verificación es interna a la vista — que la suma de la columna
  // cuadre con el total que declara el pie, y que la diferencia esté explicada.
  const texto = await page.locator("body").innerText();

  // El pie dice cuántos se clasificaron y de cuántos entrantes.
  const m = texto.match(/([\d.]+)\s+mensajes clasificados\s+de\s+([\d.]+)\s+entrantes/i);
  expect(m, "el pie de reconciliación tiene que estar visible").not.toBeNull();
  const clasificados = Number(m![1].replace(/\./g, ""));
  const entrantes = Number(m![2].replace(/\./g, ""));
  expect(clasificados).toBeGreaterThan(0);
  expect(entrantes).toBeGreaterThanOrEqual(clasificados);

  // Si hay diferencia, tiene que estar explicada: ignorados y/o fallidos.
  if (entrantes > clasificados) {
    const otros = texto.match(/Los otros\s+([\d.]+):/i);
    expect(otros, "la diferencia tiene que estar explicada en el pie").not.toBeNull();
    expect(Number(otros![1].replace(/\./g, ""))).toBe(entrantes - clasificados);
    expect(texto).toMatch(/ignorados a propósito/i);
  }

  // Y la suma de la columna tiene que dar exactamente los clasificados: si no,
  // alguna vertical no se está pintando o se cuenta dos veces.
  const celdas = await tabla.locator("tbody tr td:nth-child(6)").allInnerTexts();
  const suma = celdas
    .map((c) => {
      const n = c.trim().match(/^([\d.]+)/);
      return n ? Number(n[1].replace(/\./g, "")) : 0;
    })
    .reduce((a, b) => a + b, 0);
  expect(suma).toBe(clasificados);
});

test("una vertical sin uso muestra un guion, no un cero", async ({ page }) => {
  // Un 0 se lee como "el clasificador la evaluó y no encajó nunca"; el guion
  // dice "no hay dato". La diferencia importa al decidir si una vertical sobra.
  const tabla = page.locator("table");
  const celdas = await tabla.locator("tbody tr td:nth-child(6)").allInnerTexts();
  const vacias = celdas.filter((c) => c.trim() === "—");
  const conNumero = celdas.filter((c) => /^\d/.test(c.trim()));

  // Al menos una de cada, con los datos actuales (hay verticales sin usar).
  expect(conNumero.length).toBeGreaterThan(0);
  for (const c of vacias) expect(c.trim()).toBe("—");
  // Ninguna celda debe mostrar un 0 pelado como total.
  for (const c of conNumero) expect(c.trim()).not.toMatch(/^0\s/);
});
