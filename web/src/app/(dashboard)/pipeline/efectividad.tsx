"use client";

import { Fragment, useMemo, useState } from "react";

// Efectividad por corredor: de lo que cotizó, cuánto acabó en póliza emitida.
//
// Esta tabla agrupa por el corredor CANÓNICO (el Cod_Intermediario del sistema
// central), no por el texto que se escribió en Zoho. Es la diferencia entre
// leer 1.163 "corredores" y leer los reales: un mismo corredor aparece en Zoho
// hasta de 12 formas distintas ("BARECA", "BARECA SC", "BARECA SOCIEDAD DE
// CORETAJE" con typo...). Al desplegar una fila se ven todas sus escrituras.
//
// Los porcentajes pueden venir en null y entonces se muestran "—". No es lo
// mismo que 0%: null significa que ese corredor no tiene cotizaciones dentro de
// la ventana observable, así que no hay nada que juzgar. Pintar 0% ahí sería
// acusar de no cerrar a quien simplemente no tiene datos comparables.

export type CorredorEfec = {
  clave: string;
  cod_intermediario: string | null;
  nombre: string;
  mapeado: boolean;
  alias_n: number;
  cotizaciones: number;
  clientes: number;
  cotiz_en_ventana: number;
  clientes_en_ventana: number;
  cotiz_en_curso: number;
  cotiz_cerradas: number;
  clientes_cerrados: number;
  cotiz_anuladas: number;
  cerradas_otro: number;
  polizas_emitidas: number;
  polizas_vigentes: number;
  polizas_anuladas: number;
  polizas_con_cotizacion: number;
  polizas_sin_cotizacion: number;
  efec_cotizaciones: number | null;
  efec_clientes: number | null;
  ultima: string | null;
};

type Campo =
  | "nombre"
  | "cotizaciones"
  | "clientes"
  | "polizas_emitidas"
  | "efec_cotizaciones"
  | "efec_clientes";
type Dir = "asc" | "desc";

const TAMANOS = [50, 100, 500];
const fmtN = new Intl.NumberFormat("es-VE").format;

/** Los porcentajes se tiñen por tramo para poder barrer la tabla de un vistazo. */
function colorPct(v: number | null): string {
  if (v === null) return "text-neutral-300";
  if (v >= 15) return "text-emerald-600";
  if (v >= 5) return "text-brand";
  if (v > 0) return "text-amber-600";
  return "text-neutral-400";
}

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

