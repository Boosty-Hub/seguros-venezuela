"use client";

import { useState } from "react";

// Lista de corredores desplegable: Corredor → Cliente → cotizaciones.
//
// El detalle de cada corredor se pide al abrirlo (no viene en el render de la
// página) porque son cientos de corredores; traerlos todos con su detalle
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

const fmtFecha = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("es-VE", { day: "2-digit", month: "short", year: "2-digit" }) : "—";

const fmtCedula = (c: string | null) => (c ? `V-${c}` : "sin cédula");

export function ListaCorredores({ corredores, since }: { corredores: Corredor[]; since: string | null }) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, Detalle>>({});
  const [cargando, setCargando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");

  const filtrados = busqueda.trim()
    ? corredores.filter((c) => c.asesor.toLowerCase().includes(busqueda.trim().toLowerCase()))
    : corredores;

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

  return (
    <div className="space-y-3">
      <input
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder={`Buscar entre ${corredores.length} corredores…`}
        className="w-full max-w-sm rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
      />
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">⚠ {error}</p>
      )}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
        {filtrados.slice(0, 200).map((c) => {
          const det = cache[c.asesor];
          const estaAbierto = abierto === c.asesor;
          return (
            <div key={c.asesor} className="border-b border-neutral-100 last:border-b-0">
              <button
                type="button"
                onClick={() => alternar(c.asesor)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50"
              >
                <span className={"text-neutral-400 transition-transform " + (estaAbierto ? "rotate-90" : "")}>›</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900">{c.asesor}</span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {c.clientes} {c.clientes === 1 ? "cliente" : "clientes"}
                </span>
                <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
                  {c.cotizaciones} cotiz.
                </span>
                <span
                  className="shrink-0 text-xs text-neutral-400"
                  title={`${c.en_kommo} de ${c.cotizaciones} ya migradas a Kommo`}
                >
                  {c.en_kommo}/{c.cotizaciones} en Kommo
                </span>
                <span className="hidden shrink-0 text-xs text-neutral-400 sm:inline">{fmtFecha(c.ultima)}</span>
              </button>

              {estaAbierto && (
                <div className="bg-neutral-50/60 px-4 pb-4 pl-10">
                  {cargando === c.asesor && <p className="py-2 text-xs text-neutral-400">Cargando clientes…</p>}
                  {det && det.clientes.length === 0 && (
                    <p className="py-2 text-xs text-neutral-400">Sin clientes.</p>
                  )}
                  {det?.clientes.map((cl) => (
                    <ClienteFila key={(cl.cedula ?? "") + (cl.titular ?? "") + cl.ultima} cliente={cl} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {filtrados.length > 200 && (
        <p className="text-[11px] text-neutral-400">
          Mostrando los 200 corredores con más cotizaciones de {filtrados.length}. Usa el buscador para llegar al resto.
        </p>
      )}
    </div>
  );
}

function ClienteFila({ cliente }: { cliente: Cliente }) {
  // Un cliente con varias cotizaciones arranca desplegado: es justamente el
  // caso que interesa ver (mismo corredor mandando 2+ cotizaciones a la misma
  // persona, normalmente un grupo familiar por edades).
  const [abierto, setAbierto] = useState(cliente.n_cotizaciones > 1);
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
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
        <div className="border-t border-neutral-100">
          <table className="w-full text-xs">
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
