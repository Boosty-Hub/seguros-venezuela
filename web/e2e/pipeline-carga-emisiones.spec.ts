import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { entrar, irAPipeline } from "./util";

// Carga del Reporte de Emisión, verificada por la interfaz.
//
// IMPORTANTE — por qué el fixture es sintético: este repo es PÚBLICO y el
// archivo real trae cédulas, nombres, teléfonos y correos de personas reales.
// `e2e/fixtures/emision-sintetica.CSV` reproduce la cabecera exacta del
// original (53 columnas, ";", ISO-8859-1, fechas d/m/yyyy) con 4 recibos
// inventados, cédulas 999000xx y correo @example.invalid.
//
// Y por qué solo se prueba el PREVIEW con ese fixture: confirmar escribiría
// pólizas falsas en la base de producción. El preview no escribe nada, así que
// recorre parser, detección de encoding, conteo a grano póliza y cruce contra
// Zoho sin efectos. La rama de confirmar se prueba con el archivo REAL, que es
// idempotente (los mismos recibos se actualizan, no se duplican), y solo si la
// máquina lo tiene: se salta en cualquier otro sitio.

const FIXTURE = resolve(__dirname, "fixtures/emision-sintetica.CSV");
const REAL = process.env.E2E_CSV_REAL ?? "";

test.beforeEach(async ({ page }) => {
  await entrar(page);
  await irAPipeline(page);
});

test("el preview lee el CSV sintético sin escribir nada", async ({ page }) => {
  await page.getByRole("button", { name: /Cargar emisiones/i }).click();

  const modal = page.getByRole("dialog");
  await expect(modal.getByText(/Cargar Reporte de Emisión/i)).toBeVisible();
  // La cabecera del modal dice qué periodo hay cargado ya.
  await expect(modal.getByText(/cargado hasta ahora/i)).toBeVisible();

  await modal.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(modal.getByText(/emision-sintetica\.CSV/i)).toBeVisible();

  await modal.getByRole("button", { name: /Ver qué se va a cargar/i }).click();

  // Se comprueba sobre el texto completo del modal en vez de con localizadores
  // por texto: "4 recibos" aparece también en el botón de confirmar y un
  // getByText suelto choca con el strict mode de Playwright.
  await expect(modal.getByText(/leído como iso-8859-1/i)).toBeVisible();
  const texto = await modal.innerText();

  // 4 recibos que son 3 pólizas: es la trampa del grano del archivo. Si el
  // preview dijera 4 pólizas, estaría contando filas e inflando el resultado.
  expect(texto).toMatch(/PÓLIZAS\s*\n\s*3\s*\n\s*4 recibos/i);
  // 2 vigentes / 1 anulada.
  expect(texto).toMatch(/VIGENTES\s*\n\s*2\s*\n\s*1 anuladas/i);
  // Los intermediarios inventados salen como nuevos.
  expect(texto).toMatch(/CORRETAJE DE PRUEBA E2E CA/i);
  expect(texto).toMatch(/AGENTE PRUEBA E2E/i);
  // Las cédulas inventadas no existen en Zoho: ninguna fila debe cruzar.
  expect(texto).toMatch(/Cruzan con Zoho\s*\n\s*0\s*\n\s*de 3 pólizas/i);
  expect(texto).toMatch(/sin cotización/i);
  // Las fechas d/m/yyyy se interpretaron como agosto, no como día 8 del mes.
  // El locale es-VE abrevia el mes con punto ("05 ago. 2026"), de ahi el \.?
  expect(texto).toMatch(/ago\.? 2026/i);
  // Y el periodo detectado es el del fixture: del 5 al 20 de agosto.
  expect(texto).toMatch(/Periodo del archivo:\s*05 ago\.? 2026\s*a\s*20 ago\.? 2026/i);

  // Cancelar: nada de esto tiene que haber llegado a la base.
  await modal.getByRole("button", { name: /^Cancelar$/i }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  const quedo = await page.evaluate(async () => {
    const r = await fetch("/api/pipeline/alias?vista=intermediarios&q=PRUEBA%20E2E&limite=10");
    return await r.json();
  });
  expect(quedo.intermediarios).toEqual([]);
});

test("un archivo que no es el reporte se rechaza con un mensaje claro", async ({ page }) => {
  await page.getByRole("button", { name: /Cargar emisiones/i }).click();
  const modal = page.getByRole("dialog");

  // Un CSV con cabecera que no es la del reporte.
  await modal.locator('input[type="file"]').setInputFiles({
    name: "cualquier-cosa.CSV",
    mimeType: "text/csv",
    buffer: Buffer.from("uno,dos,tres\n1,2,3\n", "utf8"),
  });
  await modal.getByRole("button", { name: /Ver qué se va a cargar/i }).click();

  // Debe explicar el problema, no explotar en silencio.
  await expect(modal.getByText(/separado por ";"|Faltan columnas obligatorias/i)).toBeVisible();
});

test("recargar el archivo real actualiza en vez de duplicar", async ({ page }) => {
  test.skip(!REAL || !existsSync(REAL), "Define E2E_CSV_REAL con la ruta al Reporte de Emisión real.");

  await page.getByRole("button", { name: /Cargar emisiones/i }).click();
  const modal = page.getByRole("dialog");
  await modal.locator('input[type="file"]').setInputFiles(REAL);
  await modal.getByRole("button", { name: /Ver qué se va a cargar/i }).click();

  // Ya está cargado, así que el preview tiene que avisar de que no hay nada
  // nuevo. Esta es la garantía de idempotencia que pedía el operador: subir el
  // mismo mes otra vez no puede duplicar nada.
  await expect(modal.getByText(/Ningún recibo es nuevo: este archivo ya está cargado/i)).toBeVisible();
  await expect(modal.getByText(/539/).first()).toBeVisible();

  await modal.getByRole("button", { name: /Confirmar y cargar/i }).click();
  await expect(modal.getByText(/^Cargado:/i)).toBeVisible({ timeout: 60_000 });
  await expect(modal.getByText(/0 nuevos/i)).toBeVisible();
  await expect(modal.getByText(/Mapeo automático de corredores/i)).toBeVisible();

  await modal.getByRole("button", { name: /^Listo$/i }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // Tras cerrar, la vista se refresca y el total de pólizas sigue siendo 539.
  await expect(page.getByText("Pólizas emitidas cargadas")).toBeVisible();
  const cuerpo = await page.locator("body").innerText();
  expect(cuerpo).toMatch(/539/);
});
