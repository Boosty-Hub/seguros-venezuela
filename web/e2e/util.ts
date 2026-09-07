import { expect, type Page } from "@playwright/test";

// Utilidades compartidas de los tests e2e.
//
// Los tests corren contra el Supabase REAL (no hay entorno de staging), con un
// usuario de prueba de rol `editor`. Eso obliga a dos cosas:
//   * Nunca borrar ni modificar datos de negocio: los tests solo leen, y los
//     que escriben lo hacen con operaciones idempotentes (recargar el mismo
//     Reporte de Emisión actualiza los mismos recibos, no crea otros).
//   * Un solo worker (ver playwright.config.ts).

export function credenciales(): { email: string; password: string } {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Faltan E2E_EMAIL / E2E_PASSWORD en web/.env.local. Se crean con el script " +
        "de alta del usuario de prueba (ver BITACORA, sección de tests e2e)."
    );
  }
  return { email, password };
}

/** Entra con el usuario de prueba y espera a estar dentro del dashboard. */
export async function entrar(page: Page): Promise<void> {
  const { email, password } = credenciales();
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  // El botón dice "Entrar"; "Iniciar sesión" es el subtítulo del formulario.
  await page.getByRole("button", { name: /^entrar$/i }).click();
  // El login redirige a /inbox. Se espera la URL y no un texto concreto para
  // no atarse al contenido del inbox, que cambia con las conversaciones.
  await page.waitForURL(/\/(inbox|pipeline)/, { timeout: 60_000 });
}

/** Abre /pipeline en la pestaña B2C/B2B y espera a que pinte la efectividad. */
export async function irAPipeline(page: Page): Promise<void> {
  await page.goto("/pipeline");
  await expect(
    page.getByRole("heading", { name: /Efectividad: de lo cotizado/i })
  ).toBeVisible({ timeout: 60_000 });
}

/**
 * Lee el número de una StatCard por su etiqueta. Devuelve el texto crudo
 * porque unas traen porcentaje y otras un entero formateado.
 */
export async function valorTarjeta(page: Page, etiqueta: string | RegExp): Promise<string> {
  const tarjeta = page.locator("div").filter({ hasText: etiqueta }).last();
  await expect(tarjeta).toBeVisible();
  return (await tarjeta.innerText()).trim();
}
