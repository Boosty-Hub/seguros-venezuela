// Parser del "Reporte Emisión" que entrega el sistema central de pólizas.
//
// Trampas del archivo real (medidas sobre el de agosto 2026, 655 filas):
//
//  1. Viene en ISO-8859-1, NO en UTF-8. Leerlo como UTF-8 convierte
//     "Motivo_Anulación" y "Teléfono_Asegurado" en basura y la cabecera deja
//     de reconocerse. Se detecta y se decodifica con el juego correcto.
//  2. El delimitador es `;` (la coma es el separador DECIMAL: "86,57").
//  3. Las fechas son d/m/yyyy — "1/8/2026" es el 1 de agosto, no el 8 de
//     enero. Se convierten a ISO acá y nunca se dejan a que las interprete
//     Postgres, que depende de su DateStyle.
//  4. El grano es el RECIBO, no la póliza: 655 filas son 539 pólizas, porque
//     una póliza puede tener varias cuotas del mismo asegurado. `Recibo` es
//     único y es la clave primaria.
//  5. `Certificado` vale 0 en todas las filas: no sirve como clave.
//  6. Hay DOS cédulas por fila (tomador = quien paga, asegurado = quien está
//     cubierto) y a menudo son personas distintas. Las dos se guardan en
//     versión "solo dígitos" porque es así como se cruzan contra la cédula
//     que `zoho_cedula()` extrae del asunto del ticket.

export type FilaEmision = {
  recibo: string;
  nu_poliza: string;
  estatus: string | null;
  estatus_recibo: string | null;
  motivo_anulacion: string | null;
  sucursal: string | null;
  ramo: string | null;
  desc_ramo: string | null;
  producto: string | null;
  desc_producto: string | null;
  ci_tomador: string | null;
  ci_tomador_digitos: string | null;
  nombre_tomador: string | null;
  ci_asegurado: string | null;
  ci_asegurado_digitos: string | null;
  nombre_asegurado: string | null;
  correo_asegurado: string | null;
  telefono_asegurado: string | null;
  ciudad: string | null;
  canal_ventas: string | null;
  canal_negocio: string | null;
  cod_intermediario: string | null;
  nombre_intermediario: string | null;
  nombre_supervisor: string | null;
  clasificacion: string | null;
  plan_poliza: string | null;
  suma_asegurada: number | null;
  cant_titulares: number | null;
  cant_beneficiarios: number | null;
  moneda: string | null;
  prima_anual: number | null;
  prima_recibo: number | null;
  comision: number | null;
  plan_pago: string | null;
  tipo_facturacion: string | null;
  fecha_suscripcion: string | null;
  fecha_desde: string | null;
  fecha_hasta: string | null;
  fecha_emision_recibo: string | null;
  fecha_desde_recibo: string | null;
  fecha_hasta_recibo: string | null;
  usuario_emision: string | null;
  desc_usuario_emision: string | null;
};

export type ResultadoParse = {
  filas: FilaEmision[];
  errores: string[];
  avisos: string[];
  columnasDesconocidas: string[];
};

/** Columnas que el cruce necesita. Si falta una, el archivo no sirve. */
const REQUERIDAS = [
  "Nu_Poliza",
  "Recibo",
  "Estatus",
  "CI/RIF_Tomador",
  "CI/RIF_Asegurado",
  "Cod_Intermediario",
  "Nombre_Intemediairo", // el typo viene del sistema central; se respeta tal cual
  "Fecha_Suscripcion_Póliza",
];

/**
 * Decodifica el buffer probando UTF-8 primero. Si aparece el carácter de
 * reemplazo (U+FFFD), el archivo no era UTF-8 válido y se reintenta como
 * ISO-8859-1, que es lo que exporta el sistema central.
 */
export function decodificar(buf: ArrayBuffer): { texto: string; juego: string } {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!utf8.includes("�")) return { texto: utf8, juego: "utf-8" };
  return {
    texto: new TextDecoder("iso-8859-1").decode(buf),
    juego: "iso-8859-1",
  };
}

