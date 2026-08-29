"use client";

import { useMemo, useState } from "react";
import DeleteDreamButton from "./delete-button";

// Tabla de aprendizajes activos. Antes eran tarjetas en grilla: con decenas de
// dreams había que scrollear mucho para encontrar uno, y no se podía ordenar
// ni comparar fechas de un vistazo.

export type FilaDream = {
  id: string;
  title: string;
  date: string;
  period: string;
  sev: string | null;
};

const SEVERIDAD: Record<string, { label: string; cls: string; orden: number }> = {
  err: { label: "error", cls: "bg-red-100 text-red-700", orden: 3 },
  adv: { label: "advertencia", cls: "bg-amber-100 text-amber-800", orden: 2 },
  sug: { label: "sugerencia", cls: "bg-emerald-100 text-emerald-700", orden: 1 },
};

const TAMANOS = [50, 100, 250];

type Campo = "date" | "sev" | "period" | "title";
type Dir = "asc" | "desc";

export function TablaDreams({ dreams }: { dreams: FilaDream[] }) {
  const [busqueda, setBusqueda] = useState("");
  const [campo, setCampo] = useState<Campo>("date");
  const [dir, setDir] = useState<Dir>("desc");
  const [porPagina, setPorPagina] = useState(TAMANOS[0]);
  const [pagina, setPagina] = useState(0);

  const ordenados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const base = q
      ? dreams.filter((d) => d.title.toLowerCase().includes(q) || d.period.toLowerCase().includes(q))
      : dreams;
    const signo = dir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      let diff = 0;
      // La severidad no ordena alfabéticamente: error > advertencia >
      // sugerencia, que es como se mira.
      if (campo === "sev") diff = (SEVERIDAD[a.sev ?? ""]?.orden ?? 0) - (SEVERIDAD[b.sev ?? ""]?.orden ?? 0);
      else diff = String(a[campo]).localeCompare(String(b[campo]), "es");
      return diff !== 0 ? signo * diff : a.title.localeCompare(b.title, "es");
    });
  }, [dreams, busqueda, campo, dir]);

  const totalPaginas = Math.max(1, Math.ceil(ordenados.length / porPagina));
  const paginaActual = Math.min(pagina, totalPaginas - 1);
  const desde = paginaActual * porPagina;
  const visibles = ordenados.slice(desde, desde + porPagina);

  function ordenarPor(c: Campo) {
    if (campo === c) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setCampo(c);
      setDir(c === "title" ? "asc" : "desc");
    }
    setPagina(0);
  }

  const th = (c: Campo, label: string, extra = "") => (
    <th className={"px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500 " + extra}>
      <button
        type="button"
        onClick={() => ordenarPor(c)}
        className={
          "inline-flex items-center gap-1 uppercase transition-colors hover:text-neutral-900 " +
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
          placeholder={`Buscar entre ${dreams.length} aprendizajes…`}
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

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left">
              <tr>
                {th("date", "Fecha")}
                {th("sev", "Severidad")}
                {th("period", "Período")}
                {th("title", "Título")}
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {visibles.map((d) => (
                <tr key={d.id} className="transition-colors hover:bg-neutral-50/70">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-neutral-600">{d.date || "—"}</td>
                  <td className="px-4 py-3">
                    {d.sev && SEVERIDAD[d.sev] ? (
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERIDAD[d.sev].cls}`}
                      >
                        {SEVERIDAD[d.sev].label}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-neutral-500">{d.period || "—"}</td>
                  <td className="px-4 py-3 text-xs capitalize text-neutral-900">
                    <a href={`/dreams?open=${d.id}`} className="hover:underline">
                      {d.title}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <a
                        href={`/dreams?open=${d.id}`}
                        className="text-xs font-medium text-brand transition-colors hover:text-brand-strong"
                      >
                        Ver →
                      </a>
                      <DeleteDreamButton id={d.id} />
                    </div>
                  </td>
                </tr>
              ))}
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
