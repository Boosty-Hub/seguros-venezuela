import { test, expect } from "@playwright/test";
import { entrar, irAPipeline } from "./util";

// Panel de analítica: cajón flotante con tres pestañas.
//
// Lo que más importa comprobar acá no es que los gráficos "se vean", sino dos
// cosas que un typecheck no puede: que el panel FLOTE (no empuje el contenido,
// que es lo que hacía antes) y que los números de emisiones cuadren con lo que
// devuelve la función de la base.

test.beforeEach(async ({ page }) => {
  await entrar(page);
  await irAPipeline(page);
});

async function abrirPanel(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /^Analítica$/ }).click();
  const panel = page.getByRole("dialog", { name: /Analítica del pipeline/i });
  await expect(panel).toBeVisible();
  return panel;
}

test("el panel flota encima sin mover el contenido de detrás", async ({ page }) => {
  // Posición de un elemento de la página ANTES de abrir.
  const titulo = page.getByRole("heading", { name: /A dónde va cada ticket/i });
  const antes = await titulo.boundingBox();
  expect(antes).not.toBeNull();

  const panel = await abrirPanel(page);

  // El contenido no se ha desplazado ni encogido: eso es lo que distingue el
  // cajón flotante del panel en flujo que había antes.
  const despues = await titulo.boundingBox();
  expect(despues!.x).toBeCloseTo(antes!.x, 0);
  expect(despues!.width).toBeCloseTo(antes!.width, 0);

  // Y ocupa aproximadamente la mitad de la pantalla.
  const vp = page.viewportSize()!;
  const caja = await panel.boundingBox();
  expect(caja!.width).toBeGreaterThan(vp.width * 0.4);
  expect(caja!.width).toBeLessThan(vp.width * 0.75);
});

test("cierra con Escape y con clic en el fondo", async ({ page }) => {
  const panel = await abrirPanel(page);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  await abrirPanel(page);
  // Clic arriba a la izquierda, que es fondo seguro (el cajón está a la derecha).
  await page.mouse.click(80, 300);
  await expect(page.getByRole("dialog", { name: /Analítica del pipeline/i })).toBeHidden();
});

test("las tres pestañas cargan su contenido", async ({ page }) => {
  const panel = await abrirPanel(page);

  // Cotizaciones es la que abre por defecto.
  await expect(panel.getByText(/A dónde va cada cotización/i)).toBeVisible();
  await expect(panel.getByText(/Plan × edad/i)).toBeVisible();

  await panel.getByRole("button", { name: /^Emisiones$/ }).click();
  await expect(panel.getByText(/Cartera: dónde está el dinero/i)).toBeVisible();
  await expect(panel.getByText(/Suscripción por día/i)).toBeVisible();
  await expect(panel.getByText(/Quién emite el volumen/i)).toBeVisible();
  // La nota que explica por qué NO hay prima media por plan de pago.
  await expect(panel.getByText(/A propósito NO se muestra prima media por plan/i)).toBeVisible();
  // Y la que avisa de que el CSV no trae fecha ni motivo de anulación.
  await expect(panel.getByText(/no trae fecha ni motivo real de anulacion/i)).toBeVisible();

  await panel.getByRole("button", { name: /^Efectividad$/ }).click();
  await expect(panel.getByText(/De lo emitido, cuánto pasó por Zoho/i)).toBeVisible();
  await expect(panel.getByText(/Cuánto tarda una cotización en volverse póliza/i)).toBeVisible();

  // Volver a Cotizaciones no debe recargar ni vaciar nada.
  await panel.getByRole("button", { name: /^Cotizaciones$/ }).click();
  await expect(panel.getByText(/A dónde va cada cotización/i)).toBeVisible();
});

test("los totales de emisiones cuadran con la función de la base", async ({ page }) => {
  const panel = await abrirPanel(page);
  await panel.getByRole("button", { name: /^Emisiones$/ }).click();
  await expect(panel.getByText(/Cartera: dónde está el dinero/i)).toBeVisible();

  const api = await page.evaluate(async () => {
    const r = await fetch("/api/zoho/analitica", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ since: null }),
    });
    return await r.json();
  });

  const t = api.emisiones?.totales;
  expect(t).toBeTruthy();

  const texto = await panel.innerText();
  const fmt = (v: number) => new Intl.NumberFormat("es-VE").format(Math.round(v));

  // Pólizas, anuladas y prima facturada tienen que aparecer tal cual.
  expect(texto).toContain(fmt(t.polizas));
  expect(texto).toContain(fmt(t.anuladas));
  expect(texto).toContain(`$${fmt(t.prima_facturada)}`);
  expect(texto).toContain(`$${fmt(t.comision)}`);

  // La cartera tiene que sumar exactamente la prima facturada: si no, algún
  // recibo se está quedando fuera de los tres estatus.
  const suma = (api.emisiones.cartera as { prima: number }[]).reduce((a, c) => a + Number(c.prima), 0);
  expect(Math.abs(suma - Number(t.prima_facturada))).toBeLessThan(0.01);
});
