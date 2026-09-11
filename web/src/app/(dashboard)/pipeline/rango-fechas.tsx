"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState, useEffect } from "react";
import { sumarDias } from "@/lib/rango-fechas";

// Filtro de rango de fechas de /pipeline. Vive en la URL (`?desde=&hasta=`,
// fechas `YYYY-MM-DD` inclusivas) y no en estado local, por tres razones:
// la página es un server component y así puede filtrar en la consulta, el
// rango sobrevive a un F5, y un periodo concreto se puede pasar por link.
//
// Los atajos se calculan en HORA LOCAL del navegador a propósito. El operador
// está en Venezuela y "hoy" tiene que ser su hoy; convertir a UTC acá y volver
// allá es donde se cuela el desfase de 4 horas (ver lib/rango-fechas.ts).

const hoyISO = () => {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

type Atajo = { id: string; label: string; rango: () => { desde: string; hasta: string } | null };

const ATAJOS: Atajo[] = [
  { id: "hoy", label: "Hoy", rango: () => ({ desde: hoyISO(), hasta: hoyISO() }) },
  {
    id: "7d",
    label: "7 días",
    rango: () => ({ desde: sumarDias(hoyISO(), -6), hasta: hoyISO() }),
  },
  {
    id: "30d",
    label: "30 días",
    rango: () => ({ desde: sumarDias(hoyISO(), -29), hasta: hoyISO() }),
  },
  {
    id: "mes",
    label: "Este mes",
    rango: () => ({ desde: `${hoyISO().slice(0, 7)}-01`, hasta: hoyISO() }),
  },
  {
    id: "mes-1",
    label: "Mes pasado",
    rango: () => {
      const primeroDeEste = `${hoyISO().slice(0, 7)}-01`;
      const finAnterior = sumarDias(primeroDeEste, -1);
      return { desde: `${finAnterior.slice(0, 7)}-01`, hasta: finAnterior };
    },
  },
  { id: "todo", label: "Todo", rango: () => null },
];

export function RangoFechas({ desde, hasta }: { desde: string | null; hasta: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [dDesde, setDDesde] = useState(desde ?? "");
  const [dHasta, setDHasta] = useState(hasta ?? "");
  // El servidor manda: si el rango cambia por un atajo o por el botón atrás,
  // los inputs tienen que seguirlo en vez de quedarse con lo que se tecleó.
  useEffect(() => setDDesde(desde ?? ""), [desde]);
  useEffect(() => setDHasta(hasta ?? ""), [hasta]);

  function aplicar(d: string | null, h: string | null) {
    const next = new URLSearchParams(params.toString());
    if (d) next.set("desde", d);
    else next.delete("desde");
    if (h) next.set("hasta", h);
    else next.delete("hasta");
    // Cambiar el periodo reinicia la paginación de la tabla de tickets: si no,
    // te quedas en la página 7 de un resultado que ahora tiene dos.
    next.delete("page");
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const activo = ATAJOS.find((a) => {
    const r = a.rango();
    if (!r) return !desde && !hasta;
    return r.desde === desde && r.hasta === hasta;
  })?.id;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1 rounded-lg border border-neutral-200 bg-white p-0.5">
        {ATAJOS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              const r = a.rango();
              aplicar(r?.desde ?? null, r?.hasta ?? null);
            }}
            className={
              "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors " +
              (activo === a.id
                ? "bg-neutral-900 text-white"
                : "text-neutral-600 hover:bg-neutral-50")
            }
          >
            {a.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2 py-1">
        <input
          type="date"
          value={dDesde}
          max={dHasta || undefined}
          onChange={(e) => setDDesde(e.target.value)}
          aria-label="Fecha de inicio"
          className="rounded border-0 bg-transparent px-1 py-0.5 text-xs text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-900"
        />
        <span className="text-xs text-neutral-400">a</span>
        <input
          type="date"
          value={dHasta}
          min={dDesde || undefined}
          onChange={(e) => setDHasta(e.target.value)}
          aria-label="Fecha de fin"
          className="rounded border-0 bg-transparent px-1 py-0.5 text-xs text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-900"
        />
        <button
          type="button"
          onClick={() => aplicar(dDesde || null, dHasta || null)}
          disabled={dDesde === (desde ?? "") && dHasta === (hasta ?? "")}
          className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-40"
        >
          Aplicar
        </button>
      </div>
    </div>
  );
}