export function TablaEfectividad({
  corredores,
  soloConEmisiones = true,
}: {
  corredores: CorredorEfec[];
  soloConEmisiones?: boolean;
}) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [campo, setCampo] = useState<Campo>("cotizaciones");
  const [dir, setDir] = useState<Dir>("desc");
  const [porPagina, setPorPagina] = useState(TAMANOS[0]);
  const [pagina, setPagina] = useState(0);
  // Por defecto se esconden los corredores sin ninguna emisión: son 896 de
  // 1.039 y todos con "—", así que sepultarían a los que sí tienen datos.
  const [ocultarSinDatos, setOcultarSinDatos] = useState(soloConEmisiones);

  const ordenados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    let base = corredores;
    if (ocultarSinDatos) base = base.filter((c) => c.polizas_emitidas > 0 || c.cotiz_cerradas > 0);
    if (q) base = base.filter((c) => c.nombre.toLowerCase().includes(q));
    const signo = dir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      if (campo === "nombre") return signo * a.nombre.localeCompare(b.nombre, "es");
      const va = a[campo];
      const vb = b[campo];
      // null (sin base comparable) siempre al final, ordene como ordene.
      if (va === null && vb === null) return a.nombre.localeCompare(b.nombre, "es");
      if (va === null) return 1;
      if (vb === null) return -1;
      const diff = Number(va) - Number(vb);
      return diff !== 0 ? signo * diff : a.nombre.localeCompare(b.nombre, "es");
    });
  }, [corredores, busqueda, campo, dir, ocultarSinDatos]);

  const totalPaginas = Math.max(1, Math.ceil(ordenados.length / porPagina));
  const paginaActual = Math.min(pagina, totalPaginas - 1);
  const desde = paginaActual * porPagina;
  const visibles = ordenados.slice(desde, desde + porPagina);
  const ocultos = corredores.length - ordenados.length;

  function ordenarPor(c: Campo) {
    if (campo === c) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setCampo(c);
      setDir(c === "nombre" ? "asc" : "desc");
    }
    setPagina(0);
  }

  const th = (c: Campo, label: string, alinear: "left" | "right" = "right", titulo?: string) => (
    <th
      className={"px-3 py-2 font-medium text-neutral-500 " + (alinear === "right" ? "text-right" : "text-left")}
      title={titulo}
    >
      <button
        type="button"
        onClick={() => ordenarPor(c)}
        className={
          "inline-flex items-center gap-1 transition-colors hover:text-neutral-900 " +
          (campo === c ? "text-neutral-900" : "")
        }
      >
        {label}
        <span className={campo === c ? "text-neutral-900" : "text-neutral-300"}>
          {campo === c ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );

  if (!corredores.length) {
    return <p className="text-xs text-neutral-400">Sin corredores en este período.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={busqueda}
          onChange={(e) => {
            setBusqueda(e.target.value);
            setPagina(0);
          }}
          placeholder="Buscar corredor…"
          className="w-full max-w-xs rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={ocultarSinDatos}
            onChange={(e) => {
              setOcultarSinDatos(e.target.checked);
              setPagina(0);
            }}
            className="rounded border-neutral-300"
          />
          Solo con emisiones cargadas
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          Mostrar
          <select
            value={porPagina}
            onChange={(e) => {
              setPorPagina(Number(e.target.value));
              setPagina(0);
            }}
            className="rounded-lg border border-neutral-300 px-2 py-1.5 text-xs focus:border-neutral-900 focus:outline-none"
          >
            {TAMANOS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-neutral-400">
          {ordenados.length === 0
            ? "sin resultados"
            : `${desde + 1}–${Math.min(desde + porPagina, ordenados.length)} de ${ordenados.length}`}
          {ocultos > 0 && ocultarSinDatos && ` · ${fmtN(ocultos)} sin emisiones ocultos`}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50/60 text-xs">
              <tr>
                <th className="w-8 px-3 py-2" />
                {th("nombre", "Corredor", "left")}
                {th("cotizaciones", "Cotizó", "right", "Cotizaciones que mandó a Zoho en el período")}
                {th("clientes", "Clientes", "right", "Clientes distintos cotizados")}
                {th("polizas_emitidas", "Emitió", "right", "Pólizas emitidas en el período cargado del sistema central")}
                {th("efec_cotizaciones", "Efec. cotiz.", "right", "Cotizaciones cerradas / cotizaciones en la ventana observable")}
                {th("efec_clientes", "Efec. clientes", "right", "Clientes que emitieron / clientes cotizados en la ventana observable")}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {visibles.map((c) => {
                const estaAbierto = abierto === c.clave;
                return (
                  <Fragment key={c.clave}>
                    <tr
                      onClick={() => setAbierto(estaAbierto ? null : c.clave)}
                      className="cursor-pointer transition-colors hover:bg-neutral-50"
                    >
                      <td className="px-3 py-2.5 text-neutral-400">
                        <span className={"inline-block transition-transform " + (estaAbierto ? "rotate-90" : "")}>›</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="font-medium text-neutral-900">{c.nombre}</span>
                        {!c.mapeado && (
                          <span
                            className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                            title="Este nombre de Zoho todavía no está ligado a un código del sistema central, así que no se le puede acreditar ninguna emisión."
                          >
                            sin mapear
                          </span>
                        )}
                        {c.alias_n > 1 && (
                          <span className="ml-2 text-[10px] text-neutral-400" title="Formas distintas en que se escribió en Zoho">
                            {c.alias_n} variantes
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right text-neutral-600 tabular-nums">{fmtN(c.cotizaciones)}</td>
                      <td className="px-3 py-2.5 text-right text-neutral-600 tabular-nums">{fmtN(c.clientes)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className={c.polizas_emitidas > 0 ? "font-medium text-neutral-900" : "text-neutral-300"}>
                          {c.polizas_emitidas > 0 ? fmtN(c.polizas_emitidas) : "—"}
                        </span>
                      </td>
                      <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${colorPct(c.efec_cotizaciones)}`}>
                        {pct(c.efec_cotizaciones)}
                        {c.efec_cotizaciones !== null && (
                          <span className="ml-1 text-[10px] font-normal text-neutral-400">
                            {c.cotiz_cerradas}/{c.cotiz_en_ventana}
                          </span>
                        )}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${colorPct(c.efec_clientes)}`}>
                        {pct(c.efec_clientes)}
                        {c.efec_clientes !== null && (
                          <span className="ml-1 text-[10px] font-normal text-neutral-400">
                            {c.clientes_cerrados}/{c.clientes_en_ventana}
                          </span>
                        )}
                      </td>
                    </tr>

                    {estaAbierto && (
                      <tr>
                        <td colSpan={7} className="bg-neutral-50/60 px-4 py-3 pl-10">
                          <div className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2">
                            <Linea
                              label="Pólizas que venían de una cotización"
                              valor={`${fmtN(c.polizas_con_cotizacion)} de ${fmtN(c.polizas_emitidas)}`}
                              nota={
                                c.polizas_sin_cotizacion > 0
                                  ? `${fmtN(c.polizas_sin_cotizacion)} emitidas sin cotizar por Zoho`
                                  : undefined
                              }
                            />
                            <Linea
                              label="Vigentes / anuladas"
                              valor={`${fmtN(c.polizas_vigentes)} / ${fmtN(c.polizas_anuladas)}`}
                              nota={c.polizas_anuladas > 0 ? "las anuladas no cuentan como cierre" : undefined}
                            />
                            <Linea
                              label="Cotizaciones en la ventana observable"
                              valor={fmtN(c.cotiz_en_ventana)}
                              nota={
                                c.cotiz_en_curso > 0
                                  ? `${fmtN(c.cotiz_en_curso)} más son posteriores al último mes cargado: aún no se pueden juzgar`
                                  : undefined
                              }
                            />
                            <Linea
                              label="Clientes que emitieron con otro corredor"
                              valor={fmtN(c.cerradas_otro)}
                              nota={c.cerradas_otro > 0 ? "cotizó él, emitió otro" : undefined}
                            />
                            {c.cotiz_anuladas > 0 && (
                              <Linea label="Cotizaciones que emitieron y se anularon" valor={fmtN(c.cotiz_anuladas)} />
                            )}
                            {c.cod_intermediario && (
                              <Linea label="Código en el sistema central" valor={c.cod_intermediario} />
                            )}
                          </div>
                          {!c.mapeado && (
                            <p className="mt-3 text-[11px] text-amber-700">
                              Sin código del sistema central no se le puede acreditar ninguna emisión. Se liga solo en
                              cuanto este corredor aparezca en un Reporte de Emisión, o a mano en la tabla{" "}
                              <span className="font-mono">corredor_alias</span>.
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalPaginas > 1 && (
          <div className="flex items-center justify-between border-t border-neutral-100 px-3 py-2 text-xs">
            <span className="text-neutral-500">
              Página {paginaActual + 1} de {totalPaginas}
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setPagina(Math.max(0, paginaActual - 1))}
                disabled={paginaActual === 0}
                className="rounded-md border border-neutral-200 px-2 py-1 disabled:opacity-40"
              >
                Anterior
              </button>
              <button
                type="button"
                onClick={() => setPagina(Math.min(totalPaginas - 1, paginaActual + 1))}
                disabled={paginaActual >= totalPaginas - 1}
                className="rounded-md border border-neutral-200 px-2 py-1 disabled:opacity-40"
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Linea({ label, valor, nota }: { label: string; valor: string; nota?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-neutral-200/60 pb-1.5">
      <span className="text-neutral-500">{label}</span>
      <span className="text-right">
        <span className="font-medium text-neutral-800 tabular-nums">{valor}</span>
        {nota && <span className="block text-[10px] text-neutral-400">{nota}</span>}
      </span>
    </div>
  );
}
