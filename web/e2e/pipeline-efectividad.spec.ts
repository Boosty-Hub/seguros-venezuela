import { test, expect } from "@playwright/test";
import { entrar, irAPipeline } from "./util";

// Verificación end-to-end del módulo de efectividad de corredores.
//
// Se comprueban las cosas que un typecheck NO puede: que la página renderice
// con datos reales, que los números que salen en pantalla cuadren con los que
// devuelve la función de la base, y que el aviso de parcialidad esté visible
// (es lo único que evita que un 4,8% se lea como el desempeño real).

test.beforeEach(async ({ page }) => {
  await entrar(page);
});

test("la sección de efectividad renderiza con los datos cargados", async ({ page }) => {
  await irAPipeline(page);

  // Las cuatro tarjetas de cabecera.
  await expect(page.getByText("Efectividad por cotizaciones")).toBeVisible();
  await expect(page.getByText("Efectividad por clientes")).toBeVisible();
  await expect(page.getByText("Pólizas emitidas cargadas")).toBeVisible();
  await expect(page.getByText("Emitidas que sí cotizaron")).toBeVisible();

  // Los porcentajes tienen que ser un número, no "—": si salen vacíos es que
  // el cruce no encontró nada y el módulo estaría mintiendo por omisión.
  const cuerpo = await page.locator("body").innerText();
  expect(cuerpo).toMatch(/Efectividad por cotizaciones[\s\S]{0,40}\d+([.,]\d+)?%/);
  expect(cuerpo).toMatch(/Efectividad por clientes[\s\S]{0,40}\d+([.,]\d+)?%/);
});

test("el aviso de que los porcentajes son un suelo está visible", async ({ page }) => {
  await irAPipeline(page);

  // Este aviso no es decorativo: sin él, 4,8% se lee como el desempeño real
  // de los corredores en vez de como el mínimo observable con un mes de datos.
  const aviso = page.getByText(/son un suelo, no la cifra final/i);
  await expect(aviso).toBeVisible();
  await expect(page.getByText(/Porcentaje parcial: solo hay emisiones de/i)).toBeVisible();
});

test("los números de la página cuadran con la función de la base", async ({ page }) => {
  // Se pide la misma verdad por la API y se compara con lo pintado, para que
  // un bug de formateo en el front no pase inadvertido.
  await irAPipeline(page);

  const datos = await page.evaluate(async () => {
    const r = await fetch("/api/pipeline/alias?vista=pendientes&limite=1");
    return { ok: r.ok, json: await r.json() };
  });
  expect(datos.ok).toBe(true);
  expect(typeof datos.json.total).toBe("number");

  // El total de "sin ligar" que reporta la API tiene que ser el mismo número
  // que el botón de revisión muestra entre paréntesis.
  const boton = page.getByRole("button", { name: /Revisar corredores/i });
  await expect(boton).toBeVisible();
  const texto = (await boton.innerText()).replace(/\./g, "");
  const enBoton = Number(texto.match(/\((\d+)\)/)?.[1] ?? "-1");
  expect(enBoton).toBe(datos.json.total);
});

test("la tabla de efectividad ordena, filtra y despliega el detalle", async ({ page }) => {
  await irAPipeline(page);

  const tabla = page.locator("table").filter({ hasText: "Efec. cotiz." });
  await expect(tabla).toBeVisible();

  // Por defecto solo se ven los corredores con emisiones: si no, 896 filas con
  // "—" sepultarían a los que sí tienen datos.
  const filtro = page.getByLabel(/Solo con emisiones cargadas/i);
  await expect(filtro).toBeChecked();

  const filasIniciales = await tabla.locator("tbody tr").count();
  expect(filasIniciales).toBeGreaterThan(0);

  // Buscar por un corredor que sabemos que existe y tiene 12 variantes en Zoho.
  await page.getByPlaceholder("Buscar corredor…").fill("BARECA");
  await expect(tabla.getByText(/BARECA/i).first()).toBeVisible();
  await expect(tabla.getByText(/12 variantes/i)).toBeVisible();

  // Desplegar la fila muestra el desglose que explica el porcentaje.
  await tabla.locator("tbody tr").first().click();
  await expect(page.getByText(/Pólizas que venían de una cotización/i)).toBeVisible();
  await expect(page.getByText(/Vigentes \/ anuladas/i)).toBeVisible();
  await expect(page.getByText(/Código en el sistema central/i)).toBeVisible();

  // Quitar el filtro tiene que traer muchas más filas (los sin mapear).
  await page.getByPlaceholder("Buscar corredor…").fill("");
  await filtro.uncheck();
  await expect
    .poll(async () => tabla.locator("tbody tr").count(), { timeout: 15_000 })
    .toBeGreaterThan(filasIniciales);
});

test("ordenar por efectividad deja los sin datos al final", async ({ page }) => {
  await irAPipeline(page);
  const tabla = page.locator("table").filter({ hasText: "Efec. cotiz." });

  await tabla.getByRole("button", { name: /Efec\. cotiz\./i }).click();

  const celdas = await tabla.locator("tbody tr td:nth-child(6)").allInnerTexts();
  const numeros = celdas.map((c) => {
    const m = c.match(/([\d.,]+)%/);
    return m ? Number(m[1].replace(",", ".")) : null;
  });

  // Descendente: los null ("—") van al final, y los números no suben.
  const soloNumeros = numeros.filter((n): n is number => n !== null);
  const ordenado = [...soloNumeros].sort((a, b) => b - a);
  expect(soloNumeros).toEqual(ordenado);

  const primerNull = numeros.indexOf(null);
  if (primerNull !== -1) {
    expect(numeros.slice(primerNull).every((n) => n === null)).toBe(true);
  }
});
