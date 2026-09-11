// Rango de fechas de /pipeline: traducción entre lo que el operador elige y
// lo que reciben las funciones de Postgres.
//
// Dos decisiones que importan y no son obvias:
//
// 1. ZONA HORARIA. Venezuela es UTC-4 todo el año (no hay horario de verano).
//    Si el corte se arma con `new Date("2026-09-10")` se interpreta como
//    medianoche UTC, que en Caracas son las 8 de la noche del día ANTERIOR:
//    filtrar "hoy" traería cuatro horas de ayer y perdería las últimas cuatro
//    de hoy. Por eso el offset va explícito en la cadena ISO.
//
// 2. INCLUSIVO ARRIBA. Para el operador "hasta el 10" incluye el 10 entero.
//    En SQL el corte es medio abierto (`>= desde` y `< hasta`), que es lo que
//    evita tener que pensar en horas: se manda el día SIGUIENTE a las 00:00.
//    Con `<=` sobre la fecha pelada se perdería todo lo del 10 después de la
//    medianoche, que es casi todo.

const OFFSET_VE = "-04:00";

/** `YYYY-MM-DD` → el mismo día a las 00:00 hora Venezuela, en ISO. */
function inicioDelDia(fecha: string): string {
  return `${fecha}T00:00:00${OFFSET_VE}`;
}

/** `YYYY-MM-DD` + n días, sin salirse del calendario. */
export function sumarDias(fecha: string, n: number): string {
  const [a, m, d] = fecha.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export type RangoISO = { desde: string | null; hasta: string | null };

/**
 * Convierte el rango de la URL (fechas inclusivas, `YYYY-MM-DD`) en los
 * timestamps que esperan las RPC. Una fecha inválida se ignora en vez de
 * romper la página: peor que un filtro que no aplica es una pantalla en blanco.
 */
export function rangoATimestamps(desde?: string | null, hasta?: string | null): RangoISO {
  const ok = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const d = ok(desde);
  const h = ok(hasta);
  return {
    desde: d ? inicioDelDia(d) : null,
    hasta: h ? inicioDelDia(sumarDias(h, 1)) : null,
  };
}

/** Texto para el encabezado: "del 1 al 30 de septiembre", "desde el 1 de…". */
export function describirRango(desde?: string | null, hasta?: string | null): string {
  const f = (s: string) =>
    new Date(`${s}T12:00:00Z`).toLocaleDateString("es-VE", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  if (desde && hasta) return `del ${f(desde)} al ${f(hasta)}`;
  if (desde) return `desde el ${f(desde)}`;
  if (hasta) return `hasta el ${f(hasta)}`;
  return "todo el histórico";
}
