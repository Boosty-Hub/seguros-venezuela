import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { entrar } from "./util";

// Ciclo completo de un documento de KB: subir → indexar → DESCARGAR EL
// ORIGINAL → borrar (0084).
//
// Lo que de verdad se comprueba acá es que el archivo original sobreviva al
// indexado. Antes se borraba en cuanto el documento entraba, y eso dejó dos
// flyers indexados con texto ilegible que NO se pueden reprocesar porque el
// PDF ya no existe en ningún sitio: la única salida es pedírselo al operador.
// Este test falla si volvemos a esa situación.
//
// Se limpia solo: crea SU documento y lo borra al final, sin tocar nada del
// negocio. El fixture es un PDF con capa de texto, así que va por el camino de
// parseo y no gasta tokens de visión.

const FIXTURE = resolve(__dirname, "fixtures/kb-mascotas-e2e.pdf");
const TITULO = "E2E Condicionado Mascotas (borrar)";

test("el original sobrevive al indexado, se descarga y se borra con el documento", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await entrar(page);
  await page.goto("/verticales");

  // La vertical de mascotas: el contenido del fixture encaja sin ambigüedad,
  // así que el juez de vertical no lo manda a revisión.
  const fila = page.getByRole("row").filter({ hasText: "mascotas" }).first();
  await expect(fila).toBeVisible({ timeout: 60_000 });
  await fila.getByText(/Ver \/ Editar/).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();

  // Si quedó un documento de una corrida anterior, se borra primero.
  const previo = modal.getByRole("row").filter({ hasText: TITULO });
  if (await previo.count()) {
    await previo.first().getByRole("button", { name: /^Borrar$/ }).click();
    await page.getByRole("button", { name: /^Borrar$/ }).last().click();
    await expect(modal.getByRole("row").filter({ hasText: TITULO })).toHaveCount(0, {
      timeout: 30_000,
    });
  }

  await modal.getByPlaceholder(/Título/).fill(TITULO);
  await modal.locator('input[type="file"]').setInputFiles(FIXTURE);
  await modal.getByRole("button", { name: /Indexar en esta vertical/i }).click();

  // El worker lo recoge por cron (cada minuto) o por la llamada directa. La
  // fila del documento aparece cuando ya está indexado de verdad.
  const fase = modal.getByRole("row").filter({ hasText: TITULO });
  await expect(fase).toHaveCount(1, { timeout: 180_000 });

  // ---- El original está guardado y se puede descargar ----
  const enlace = fase.getByRole("link", { name: /^original$/ });
  await expect(enlace).toBeVisible();

  const descarga = await Promise.all([
    page.waitForEvent("download"),
    enlace.click(),
  ]).then(([d]) => d);
  const ruta = await descarga.path();
  expect(ruta).not.toBeNull();
  // Byte a byte: no vale que devuelva "algo", tiene que ser EL archivo.
  const bajado = readFileSync(ruta!);
  const original = readFileSync(FIXTURE);
  expect(bajado.length).toBe(original.length);
  expect(bajado.equals(original)).toBe(true);

  // El texto extraído también se puede bajar, y no es el binario.
  const texto = await page.request.get(`/api/kb/document/${await idDeFila(fase)}`);
  expect(texto.ok()).toBe(true);
  expect(await texto.text()).toMatch(/mascotas/i);

  // ---- Borrar el documento se lleva el original ----
  await fase.getByRole("button", { name: /^Borrar$/ }).click();
  await page.getByRole("button", { name: /^Borrar$/ }).last().click();
  await expect(modal.getByRole("row").filter({ hasText: TITULO })).toHaveCount(0, {
    timeout: 30_000,
  });
  await limpiarJobs(page, modal);
});

/**
 * Borra las filas de cola que dejó el test. El documento se limpia por la UI,
 * pero el JOB queda como histórico y una fila por corrida acabaría siendo
 * ruido en una tabla de producción.
 *
 * El id de la vertical sale del DOM (`kb-file-<uuid>`, el input de archivo del
 * panel) porque `/api/verticales` no tiene GET.
 */
async function limpiarJobs(
  page: import("@playwright/test").Page,
  modal: import("@playwright/test").Locator
): Promise<void> {
  const inputId = await modal.locator('input[type="file"]').getAttribute("id");
  const verticalId = (inputId ?? "").replace("kb-file-", "");
  if (!verticalId) return;
  const r = await page.request.get(`/api/kb/jobs?vertical_id=${verticalId}`);
  if (!r.ok()) return;
  const { jobs } = (await r.json()) as { jobs: Array<{ id: string; title: string }> };
  for (const j of jobs.filter((x) => x.title === TITULO)) {
    await page.request.delete(`/api/kb/jobs/${j.id}`);
  }
}

/** Saca el id del documento del href del enlace de descarga de esa fila. */
async function idDeFila(fila: import("@playwright/test").Locator): Promise<string> {
  const href = await fila.getByRole("link", { name: /^original$/ }).getAttribute("href");
  return (href ?? "").replace("/api/kb/document/", "").replace("?original=1", "");
}

