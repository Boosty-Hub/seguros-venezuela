"use client";

import { Fragment, useMemo, useState } from "react";

// Tabla de corredores: Corredor → Cliente → cotizaciones.
//
// El detalle de cada corredor se pide al abrirlo (no viene en el render de la
// página) porque son más de mil corredores; traerlos todos con su detalle
// completo sería un payload enorme para ver el de uno.

type Corredor = {
  asesor: string;
  asesor_original: string | null;
  cotizaciones: number;
  clientes: number;
  en_kommo: number;
  ultima: string | null;
};

type Cotizacion = {
  id: string;
  ticket_number: string | null;
  subject: string | null;
  plan: string | null;
  edad: number | string | null;
  prima: number | null;
  moneda: string | null;
  status: string | null;
  creado: string | null;
  web_url: string | null;
  en_kommo: boolean;
};

type Cliente = {
  cedula: string | null;
  titular: string | null;
  email: string | null;
  telefono: string | null;
  n_cotizaciones: number;
  ultima: string | null;
  cotizaciones: Cotizacion[];
};

type Detalle = { asesor: string; total_cotizaciones: number; total_clientes: number; clientes: Cliente[] };

type Campo = "asesor" | "clientes" | "cotizaciones" | "en_kommo" | "ultima";
type Dir = "asc" | "desc";

const TAMANOS = [100, 500, 1000];

const fmtFecha = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("es-VE", { day: "2-digit", month: "short", year: "2-digit" }) : "—";

const fmtCedula = (c: string | null) => (c ? `V-${c}` : "sin cédula");

const claveCliente = (c: Cliente) => `${c.cedula ?? "sc"}|${c.titular ?? ""}|${c.ultima ?? ""}`;

