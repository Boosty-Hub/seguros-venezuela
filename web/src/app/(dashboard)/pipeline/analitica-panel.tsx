"use client";

import { useCallback, useEffect, useState } from "react";

// Panel lateral de analítica de /pipeline.
//
// DESPLAZA el contenido en vez de flotar encima (mismo criterio que la Torre
// de Control): al abrirlo la página se encoge a la mitad y el panel ocupa la
// otra mitad, así se puede mirar el gráfico y la tabla a la vez. En pantallas
// angostas no hay mitad que valga: pasa a ocupar todo el ancho.
//
// Los datos se piden al abrir, no en el render de la página.

type Serie = { total: number; b2c: number; b2b: number };
type Analitica = {
  totales: {
    cotizaciones: number; b2c: number; b2b: number; sin_atribucion: number;
    corredores: number; clientes: number; clientes_b2b: number; en_kommo: number;
  };
  por_plan: (Serie & { plan: string })[];
  por_edad: (Serie & { rango: string })[];
  plan_x_edad: { plan: string; rango: string; n: number }[];
  por_mes: (Serie & { mes: string })[];
  por_estado: { status: string; tipo: string; n: number }[];
  top_corredores: { asesor: string; cotizaciones: number; clientes: number }[];
  concentracion: { top10_cotizaciones: number; b2b_cotizaciones: number; corredores_una_sola: number };
  prima: {
    con_dato: number; sin_dato: number; promedio: number | null; mediana: number | null;
    por_plan: { plan: string; n: number; promedio: number }[];
  };
  repeticion: { una: number; dos_a_cinco: number; seis_o_mas: number };
};

const C_B2C = "#6366f1";
const C_B2B = "#0ea5e9";

const nf = new Intl.NumberFormat("es-VE");
const n = (v: number) => nf.format(v);
const pct = (parte: number, total: number) => (total > 0 ? `${((parte / total) * 100).toFixed(1)}%` : "—");
const money = (v: number | null) => (v == null ? "—" : `${nf.format(Math.round(v))}`);

