import { test, expect } from "@playwright/test";
import { entrar } from "./util";

// Contador de mensajes en la lista de conversaciones del /inbox.
//
// Cuenta cliente + agente. El detalle importa: `messages` solo guarda los
// entrantes, y lo que respondió el agente vive en `drafts` — solo los
// `auto_sent`, porque un `failed` nunca llegó al cliente.
//
// La verificación no es "sale un número": es que el total de cada fila sea la
// suma de sus dos partes, y que el orden por mensajes use el total.

test.beforeEach(async ({ page }) => {
  await entrar(page);
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: /^Inbox$/ })).toBeVisible({ timeout: 60_000 });
});

/** Lee los contadores de la lista con su desglose (que va en el title). */
async function contadores(page: import("@playwright/test").Page) {
  return await page.evaluate(() => {
    const out: { total: number; cliente: number; agente: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("span[title*='mensajes en total']"))) {
      const t = el.getAttribute("title") ?? "";
      const m = t.match(/^(\d+) mensajes en total: (\d+) del cliente y (\d+) del agente$/);
      if (m) out.push({ total: Number(m[1]), cliente: Number(m[2]), agente: Number(m[3]) });
    }
    return out;
  });
}

test("cada fila muestra el total y cuadra con su desglose", async ({ page }) => {
  const filas = await contadores(page);
  expect(filas.length).toBeGreaterThan(0);

  for (const f of filas) {
    // El total tiene que ser exactamente cliente + agente.
    expect(f.total).toBe(f.cliente + f.agente);
    // Toda conversación de la lista tiene al menos un mensaje del cliente: la
    // consulta usa `messages!inner`, así que un lead sin entrantes no aparece.
    expect(f.cliente).toBeGreaterThan(0);
    expect(f.agente).toBeGreaterThanOrEqual(0);
  }

  // Y el número visible es el total, no solo los del cliente.
  const visibles = await page
    .locator("span[title*='mensajes en total']")
    .allInnerTexts();
  expect(visibles.map((v) => Number(v.trim()))).toEqual(filas.map((f) => f.total));
});

test("hay conversaciones con respuestas del agente contadas", async ({ page }) => {
  // Si TODAS salieran con agente=0, el contador estaría ignorando los drafts
  // (que es justo el bug que este contador viene a evitar).
  const filas = await contadores(page);
  const conAgente = filas.filter((f) => f.agente > 0);
  expect(conAgente.length).toBeGreaterThan(0);
});

test("ordenar por mensajes usa el total", async ({ page }) => {
  // El <select> de orden se identifica por su opción por defecto; el filtro
  // navega (cambia el query string), así que hay que esperar a la URL.
  const orden = page.locator("select").filter({ hasText: "Orden: más recientes" }).first();
  await orden.selectOption("messages");
  await page.waitForURL(/sort=messages/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /^Inbox$/ })).toBeVisible();

  const filas = await contadores(page);
  test.skip(filas.length < 2, "hacen falta al menos dos conversaciones para comprobar el orden");
  const totales = filas.map((f) => f.total);
  expect(totales).toEqual([...totales].sort((a, b) => b - a));
});
