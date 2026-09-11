"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Selector de mes de emisiones, por FECHA DE SUSCRIPCIÓN.
//
// Con un solo mes cargado (agosto) el módulo se entendía sin decir de cuándo
// eran los números. En cuanto entra septiembre dejan de significar nada si no
// se puede acotar: "460 vigentes" pasa a ser la suma de dos meses.
//
// Escribe en el MISMO `?desde&hasta` que el filtro de periodo de la cabecera,
// a propósito: dos filtros de fecha independientes en la misma pantalla es la
// forma más rápida de que alguien lea un número creyendo que es otro. Acá el
// mes es solo un atajo que rellena ese rango.
//
// La fecha es la de suscripción de la póliza, NO la de carga del archivo: un
// CSV de septiembre puede traer pólizas suscritas en agosto, y lo que interesa
// del negocio es cuándo se suscribió.

export type PeriodoEmision = {
  mes: string;      // YYYY-MM
  desde: string;    // YYYY-MM-DD, inclusivo
  hasta: string;    // YYYY-MM-DD, inclusivo
  polizas: number;
  vigentes: number;
  anuladas: number;
  prima: number;
};

const nf = new Intl.NumberFormat("es-VE");

function etiquetaMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, 1)).toLocaleDateString("es-VE", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function PeriodosEmisiones({
  periodos,
  desde,
  hasta,
}: {
  periodos: PeriodoEmision[];
  desde: string | null;
  hasta: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  if (periodos.length === 0) return null;

  function aplicar(p: PeriodoEmision | null) {
    const next = new URLSearchParams(params.toString());
    if (p) {
      next.set("desde", p.desde);
      next.set("hasta", p.hasta);
    } else {
      next.delete("desde");
      next.delete("hasta");
    }
    next.delete("page");
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const activo = periodos.find((p) => p.desde === desde && p.hasta === hasta)?.mes ?? null;
  const sinFiltro = !desde && !hasta;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-neutral-400">Suscritas en:</span>
      <div className="flex flex-wrap gap-1 rounded-lg border border-neutral-200 bg-white p-0.5">
        <button
          type="button"
          onClick={() => aplicar(null)}
          className={
            "shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors " +
            (sinFiltro ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-50")
          }
        >
          Todo
        </button>
        {periodos.map((p) => (
          <button
            key={p.mes}
            type="button"
            onClick={() => aplicar(p)}
            title={`${nf.format(p.polizas)} pólizas · ${nf.format(p.vigentes)} vigentes · ${nf.format(p.anuladas)} anuladas`}
            className={
              "shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors " +
              (activo === p.mes ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-50")
            }
          >
            {etiquetaMes(p.mes)}
            <span className={"ml-1 " + (activo === p.mes ? "text-neutral-300" : "text-neutral-400")}>
              {nf.format(p.polizas)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