export function ListaCorredores({ corredores, since }: { corredores: Corredor[]; since: string | null }) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, Detalle>>({});
  const [cargando, setCargando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [campo, setCampo] = useState<Campo>("cotizaciones");
  const [dir, setDir] = useState<Dir>("desc");
  const [porPagina, setPorPagina] = useState(TAMANOS[0]);
  const [pagina, setPagina] = useState(0);

  const ordenados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const base = q ? corredores.filter((c) => c.asesor.toLowerCase().includes(q)) : corredores;
    const signo = dir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      if (campo === "asesor") return signo * a.asesor.localeCompare(b.asesor, "es");
      if (campo === "ultima") {
        return signo * (new Date(a.ultima ?? 0).getTime() - new Date(b.ultima ?? 0).getTime());
      }
      const diff = Number(a[campo]) - Number(b[campo]);
      // Empate: alfabético, para que el orden no baile entre renders.
      return diff !== 0 ? signo * diff : a.asesor.localeCompare(b.asesor, "es");
    });
  }, [corredores, busqueda, campo, dir]);

  const totalPaginas = Math.max(1, Math.ceil(ordenados.length / porPagina));
  // Si un cambio de filtro deja la página fuera de rango, se muestra la última.
  const paginaActual = Math.min(pagina, totalPaginas - 1);
  const desde = paginaActual * porPagina;
  const visibles = ordenados.slice(desde, desde + porPagina);

  function ordenarPor(c: Campo) {
    if (campo === c) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setCampo(c);
      // Texto arranca A→Z; números y fechas arrancan de mayor a menor, que es
      // lo que se quiere mirar primero.
      setDir(c === "asesor" ? "asc" : "desc");
    }
    setPagina(0);
  }

  async function alternar(asesor: string) {
    if (abierto === asesor) return setAbierto(null);
    setAbierto(asesor);
    setError(null);
    if (cache[asesor]) return;
    setCargando(asesor);
    try {
      const res = await fetch("/api/zoho/corredor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asesor, since }),
      });
      const json = await res.json().catch(() => ({ error: `respuesta inválida (${res.status})` }));
      if (!res.ok) throw new Error(json.error ?? "error");
      setCache((c) => ({ ...c, [asesor]: json.detalle as Detalle }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "no se pudo cargar el detalle");
    } finally {
      setCargando(null);
    }
  }

  if (corredores.length === 0) {
    return <p className="text-xs text-neutral-400">Sin corredores en este período.</p>;
  }

  const th = (c: Campo, label: string, alinear: "left" | "right" = "right") => (
    <th
      className={
        "px-3 py-2 font-medium text-neutral-500 " + (alinear === "right" ? "text-right" : "text-left")
      }
    >
      <button
        type="button"
        onClick={() => ordenarPor(c)}
        className={
          "inline-flex items-center gap-1 transition-colors hover:text-neutral-900 " +
          (campo === c ? "text-neutral-900" : "")
        }
        title={`Ordenar por ${label.toLowerCase()}`}
      >
        {label}
        <span className={campo === c ? "text-neutral-900" : "text-neutral-300"}>
          {campo === c ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={busqueda}
          onChange={(e) => {
            setBusqueda(e.target.value);
            setPagina(0);
          }}
          placeholder={`Buscar entre ${corredores.length} corredores…`}
          className="w-full max-w-xs rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
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
          por página
        </label>
        <span className="text-xs text-neutral-400">
          {ordenados.length === 0
            ? "sin resultados"
            : `${desde + 1}–${Math.min(desde + porPagina, ordenados.length)} de ${ordenados.length}`}
        </span>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">⚠ {error}</p>
      )}

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50/60 text-xs">
              <tr>
                <th className="w-8 px-3 py-2" />
                {th("asesor", "Corredor", "left")}
                {th("clientes", "Clientes")}
                {th("cotizaciones", "Cotizaciones")}
                {th("en_kommo", "En Kommo")}
                {th("ultima", "Última")}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {visibles.map((c) => {
                const estaAbierto = abierto === c.asesor;
                return (
                  <Fragment key={c.asesor}>
                    <tr
                      onClick={() => alternar(c.asesor)}
                      className="cursor-pointer transition-colors hover:bg-neutral-50"
                    >
                      <td className="px-3 py-2.5 text-neutral-400">
                        <span className={"inline-block transition-transform " + (estaAbierto ? "rotate-90" : "")}>
                          ›
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-medium text-neutral-900">{c.asesor}</td>
                      <td className="px-3 py-2.5 text-right text-neutral-600">{c.clientes}</td>
                      <td className="px-3 py-2.5 text-right">
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
                          {c.cotizaciones}
                        </span>
                      </td>
                      <td
                        className="px-3 py-2.5 text-right text-xs text-neutral-500"
                        title={`${c.en_kommo} de ${c.cotizaciones} ya migradas a Kommo`}
                      >
                        {c.en_kommo}/{c.cotizaciones}
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs text-neutral-500">{fmtFecha(c.ultima)}</td>
                    </tr>
                    {estaAbierto && (
                      <tr>
                        <td colSpan={6} className="bg-neutral-50/60 px-4 py-3 pl-10">
                          {cargando === c.asesor && (
                            <p className="py-1 text-xs text-neutral-400">Cargando clientes…</p>
                          )}
                          {cache[c.asesor] && (
                            // key por corredor: al abrir otro, el estado de
                            // expandido/colapsado arranca limpio en vez de
                            // heredar el del corredor anterior.
                            <DetalleCorredor key={c.asesor} detalle={cache[c.asesor]} />
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
              {[
                { label: "« Primera", ir: 0, off: paginaActual === 0 },
                { label: "‹ Anterior", ir: paginaActual - 1, off: paginaActual === 0 },
                { label: "Siguiente ›", ir: paginaActual + 1, off: paginaActual >= totalPaginas - 1 },
                { label: "Última »", ir: totalPaginas - 1, off: paginaActual >= totalPaginas - 1 },
              ].map((b) => (
                <button
                  key={b.label}
                  type="button"
                  disabled={b.off}
                  onClick={() => setPagina(b.ir)}
                  className="rounded-lg border border-neutral-200 px-2.5 py-1 transition-colors hover:bg-neutral-50 disabled:pointer-events-none disabled:opacity-40"
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DetalleCorredor({ detalle }: { detalle: Detalle }) {
  // Los clientes con varias cotizaciones arrancan abiertos: es justamente el
  // caso que interesa mirar (mismo corredor cotizando varias veces a la misma
  // persona — grupo familiar por edades, o comparativa de planes).
  const inicial = useMemo(
    () => new Set(detalle.clientes.filter((c) => c.n_cotizaciones > 1).map(claveCliente)),
    [detalle]
  );
  const [abiertos, setAbiertos] = useState<Set<string>>(inicial);

  const todosAbiertos = abiertos.size === detalle.clientes.length && detalle.clientes.length > 0;

  if (detalle.clientes.length === 0) {
    return <p className="py-1 text-xs text-neutral-400">Sin clientes.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-neutral-500">
          {detalle.total_clientes} {detalle.total_clientes === 1 ? "cliente" : "clientes"} ·{" "}
          {detalle.total_cotizaciones} cotizaciones
        </span>
        <button
          type="button"
          onClick={() =>
            setAbiertos(todosAbiertos ? new Set() : new Set(detalle.clientes.map(claveCliente)))
          }
          className="rounded-lg border border-neutral-200 bg-white px-2 py-1 font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
        >
          {todosAbiertos ? "Colapsar todo" : "Expandir todo"}
        </button>
      </div>

      {detalle.clientes.map((cl) => {
        const k = claveCliente(cl);
        return (
          <ClienteFila
            key={k}
            cliente={cl}
            abierto={abiertos.has(k)}
            onToggle={() =>
              setAbiertos((prev) => {
                const next = new Set(prev);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                return next;
              })
            }
          />
        );
      })}
    </div>
  );
}

function ClienteFila({
  cliente,
  abierto,
  onToggle,
}: {
  cliente: Cliente;
  abierto: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-neutral-50"
      >
        <span className={"text-neutral-300 transition-transform " + (abierto ? "rotate-90" : "")}>›</span>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-900">
          {cliente.titular ?? <span className="text-neutral-400">(sin titular)</span>}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-neutral-500">{fmtCedula(cliente.cedula)}</span>
        {cliente.n_cotizaciones > 1 && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            {cliente.n_cotizaciones} cotizaciones
          </span>
        )}
      </button>
      {abierto && (
        <div className="overflow-x-auto border-t border-neutral-100">
          <table className="w-full min-w-[620px] text-xs">
            <thead className="bg-neutral-50 text-left text-neutral-500">
              <tr>
                <th className="px-3 py-1.5 font-medium">Ticket</th>
                <th className="px-3 py-1.5 font-medium">Plan</th>
                <th className="px-3 py-1.5 font-medium">Edad</th>
                <th className="px-3 py-1.5 font-medium">Prima</th>
                <th className="px-3 py-1.5 font-medium">Estado</th>
                <th className="px-3 py-1.5 font-medium">Fecha</th>
                <th className="px-3 py-1.5 font-medium">Kommo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {cliente.cotizaciones.map((q) => (
                <tr key={q.id}>
                  <td className="px-3 py-1.5">
                    {q.web_url ? (
                      <a
                        href={q.web_url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-brand hover:underline"
                      >
                        #{q.ticket_number ?? "—"}
                      </a>
                    ) : (
                      <span className="text-neutral-500">#{q.ticket_number ?? "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-neutral-700">{q.plan ?? "—"}</td>
                  <td className="px-3 py-1.5 text-neutral-600">{q.edad ?? "—"}</td>
                  <td className="px-3 py-1.5 text-neutral-600">
                    {q.prima ? `${q.prima} ${q.moneda ?? ""}`.trim() : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-neutral-600">{q.status ?? "—"}</td>
                  <td className="px-3 py-1.5 text-neutral-500">{fmtFecha(q.creado)}</td>
                  <td className="px-3 py-1.5">
                    {q.en_kommo ? (
                      <span className="text-emerald-600">sí</span>
                    ) : (
                      <span className="text-neutral-400">no</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
