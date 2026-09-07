"use client";

// Primitivas compartidas del panel de analítica de /pipeline.
//
// Viven en su propio módulo porque las usan tanto `analitica-panel.tsx` (la
// pestaña de cotizaciones) como `analitica-emisiones.tsx` (las de emisiones y
// efectividad). Tenerlas en el panel y que el archivo de emisiones las
// importara de ahí crearía un ciclo: el panel importa las pestañas y las
// pestañas importarían el panel.

export const C_B2C = "#6366f1";
export const C_B2B = "#0ea5e9";
export const C_SIN = "#cbd5e1";
export const C_PRIMA = "#0d9488";
export const C_ANULADA = "#e11d48";
export const C_PENDIENTE = "#f59e0b";

const nf = new Intl.NumberFormat("es-VE");

export const n = (v: number) => nf.format(v);
export const pct = (parte: number, total: number) =>
  total > 0 ? `${((parte / total) * 100).toFixed(1)}%` : "—";
/** Número sin símbolo, para las primas de Zoho, cuya moneda no está confirmada. */
export const money = (v: number | null) => (v == null ? "—" : `${nf.format(Math.round(v))}`);
/** Dinero con símbolo: el CSV de emisiones viene todo en dólares (`Moneda` = "Dólares"). */
export const usd = (v: number | null | undefined) =>
  v == null ? "—" : `$${nf.format(Math.round(Number(v)))}`;
export const usdFino = (v: number | null | undefined) =>
  v == null
    ? "—"
    : `$${Number(v).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dias = (v: number | null | undefined) => (v == null ? "—" : `${v} d`);

export const fmtDia = (s: string | null | undefined) =>
  s
    ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`).toLocaleDateString("es-VE", {
        day: "2-digit",
        month: "short",
      })
    : "—";

export function Bloque({
  titulo,
  nota,
  children,
}: {
  titulo: string;
  nota?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold tracking-tight text-neutral-900">{titulo}</h4>
      {nota && <p className="text-[11px] leading-relaxed text-neutral-500">{nota}</p>}
      {children}
    </section>
  );
}

export function Cifra({ label, valor, pie }: { label: string; valor: string; pie: string }) {
  return (
    <div className="flex-1 rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-neutral-900">{valor}</div>
      {pie && <div className="text-[10px] text-neutral-400">{pie}</div>}
    </div>
  );
}

/**
 * Fila con barra proporcional: etiqueta a la izquierda, barra al medio y un
 * dato de apoyo a la derecha. Es el formato que más se repite en el panel.
 *
 * La barra tiene un mínimo de 2% de ancho a propósito: con `max` grande, un
 * valor de 1 daba una barra de 0px y la fila parecía vacía en vez de pequeña.
 */
export function FilaMedida({
  label,
  valor,
  max,
  derecha,
  color,
  anchoLabel = "w-24",
}: {
  label: string;
  valor: number;
  max: number;
  derecha?: string;
  color?: string;
  anchoLabel?: string;
}) {
  const ancho = max > 0 ? Math.max(2, (valor / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className={`${anchoLabel} shrink-0 truncate text-[11px] text-neutral-600`} title={label}>
        {label}
      </div>
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full"
          style={{ width: `${ancho}%`, background: color ?? C_B2B }}
          title={`${label}: ${n(valor)}`}
        />
      </div>
      <div className="w-12 shrink-0 text-right text-[11px] tabular-nums text-neutral-700">{n(valor)}</div>
      {derecha && (
        <div className="w-32 shrink-0 truncate text-right text-[10px] text-neutral-400" title={derecha}>
          {derecha}
        </div>
      )}
    </div>
  );
}

/**
 * Barras por día. Sin etiqueta en cada barra (no caben 31) — el día va en el
 * tooltip y solo se rotulan el primero y el último.
 */
export function BarrasDia({
  filas,
}: {
  filas: { dia: string; polizas: number; prima: number }[];
}) {
  const max = Math.max(...filas.map((f) => f.polizas), 1);
  return (
    <div>
      <div className="flex h-24 items-end gap-px">
        {filas.map((f) => (
          <div
            key={f.dia}
            className="flex-1 rounded-t bg-teal-500/80 transition-colors hover:bg-teal-600"
            style={{ height: `${Math.max(3, (f.polizas / max) * 100)}%` }}
            title={`${fmtDia(f.dia)}: ${n(f.polizas)} pólizas · ${usd(f.prima)}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-neutral-400">
        <span>{fmtDia(filas[0]?.dia)}</span>
        <span>máx. {n(max)} en un día</span>
        <span>{fmtDia(filas[filas.length - 1]?.dia)}</span>
      </div>
    </div>
  );
}