/** "86,57" -> 86.57 · "" -> null. La coma es el separador decimal. */
function num(v: string | undefined): number | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  // No se contemplan puntos de miles porque el archivo no los trae (verificado);
  // si algún día aparecen, un "1.234,56" daría NaN y se descarta como null en
  // vez de guardar un número equivocado.
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function entero(v: string | undefined): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function texto(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

/** d/m/yyyy -> yyyy-mm-dd. Devuelve null si no encaja (no inventa fechas). */
export function fechaISO(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mes, a] = m;
  const dd = Number(d);
  const mm = Number(mes);
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return `${a}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Deja solo dígitos: "V-31225946" -> "31225946". Es la clave de cruce. */
export function soloDigitos(v: string | undefined): string | null {
  const s = (v ?? "").replace(/[^0-9]/g, "");
  return s ? s : null;
}

export function parseEmisiones(buf: ArrayBuffer): ResultadoParse & { juego: string } {
  const { texto: contenido, juego } = decodificar(buf);
  const errores: string[] = [];
  const avisos: string[] = [];

  const lineas = contenido.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lineas.length < 2) {
    return { filas: [], errores: ["El archivo está vacío o no tiene filas de datos."], avisos, columnasDesconocidas: [], juego };
  }

  // BOM al inicio: rompe el nombre de la primera columna si no se quita.
  const cabecera = lineas[0].replace(/^﻿/, "").split(";").map((h) => h.trim());

  if (cabecera.length < 10) {
    errores.push(
      `La cabecera tiene ${cabecera.length} columna(s). Se esperaba un CSV separado por ";" — ` +
        `revisa que no se haya guardado con otro delimitador.`
    );
    return { filas: [], errores, avisos, columnasDesconocidas: [], juego };
  }

  const idx = new Map(cabecera.map((h, i) => [h, i]));
  const faltan = REQUERIDAS.filter((c) => !idx.has(c));
  if (faltan.length) {
    errores.push(`Faltan columnas obligatorias: ${faltan.join(", ")}.`);
    return { filas: [], errores, avisos, columnasDesconocidas: [], juego };
  }

  const CONOCIDAS = new Set([
    "Nu_Poliza", "Cantidad_Poliza", "Estatus", "Sucursal", "Ramo", "Desc_Ramo", "Producto",
    "Desc_Producto", "Certificado", "Recibo", "Estatus_Recibo", "Motivo_Anulación",
    "CI/RIF_Tomador", "Nombre_Tomador", "CI/RIF_Asegurado", "Nombre_Asegurado",
    "Correo_Asegurado", "Teléfono_Asegurado", "Ciudad", "Canal_Ventas", "Canal_Negocio",
    "Cod_Intermediario", "Nombre_Intemediairo", "Nombre_Supervisor", "CD_Sponsor", "Sponsor",
    "Clasificación", "Plan", "Suma_Asegurada", "CantTitulares", "CantBeneficiarios", "Moneda",
    "Prima_Anual", "Tasa_FeDesde", "Prima_Recibo", "Tasa_FeCobro", "Total_Devoluciones",
    "Plan_Pago", "Tipo_Facturación", "Comisión", "Fecha_Suscripcion_Póliza",
    "Fecha_Desde_Póliza", "Fecha_Hasta_Póliza", "Fecha_Emisión_Recibo", "Fecha_Desde_Recibo",
    "Fecha_Hasta_Recibo", "Usuario_Emisión", "Desc_Usuario_Emisión", "Placa", "Marca",
    "Modelo", "Versión", "Año",
  ]);
  const columnasDesconocidas = cabecera.filter((h) => h && !CONOCIDAS.has(h));

  const g = (celdas: string[], nombre: string) => {
    const i = idx.get(nombre);
    return i === undefined ? undefined : celdas[i];
  };

  const filas: FilaEmision[] = [];
  const vistos = new Set<string>();
  let sinRecibo = 0;
  let duplicadosEnArchivo = 0;

  for (let n = 1; n < lineas.length; n++) {
    const linea = lineas[n];
    if (!linea.trim()) continue;
    const c = linea.split(";");

    const recibo = texto(g(c, "Recibo"));
    const nu_poliza = texto(g(c, "Nu_Poliza"));
    if (!recibo || !nu_poliza) {
      sinRecibo++;
      continue;
    }
    // Un recibo repetido DENTRO del archivo: se queda el primero. Sin esto el
    // upsert falla entero por "ON CONFLICT DO UPDATE command cannot affect row
    // a second time" y no carga nada.
    if (vistos.has(recibo)) {
      duplicadosEnArchivo++;
      continue;
    }
    vistos.add(recibo);

    filas.push({
      recibo,
      nu_poliza,
      estatus: texto(g(c, "Estatus")),
      estatus_recibo: texto(g(c, "Estatus_Recibo")),
      motivo_anulacion: texto(g(c, "Motivo_Anulación")),
      sucursal: texto(g(c, "Sucursal")),
      ramo: texto(g(c, "Ramo")),
      desc_ramo: texto(g(c, "Desc_Ramo")),
      producto: texto(g(c, "Producto")),
      desc_producto: texto(g(c, "Desc_Producto")),
      ci_tomador: texto(g(c, "CI/RIF_Tomador")),
      ci_tomador_digitos: soloDigitos(g(c, "CI/RIF_Tomador")),
      nombre_tomador: texto(g(c, "Nombre_Tomador")),
      ci_asegurado: texto(g(c, "CI/RIF_Asegurado")),
      ci_asegurado_digitos: soloDigitos(g(c, "CI/RIF_Asegurado")),
      nombre_asegurado: texto(g(c, "Nombre_Asegurado")),
      correo_asegurado: texto(g(c, "Correo_Asegurado"))?.toLowerCase() ?? null,
      telefono_asegurado: texto(g(c, "Teléfono_Asegurado")),
      ciudad: texto(g(c, "Ciudad")),
      canal_ventas: texto(g(c, "Canal_Ventas")),
      canal_negocio: texto(g(c, "Canal_Negocio")),
      cod_intermediario: texto(g(c, "Cod_Intermediario")),
      nombre_intermediario: texto(g(c, "Nombre_Intemediairo")),
      nombre_supervisor: texto(g(c, "Nombre_Supervisor")),
      clasificacion: texto(g(c, "Clasificación")),
      plan_poliza: texto(g(c, "Plan")),
      suma_asegurada: num(g(c, "Suma_Asegurada")),
      cant_titulares: entero(g(c, "CantTitulares")),
      cant_beneficiarios: entero(g(c, "CantBeneficiarios")),
      moneda: texto(g(c, "Moneda")),
      prima_anual: num(g(c, "Prima_Anual")),
      prima_recibo: num(g(c, "Prima_Recibo")),
      comision: num(g(c, "Comisión")),
      plan_pago: texto(g(c, "Plan_Pago")),
      tipo_facturacion: texto(g(c, "Tipo_Facturación")),
      fecha_suscripcion: fechaISO(g(c, "Fecha_Suscripcion_Póliza")),
      // La cabecera real trae espacios de sobra en "Fecha_Desde_Póliza  ";
      // el trim de la cabecera ya los quitó, pero se deja el fallback por si
      // el sistema central cambia el padding.
      fecha_desde: fechaISO(g(c, "Fecha_Desde_Póliza")),
      fecha_hasta: fechaISO(g(c, "Fecha_Hasta_Póliza")),
      fecha_emision_recibo: fechaISO(g(c, "Fecha_Emisión_Recibo")),
      fecha_desde_recibo: fechaISO(g(c, "Fecha_Desde_Recibo")),
      fecha_hasta_recibo: fechaISO(g(c, "Fecha_Hasta_Recibo")),
      usuario_emision: texto(g(c, "Usuario_Emisión")),
      desc_usuario_emision: texto(g(c, "Desc_Usuario_Emisión")),
    });
  }

  if (sinRecibo) avisos.push(`${sinRecibo} fila(s) sin Recibo o sin Nu_Poliza: se omiten.`);
  if (duplicadosEnArchivo)
    avisos.push(`${duplicadosEnArchivo} recibo(s) repetidos dentro del archivo: se queda el primero.`);
  if (columnasDesconocidas.length)
    avisos.push(`Columnas nuevas que no se guardan: ${columnasDesconocidas.join(", ")}.`);
  if (!filas.length) errores.push("No se pudo leer ninguna fila válida.");

  return { filas, errores, avisos, columnasDesconocidas, juego };
}

/** Resumen a grano póliza, que es como se cuenta el negocio. */
export function resumir(filas: FilaEmision[]) {
  const porPoliza = new Map<string, FilaEmision>();
  for (const f of filas) if (!porPoliza.has(f.nu_poliza)) porPoliza.set(f.nu_poliza, f);
  const polizas = Array.from(porPoliza.values());

  const fechas = filas.map((f) => f.fecha_suscripcion).filter((d): d is string => !!d).sort();
  const intermediarios = new Map<string, string>();
  for (const f of filas) {
    if (f.cod_intermediario && !intermediarios.has(f.cod_intermediario)) {
      intermediarios.set(f.cod_intermediario, f.nombre_intermediario ?? f.cod_intermediario);
    }
  }

  return {
    recibos: filas.length,
    polizas: polizas.length,
    vigentes: polizas.filter((p) => p.estatus === "Vigente").length,
    anuladas: polizas.filter((p) => p.estatus === "Anulada").length,
    otro_estatus: polizas.filter((p) => p.estatus !== "Vigente" && p.estatus !== "Anulada").length,
    periodo_desde: fechas[0] ?? null,
    periodo_hasta: fechas[fechas.length - 1] ?? null,
    sin_fecha: filas.filter((f) => !f.fecha_suscripcion).length,
    intermediarios: Array.from(intermediarios).map(([cod, nombre]) => ({ cod, nombre })),
    ramos: Array.from(new Set(filas.map((f) => f.desc_ramo).filter(Boolean))) as string[],
  };
}