export function PanelAnalitica({ since, children }: { since: string | null; children: React.ReactNode }) {
  const [abierto, setAbierto] = useState(false);
  const [datos, setDatos] = useState<Analitica | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch("/api/zoho/analitica", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since }),
      });
      const json = await res.json().catch(() => ({ error: `respuesta inválida (${res.status})` }));
      if (!res.ok) throw new Error(json.error ?? "error");
      setDatos(json.analitica as Analitica);
    } catch (err) {
      setError(err instanceof Error ? err.message : "no se pudo cargar la analítica");
    } finally {
      setCargando(false);
    }
  }, [since]);

  // El período lo manda la página: si cambia, lo que hay en el panel ya no
  // corresponde y hay que volver a pedirlo.
  useEffect(() => {
    setDatos(null);
  }, [since]);

  useEffect(() => {
    if (abierto && !datos && !cargando) void cargar();
  }, [abierto, datos, cargando, cargar]);

  useEffect(() => {
    if (!abierto) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAbierto(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [abierto]);

  return (
    <div className="flex gap-5">
      <div className={"min-w-0 flex-1 " + (abierto ? "[&_[data-stat-row]]:lg:grid-cols-2" : "")}>
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={() => setAbierto((a) => !a)}
            className={
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors " +
              (abierto
                ? "border-neutral-900 bg-neutral-900 text-white"
                : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50")
            }
          >
            <IconoBarras />
            Analítica
          </button>
        </div>
        {children}
      </div>

      {abierto && (
        <aside className="w-full shrink-0 lg:w-1/2 xl:w-[46%]">
          <div className="sticky top-4 max-h-[calc(100vh-2rem)] space-y-5 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
                Analítica del pipeline
              </h3>
              <button
                type="button"
                onClick={() => setAbierto(false)}
                className="rounded-lg px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100"
                title="Cerrar (Esc)"
              >
                ✕
              </button>
            </div>

            {cargando && <p className="py-6 text-center text-xs text-neutral-400">Calculando…</p>}
            {error && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">⚠ {error}</p>
            )}
            {datos && <Contenido a={datos} />}
          </div>
        </aside>
      )}
    </div>
  );
}

function Contenido({ a }: { a: Analitica }) {
  const t = a.totales;
  const conc = a.concentracion;
  const rep = a.repeticion;
  const clientesRep = rep.una + rep.dos_a_cinco + rep.seis_o_mas;

  return (
    <div className="space-y-6">
      {/* ---- Cifras de cabecera ---- */}
      <div className="grid grid-cols-2 gap-2">
        <Cifra label="Cotizaciones" valor={n(t.cotizaciones)} pie={`${pct(t.en_kommo, t.cotizaciones)} en Kommo`} />
        <Cifra label="Clientes finales" valor={n(t.clientes)} pie={`${n(t.clientes_b2b)} vía corredor`} />
        <Cifra label="Corredores" valor={n(t.corredores)} pie={`${n(conc.corredores_una_sola)} con una sola`} />
        <Cifra
          label="Cotizaciones/corredor"
          valor={t.corredores > 0 ? (t.b2b / t.corredores).toFixed(1) : "—"}
          pie="promedio B2B"
        />
      </div>

      {/* ---- B2C vs B2B ---- */}
      <Bloque titulo="A dónde va cada cotización">
        <BarraApilada
          partes={[
            { label: "B2B (corredores)", valor: t.b2b, color: C_B2B },
            { label: "B2C (al agente)", valor: t.b2c, color: C_B2C },
            { label: "Sin atribución", valor: t.sin_atribucion, color: "#cbd5e1" },
          ]}
          total={t.cotizaciones}
        />
      </Bloque>

      {/* ---- Plan ---- */}
      <Bloque
        titulo="Cotizaciones por plan"
        nota="El corredor pesa más en los planes altos: Oro y Platino son casi todo B2B."
      >
        <Barras
          filas={a.por_plan.map((p) => ({ label: p.plan, b2c: p.b2c, b2b: p.b2b, total: p.total }))}
        />
      </Bloque>

      {/* ---- Edad ---- */}
      <Bloque titulo="Cotizaciones por rango de edad">
        <Histograma filas={a.por_edad.map((e) => ({ label: e.rango, b2c: e.b2c, b2b: e.b2b, total: e.total }))} />
      </Bloque>

      {/* ---- Cruce plan x edad ---- */}
      <Bloque titulo="Plan × edad" nota="Dónde se concentra la demanda. Más oscuro = más cotizaciones.">
        <Cruce celdas={a.plan_x_edad} />
      </Bloque>

      {/* ---- Evolución ---- */}
      <Bloque titulo="Evolución mensual">
        <Meses filas={a.por_mes} />
      </Bloque>

      {/* ---- Estado ---- */}
      <Bloque titulo="Estado de las cotizaciones">
        <Lista
          filas={a.por_estado.map((e) => ({ label: e.status, valor: e.n, extra: e.tipo }))}
          total={t.cotizaciones}
        />
      </Bloque>

      {/* ---- Concentración ---- */}
      <Bloque
        titulo="Concentración de corredores"
        nota={`Los 10 más grandes concentran ${pct(conc.top10_cotizaciones, conc.b2b_cotizaciones)} del B2B.`}
      >
        <Lista
          filas={a.top_corredores.map((c) => ({
            label: c.asesor,
            valor: c.cotizaciones,
            extra: `${c.clientes} clientes`,
          }))}
          total={conc.b2b_cotizaciones}
        />
      </Bloque>

      {/* ---- Repetición ---- */}
      <Bloque
        titulo="Clientes por número de cotizaciones"
        nota="Volver al mismo cliente suele ser grupo familiar (una cotización por edad) o comparativa de planes."
      >
        <BarraApilada
          partes={[
            { label: "1 cotización", valor: rep.una, color: "#cbd5e1" },
            { label: "2 a 5", valor: rep.dos_a_cinco, color: C_B2B },
            { label: "6 o más", valor: rep.seis_o_mas, color: "#f59e0b" },
          ]}
          total={clientesRep}
        />
      </Bloque>

      {/* ---- Prima ---- */}
      <Bloque
        titulo="Prima anual"
        nota={`Solo ${n(a.prima.con_dato)} de ${n(a.prima.con_dato + a.prima.sin_dato)} cotizaciones traen el monto (${pct(
          a.prima.con_dato,
          a.prima.con_dato + a.prima.sin_dato,
        )}). Lo de abajo es de esas, no del total.`}
      >
        <div className="mb-2 flex gap-2">
          <Cifra label="Promedio" valor={money(a.prima.promedio)} pie="" />
          <Cifra label="Mediana" valor={money(a.prima.mediana)} pie="" />
        </div>
        <Lista
          filas={a.prima.por_plan.map((p) => ({
            label: p.plan,
            valor: Math.round(p.promedio),
            extra: `${n(p.n)} con monto`,
          }))}
          total={Math.max(...a.prima.por_plan.map((p) => p.promedio), 1)}
          formato={(v) => money(v)}
        />
      </Bloque>
    </div>
  );
}

// ---------------------------------------------------------------- primitivas

function Bloque({ titulo, nota, children }: { titulo: string; nota?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold tracking-tight text-neutral-900">{titulo}</h4>
      {nota && <p className="text-[11px] leading-relaxed text-neutral-500">{nota}</p>}
      {children}
    </section>
  );
}

function Cifra({ label, valor, pie }: { label: string; valor: string; pie: string }) {
  return (
    <div className="flex-1 rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-neutral-900">{valor}</div>
      {pie && <div className="text-[10px] text-neutral-400">{pie}</div>}
    </div>
  );
}

const C_SIN = "#cbd5e1";

function Leyenda({ conSinAtribucion = false }: { conSinAtribucion?: boolean }) {
  return (
    <div className="flex gap-3 text-[10px] text-neutral-500">
      <span className="flex items-center gap-1">
        <i className="inline-block h-2 w-2 rounded-sm" style={{ background: C_B2B }} /> B2B
      </span>
      <span className="flex items-center gap-1">
        <i className="inline-block h-2 w-2 rounded-sm" style={{ background: C_B2C }} /> B2C
      </span>
      {conSinAtribucion && (
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm" style={{ background: C_SIN }} /> sin atribución
        </span>
      )}
    </div>
  );
}

// Lo que no es ni B2C ni B2B son los tickets con Asesor vacío en Zoho. Si no
// se pintaran, la fila mostraria un número con la barra vacía.
const resto = (f: { total: number; b2c: number; b2b: number }) => Math.max(0, f.total - f.b2b - f.b2c);
const haySinAtribucion = (fs: { total: number; b2c: number; b2b: number }[]) => fs.some((f) => resto(f) > 0);

function BarraApilada({
  partes,
  total,
}: {
  partes: { label: string; valor: number; color: string }[];
  total: number;
}) {
  const vivos = partes.filter((p) => p.valor > 0);
  return (
    <div className="space-y-2">
      <div className="flex h-6 overflow-hidden rounded-lg bg-neutral-100">
        {vivos.map((p) => (
          <div
            key={p.label}
            style={{ width: `${(p.valor / Math.max(total, 1)) * 100}%`, background: p.color }}
            title={`${p.label}: ${n(p.valor)}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {vivos.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5 text-[11px] text-neutral-600">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} />
            {p.label}
            <span className="font-medium tabular-nums text-neutral-900">{n(p.valor)}</span>
            <span className="text-neutral-400">{pct(p.valor, total)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Barras horizontales partidas B2C/B2B, a escala de la fila más grande. */
function Barras({ filas }: { filas: { label: string; b2c: number; b2b: number; total: number }[] }) {
  const max = Math.max(...filas.map((f) => f.total), 1);
  return (
    <div className="space-y-2">
      <Leyenda conSinAtribucion={haySinAtribucion(filas)} />
      {filas.map((f) => (
        <div key={f.label} className="flex items-center gap-2">
          <div className="w-24 shrink-0 truncate text-[11px] text-neutral-600" title={f.label}>
            {f.label}
          </div>
          <div className="flex h-4 flex-1 overflow-hidden rounded-full bg-neutral-100">
            <div
              style={{ width: `${(f.b2b / max) * 100}%`, background: C_B2B }}
              title={`B2B: ${n(f.b2b)}`}
            />
            <div
              style={{ width: `${(f.b2c / max) * 100}%`, background: C_B2C }}
              title={`B2C: ${n(f.b2c)}`}
            />
            <div
              style={{ width: `${(resto(f) / max) * 100}%`, background: C_SIN }}
              title={`Sin atribución: ${n(resto(f))}`}
            />
          </div>
          <div className="w-14 shrink-0 text-right text-[11px] font-medium tabular-nums text-neutral-700">
            {n(f.total)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Columnas verticales para los tramos de edad (el orden importa, es un eje). */
function Histograma({ filas }: { filas: { label: string; b2c: number; b2b: number; total: number }[] }) {
  const vivos = filas.filter((f) => f.total > 0);
  const max = Math.max(...vivos.map((f) => f.total), 1);
  return (
    <div className="space-y-2">
      <Leyenda conSinAtribucion={haySinAtribucion(vivos)} />
      <div className="flex h-32 gap-1.5">
        {vivos.map((f) => (
          <div key={f.label} className="flex h-full flex-1 flex-col items-center gap-1">
            <span className="text-[10px] tabular-nums text-neutral-500">{n(f.total)}</span>
            {/* flex-1 con altura definida arriba: es lo que hace que el
                `height: %` de la barra tenga contra qué resolver. */}
            <div className="flex w-full flex-1 flex-col justify-end">
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t"
                style={{ height: `${(f.total / max) * 100}%`, minHeight: 3 }}
                title={`${f.label}: ${n(f.total)} (B2B ${n(f.b2b)} · B2C ${n(f.b2c)})`}
              >
                <div style={{ height: `${(f.b2b / f.total) * 100}%`, background: C_B2B }} />
                <div style={{ height: `${(f.b2c / f.total) * 100}%`, background: C_B2C }} />
                <div style={{ height: `${(resto(f) / f.total) * 100}%`, background: C_SIN }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-1.5">
        {vivos.map((f) => (
          <div key={f.label} className="flex-1 text-center text-[10px] text-neutral-500">
            {f.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Matriz plan × rango de edad, sombreada por volumen. */
function Cruce({ celdas }: { celdas: { plan: string; rango: string; n: number }[] }) {
  if (celdas.length === 0) return <p className="text-[11px] text-neutral-400">Sin datos.</p>;
  // Se preserva el orden en que vienen (plan por volumen, edad ascendente):
  // la matriz se lee como ejes, no alfabéticamente.
  const unicos = (vs: string[]) => vs.filter((v, i) => vs.indexOf(v) === i);
  const planes = unicos(celdas.map((c) => c.plan));
  const rangos = unicos(celdas.map((c) => c.rango));
  const mapa = new Map(celdas.map((c) => [`${c.plan}|${c.rango}`, c.n]));
  const max = Math.max(...celdas.map((c) => c.n), 1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px]">
        <thead>
          <tr>
            <th className="p-1" />
            {rangos.map((r) => (
              <th key={r} className="p-1 text-center font-medium text-neutral-500">
                {r}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {planes.map((p) => (
            <tr key={p}>
              <td className="whitespace-nowrap py-1 pr-2 text-neutral-600">{p}</td>
              {rangos.map((r) => {
                const v = mapa.get(`${p}|${r}`) ?? 0;
                return (
                  <td key={r} className="p-0.5">
                    <div
                      className="rounded py-1 text-center tabular-nums"
                      style={{
                        // Alpha por volumen: el 0 queda casi blanco y se lee
                        // como hueco, no como dato.
                        background: `rgba(14,165,233,${(v / max) * 0.85 + 0.04})`,
                        color: v / max > 0.55 ? "#fff" : "#334155",
                      }}
                      title={`${p} · ${r}: ${n(v)}`}
                    >
                      {v > 0 ? n(v) : "·"}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Meses({ filas }: { filas: { mes: string; b2c: number; b2b: number; total: number }[] }) {
  // Los meses con casi nada (arranque del histórico) aplastan la escala.
  const vivos = filas.filter((f) => f.total >= 10);
  if (vivos.length === 0) return <p className="text-[11px] text-neutral-400">Sin datos.</p>;
  const max = Math.max(...vivos.map((f) => f.total), 1);
  const omitidos = filas.length - vivos.length;

  return (
    <div className="space-y-2">
      <Leyenda />
      <div className="flex h-28 gap-1">
        {vivos.map((f) => (
          <div key={f.mes} className="flex h-full flex-1 flex-col items-center gap-1">
            <div className="flex w-full flex-1 flex-col justify-end">
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t"
                style={{ height: `${(f.total / max) * 100}%`, minHeight: 3 }}
                title={`${f.mes}: ${n(f.total)} (B2B ${n(f.b2b)} · B2C ${n(f.b2c)})`}
              >
                <div style={{ height: `${(f.b2b / f.total) * 100}%`, background: C_B2B }} />
                <div style={{ height: `${(f.b2c / f.total) * 100}%`, background: C_B2C }} />
              </div>
            </div>
            <span className="text-[9px] text-neutral-500">{f.mes.slice(5)}</span>
          </div>
        ))}
      </div>
      {omitidos > 0 && (
        <p className="text-[10px] text-neutral-400">
          {omitidos} mes(es) con menos de 10 cotizaciones no se grafican (aplastan la escala).
        </p>
      )}
    </div>
  );
}

function Lista({
  filas,
  total,
  formato = (v: number) => n(v),
}: {
  filas: { label: string; valor: number; extra?: string }[];
  total: number;
  formato?: (v: number) => string;
}) {
  const max = Math.max(...filas.map((f) => f.valor), 1);
  return (
    <div className="space-y-1.5">
      {filas.map((f) => (
        <div key={f.label} className="flex items-center gap-2">
          <div className="w-28 shrink-0 truncate text-[11px] text-neutral-600" title={f.label}>
            {f.label}
          </div>
          <div className="relative h-4 flex-1 overflow-hidden rounded-full bg-neutral-100">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max((f.valor / max) * 100, 1)}%`, background: C_B2B }}
            />
          </div>
          {f.extra && <span className="w-20 shrink-0 text-right text-[10px] text-neutral-400">{f.extra}</span>}
          <div className="w-14 shrink-0 text-right text-[11px] font-medium tabular-nums text-neutral-700">
            {formato(f.valor)}
          </div>
        </div>
      ))}
      {total > 0 && null}
    </div>
  );
}

function IconoBarras() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="9" width="3" height="5.5" rx="1" fill="currentColor" />
      <rect x="6.5" y="5" width="3" height="9.5" rx="1" fill="currentColor" />
      <rect x="11.5" y="1.5" width="3" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}