test("una vertical con documentos ilegibles lo avisa en la tabla y lo detalla dentro", async ({
  page,
}) => {
  // El aviso tiene que estar en la TABLA, no solo dentro del modal: si hay que
  // abrir cada vertical para enterarse, nadie se entera — que es exactamente
  // lo que pasó con "Flyer RCV" y "Flyer marcotas", indexados ilegibles y sin
  // que nada lo dijera en pantalla.
  await entrar(page);
  await page.goto("/verticales");
  await expect(page.getByRole("heading", { name: /^Verticales$/ })).toBeVisible({
    timeout: 60_000,
  });

  const conAviso = page
    .getByRole("row")
    .filter({ has: page.locator("span", { hasText: /⚠\s*\d+/ }) });
  const cuantas = await conAviso.count();
  // No se fija un número: lo que se comprueba es la COHERENCIA entre el badge
  // de la tabla y el detalle de dentro. Si algún día no queda ninguna vertical
  // con documentos malos, el test pasa sin afirmar nada falso.
  if (cuantas === 0) {
    await expect(page.locator("span", { hasText: /⚠\s*\d+\s*(ilegible|con ruido)/ })).toHaveCount(0);
    return;
  }

  const fila = conAviso.first();
  const badge = fila.locator("span", { hasText: /⚠\s*\d+/ }).first();
  const n = Number((await badge.innerText()).match(/\d+/)?.[0] ?? "0");
  expect(n).toBeGreaterThan(0);

  await fila.getByText(/Ver \/ Editar/).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();

  // Dentro, el detalle dice cuántos y por qué, y lo que hay que hacer.
  // Singular "quedó" / plural "quedaron": el primer intento de este test usaba
  // /quedaron?/ y no macheaba el singular, que es el caso de hoy.
  const detalle = modal.getByText(/de esta vertical qued(ó|aron) mal indexad/i);
  await expect(detalle).toBeVisible();
  await expect(modal.getByText(/vuelve a subirlo|volver a subirlo|reprocesar/i).first()).toBeVisible();

  // Y la tabla de documentos marca CUÁL, con el mismo recuento que el badge.
  const marcados = modal.locator("td span", {
    hasText: /^(ilegible|con ruido|sin contenido)$/,
  });
  expect(await marcados.count()).toBe(n);
});

test("reprocesar sustituye el documento sin perder el original ni dejar hueco", async ({
  page,
}) => {
  // El reproceso es lo que hace útil el original guardado (0085). Lo que se
  // comprueba es lo que puede salir mal en silencio:
  //   * que el viejo se borre ANTES de tiempo y la vertical se quede sin él,
  //   * que acaben DOS documentos (el viejo y el nuevo) sirviendo al agente,
  //   * que el archivo se borre con el viejo y el nuevo quede sin original.
  test.setTimeout(300_000);
  await entrar(page);
  await page.goto("/verticales");

  const fila = page.getByRole("row").filter({ hasText: "mascotas" }).first();
  await expect(fila).toBeVisible({ timeout: 60_000 });
  await fila.getByText(/Ver \/ Editar/).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();

  const previo = modal.getByRole("row").filter({ hasText: TITULO });
  if (await previo.count()) {
    await previo.first().getByRole("button", { name: /^Borrar$/ }).click();
    await page.getByRole("button", { name: /^Borrar$/ }).last().click();
    await expect(modal.getByRole("row").filter({ hasText: TITULO })).toHaveCount(0, { timeout: 30_000 });
  }

  // Se sube una vez para tener algo que reprocesar.
  await modal.getByPlaceholder(/Título/).fill(TITULO);
  await modal.locator('input[type="file"]').setInputFiles(FIXTURE);
  await modal.getByRole("button", { name: /Indexar en esta vertical/i }).click();
  const doc = modal.getByRole("row").filter({ hasText: TITULO });
  await expect(doc).toHaveCount(1, { timeout: 180_000 });
  const idViejo = await idDeFila(doc);

  // ---- Reprocesar ----
  await doc.getByRole("button", { name: /^Reprocesar$/ }).click();

  // Mientras dura, el documento viejo SIGUE ahí: la vertical no se queda sin
  // él. Y no puede haber dos filas con el mismo título.
  await expect(doc).toHaveCount(1);

  // Al terminar hay UNA fila, con un id DISTINTO: se sustituyó, no se duplicó.
  await expect
    .poll(async () => idDeFila(modal.getByRole("row").filter({ hasText: TITULO })).catch(() => idViejo), {
      timeout: 240_000,
      intervals: [4000],
    })
    .not.toBe(idViejo);
  await expect(modal.getByRole("row").filter({ hasText: TITULO })).toHaveCount(1);

  // El nuevo conserva el original y se descarga igual que el anterior.
  const nuevo = modal.getByRole("row").filter({ hasText: TITULO });
  await expect(nuevo.getByRole("link", { name: /^original$/ })).toBeVisible();
  const descarga = await Promise.all([
    page.waitForEvent("download"),
    nuevo.getByRole("link", { name: /^original$/ }).click(),
  ]).then(([d]) => d);
  const bajado = readFileSync((await descarga.path())!);
  expect(bajado.equals(readFileSync(FIXTURE))).toBe(true);

  // Y el viejo ya no existe.
  const viejo = await page.request.get(`/api/kb/document/${idViejo}`);
  expect(viejo.status()).toBe(404);

  // Limpieza.
  await nuevo.getByRole("button", { name: /^Borrar$/ }).click();
  await page.getByRole("button", { name: /^Borrar$/ }).last().click();
  await expect(modal.getByRole("row").filter({ hasText: TITULO })).toHaveCount(0, { timeout: 30_000 });
  await limpiarJobs(page, modal);
});
