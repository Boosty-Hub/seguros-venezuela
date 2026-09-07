"use client";

// Pestañas "Emisiones" y "Efectividad" del panel de analítica de /pipeline.
//
// Los datos vienen de `zoho_emisiones_analitica()` (migración 0077) y hablan
// del sistema central de pólizas, no de Zoho. Están separadas de la pestaña de
// cotizaciones a propósito: cada fuente tiene su propia ventana temporal (Zoho
// arranca en jul-2025, las emisiones solo cubren los meses que se hayan
// cargado) y sumar entre ellas daría números que no significan nada.
//
// Dos cosas que el CSV NO permite y que por eso no se grafican: cuándo se
// anuló una póliza (no hay fecha) y por qué (un único motivo para todas). La
// función lo devuelve como nota y acá se muestra en vez de fingir el dato.

import {
  Bloque,
  Cifra,
  FilaMedida,
  BarrasDia,
  C_B2B,
  C_SIN,
  C_PRIMA,
  C_ANULADA,
  C_PENDIENTE,
  n,
  pct,
  usd,
  usdFino,
  dias,
} from "./analitica-primitivas";

export type Emisiones = {
  sin_datos?: boolean;
  mensaje?: string;
  error?: string;
  periodo?: { desde: string | null; hasta: string | null };
  totales?: {
    polizas: number;
    recibos: number;
    vigentes: number;
    anuladas: number;
    tasa_anulacion: number | null;
    clientes: number;
    prima_facturada: number;
    prima_vigente: number;
    comision: number;
    suma_asegurada: number;
    ticket_medio: number | null;
  };
  cartera?: { estatus: string; recibos: number; prima: number; comision: number }[];
  anulaciones?: {
    polizas: number;
    prima: number;
    comision: number;
    nota: string;
    por_corredor: { nombre: string; emitidas: number; anuladas: number; tasa: number }[];
    por_plan_pago: { label: string; emitidas: number; anuladas: number; tasa: number }[];
  };
  producto?: {
    por_suma: { suma: number; polizas: number; prima_media: number | null; anuladas: number }[];
    por_plan_pago: { label: string; polizas: number; prima: number }[];
    por_beneficiarios: { label: string; polizas: number }[];
    nota_prima?: string;
  };
  diario?: { dia: string; polizas: number; prima: number }[];
  canal?: { label: string; polizas: number; prima: number }[];
  top_corredores?: {
    nombre: string;
    polizas: number;
    prima: number;
    comision: number;
    anuladas: number;
    con_cotizacion: number;
  }[];
  cruce?: { polizas: number; con_cotizacion: number; sin_cotizacion: number; pct_con: number | null };
  desfase?: {
    n: number;
    mediana: number | null;
    p25: number | null;
    p75: number | null;
    p90: number | null;
    maximo: number | null;
    nota: string;
    buckets: { label: string; n: number }[];
  };
};

/** Estado vacío o de error, compartido por las dos pestañas. */
function SinEmisiones({ e }: { e: Emisiones | null }) {
  if (e?.error) {
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        No se pudo calcular la analítica de emisiones: {e.error}
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-8 text-center">
      <p className="text-sm text-neutral-600">{e?.mensaje ?? "Todavía no hay emisiones cargadas."}</p>
      <p className="mt-1 text-xs text-neutral-400">
        Se cargan con el botón &quot;Cargar emisiones&quot;, en la sección de efectividad.
      </p>
    </div>
  );
}

export function ContenidoEmisiones({ e }: { e: Emisiones | null }) {
  if (!e || e.sin_datos || e.error || !e.totales) return <SinEmisiones e={e} />;
  const t = e.totales;
  const cartera = e.cartera ?? [];
  const totalCartera = cartera.reduce((acc, c) => acc + Number(c.prima), 0);
  const cobrado = cartera.find((c) => /cobrado/i.test(c.estatus));
  const diario = e.diario ?? [];
  const prod = e.producto;
  const anul = e.anulaciones;

  return (
    <div className="space-y-5">
      <div data-stat-row className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Cifra label="Pólizas" valor={n(t.polizas)} pie={`${n(t.recibos)} recibos · ${n(t.clientes)} clientes`} />
        <Cifra
          label="Prima facturada"
          valor={usd(t.prima_facturada)}
          pie={`${usd(t.prima_vigente)} en pólizas vigentes`}
        />
        <Cifra label="Comisión" valor={usd(t.comision)} pie={`${usd(t.ticket_medio)} facturado por póliza`} />
        <Cifra
          label="Anuladas"
          valor={`${n(t.anuladas)}${t.tasa_anulacion == null ? "" : ` · ${t.tasa_anulacion}%`}`}
          pie={`de ${n(t.polizas)} emitidas`}
        />
      </div>

      {/* ── Cartera ─────────────────────────────────────────────────── */}
      <Bloque
        titulo="Cartera: dónde está el dinero"
        nota={
          cobrado
            ? `${pct(Number(cobrado.prima), totalCartera)} de lo facturado está cobrado; el resto está por cobrar o se anuló.`
            : undefined
        }
      >
        <div className="space-y-2">
          {cartera.map((c) => {
            const esAnulado = /anulad/i.test(c.estatus);
            const esPend = /pendiente/i.test(c.estatus);
            const color = esAnulado ? C_ANULADA : esPend ? C_PENDIENTE : C_PRIMA;
            const ancho = totalCartera > 0 ? (Number(c.prima) / totalCartera) * 100 : 0;
            return (
              <div key={c.estatus}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[11px]">
                  <span className="text-neutral-700">{c.estatus}</span>
                  <span className="tabular-nums text-neutral-500">
                    <strong className="text-neutral-800">{usdFino(c.prima)}</strong> · {n(c.recibos)} recibos ·
                    comisión {usd(c.comision)}
                  </span>
                </div>
                <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-neutral-100">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(1, ancho)}%`, background: color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-neutral-400">
          Esto es prima de <strong>recibo</strong> (lo que se factura en cada cuota), no la prima anual de la póliza:
          el estatus de cobro es del recibo, así que es la única que se puede repartir así.
        </p>
      </Bloque>

      {/* ── Evolución diaria ────────────────────────────────────────── */}
      {diario.length > 1 && (
        <Bloque titulo="Suscripción por día" nota="Pólizas suscritas cada día del periodo cargado.">
          <BarrasDia filas={diario} />
        </Bloque>
      )}

      {/* ── Producto ────────────────────────────────────────────────── */}
      {prod && (
        <>
          <Bloque
            titulo="Suma asegurada"
            nota="Cuanto más alta la cobertura, más alta la prima — y menos pólizas. La prima es la FACTURADA en el periodo, no una tarifa anual."
          >
            <div className="space-y-1.5">
              {prod.por_suma.map((r) => (
                <FilaMedida
                  key={r.suma}
                  label={usd(r.suma)}
                  valor={r.polizas}
                  max={Math.max(...prod.por_suma.map((x) => x.polizas), 1)}
                  derecha={`${usd(r.prima_media)} facturado medio`}
                  color={C_PRIMA}
                />
              ))}
            </div>
          </Bloque>

          <Bloque titulo="Plan de pago" nota="Cómo eligen pagar los asegurados, y cuánto se ha facturado bajo cada plan.">
            <div className="space-y-1.5">
              {prod.por_plan_pago.map((r) => (
                <FilaMedida
                  key={r.label}
                  label={r.label}
                  valor={r.polizas}
                  max={Math.max(...prod.por_plan_pago.map((x) => x.polizas), 1)}
                  derecha={`${usd(r.prima)} facturado`}
                />
              ))}
            </div>
            {prod.nota_prima && (
              <p className="mt-2 text-[10px] leading-relaxed text-amber-700">
                A propósito NO se muestra prima media por plan: {prod.nota_prima}
              </p>
            )}
          </Bloque>

          <Bloque titulo="Personas por póliza" nota="Beneficiarios además del titular: el tamaño del grupo asegurado.">
            <div className="space-y-1.5">
              {prod.por_beneficiarios.map((r) => (
                <FilaMedida
                  key={r.label}
                  label={`${r.label} benef.`}
                  valor={r.polizas}
                  max={Math.max(...prod.por_beneficiarios.map((x) => x.polizas), 1)}
                />
              ))}
            </div>
          </Bloque>
        </>
      )}

      {/* ── Anulaciones ─────────────────────────────────────────────── */}
      {anul && anul.polizas > 0 && (
        <Bloque titulo="Anulaciones">
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Cifra label="Prima anulada" valor={usd(anul.prima)} pie="facturada y caída" />
            <Cifra label="Comisión afectada" valor={usd(anul.comision)} pie="sobre esos recibos" />
          </div>

          {anul.por_plan_pago.length > 0 && (
            <>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">Por plan de pago</p>
              <div className="mb-3 space-y-1.5">
                {anul.por_plan_pago.map((r) => (
                  <FilaMedida
                    key={r.label}
                    label={r.label}
                    valor={r.anuladas}
                    max={Math.max(...anul.por_plan_pago.map((x) => x.anuladas), 1)}
                    derecha={`${r.tasa}% de ${n(r.emitidas)}`}
                    color={C_ANULADA}
                  />
                ))}
              </div>
            </>
          )}

          {anul.por_corredor.length > 0 && (
            <>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">
                Corredores que las concentran
              </p>
              <div className="space-y-1.5">
                {anul.por_corredor.map((r) => (
                  <FilaMedida
                    key={r.nombre}
                    label={r.nombre}
                    valor={r.anuladas}
                    max={Math.max(...anul.por_corredor.map((x) => x.anuladas), 1)}
                    derecha={`${r.tasa}% de ${n(r.emitidas)}`}
                    color={C_ANULADA}
                    anchoLabel="w-40"
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-neutral-400">
                Solo corredores con 3 emisiones o más: con 1 anulada de 1 emitida la tasa sería 100% y no diría nada.
              </p>
            </>
          )}

          <p className="mt-2 text-[10px] leading-relaxed text-amber-700">{anul.nota}</p>
        </Bloque>
      )}

      {/* ── Canal ───────────────────────────────────────────────────── */}
      {e.canal && e.canal.length > 1 && (
        <Bloque titulo="Canal de negocio">
          <div className="space-y-1.5">
            {e.canal.map((r) => (
              <FilaMedida
                key={r.label}
                label={r.label}
                valor={r.polizas}
                max={Math.max(...e.canal!.map((x) => x.polizas), 1)}
                derecha={usd(r.prima)}
              />
            ))}
          </div>
        </Bloque>
      )}

      {/* ── Concentración ───────────────────────────────────────────── */}
      {e.top_corredores && e.top_corredores.length > 0 && (
        <Bloque
          titulo="Quién emite el volumen"
          nota="Los 12 primeros por prima facturada, con su comisión y cuántas de sus pólizas venían de una cotización en Zoho."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="text-neutral-400">
                <tr>
                  <th className="pb-1 font-medium">Corredor</th>
                  <th className="pb-1 text-right font-medium">Pólizas</th>
                  <th className="pb-1 text-right font-medium">Prima</th>
                  <th className="pb-1 text-right font-medium">Comisión</th>
                  <th className="pb-1 text-right font-medium">Cotizó</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {e.top_corredores.map((r) => (
                  <tr key={r.nombre}>
                    <td className="max-w-[190px] truncate py-1 pr-2 text-neutral-700" title={r.nombre}>
                      {r.nombre}
                    </td>
                    <td className="py-1 text-right tabular-nums text-neutral-600">
                      {n(r.polizas)}
                      {r.anuladas > 0 && (
                        <span className="text-red-500" title={`${r.anuladas} anuladas`}>
                          {" "}
                          −{r.anuladas}
                        </span>
                      )}
                    </td>
                    <td className="py-1 text-right font-medium tabular-nums text-neutral-800">{usd(r.prima)}</td>
                    <td className="py-1 text-right tabular-nums text-neutral-600">{usd(r.comision)}</td>
                    <td className="py-1 text-right tabular-nums text-neutral-500">
                      {r.con_cotizacion}/{r.polizas}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Bloque>
      )}
    </div>
  );
}

export function ContenidoEfectividad({ e }: { e: Emisiones | null }) {
  if (!e || e.sin_datos || e.error || !e.cruce) return <SinEmisiones e={e} />;
  const c = e.cruce;
  const d = e.desfase;
  const maxB = d ? Math.max(...d.buckets.map((b) => b.n), 1) : 1;

  return (
    <div className="space-y-5">
      <div data-stat-row className="grid grid-cols-3 gap-2">
        <Cifra label="Pólizas emitidas" valor={n(c.polizas)} pie="en el periodo cargado" />
        <Cifra
          label="Venían de cotización"
          valor={c.pct_con == null ? "—" : `${c.pct_con}%`}
          pie={`${n(c.con_cotizacion)} de ${n(c.polizas)}`}
        />
        <Cifra label="Sin cotizar en Zoho" valor={n(c.sin_cotizacion)} pie="vendidas por otro canal" />
      </div>

      <Bloque
        titulo="De lo emitido, cuánto pasó por Zoho"
        nota="Es la medida que NO depende de ninguna ventana temporal, y por eso la fiable con un solo mes cargado."
      >
        <div className="flex h-3 overflow-hidden rounded-full bg-neutral-100">
          <div
            className="h-full"
            style={{
              width: `${c.polizas > 0 ? (c.con_cotizacion / c.polizas) * 100 : 0}%`,
              background: C_B2B,
            }}
            title={`Con cotización previa: ${n(c.con_cotizacion)}`}
          />
          <div
            className="h-full"
            style={{
              width: `${c.polizas > 0 ? (c.sin_cotizacion / c.polizas) * 100 : 0}%`,
              background: C_SIN,
            }}
            title={`Sin cotización: ${n(c.sin_cotizacion)}`}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-neutral-500">
          <span className="inline-flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: C_B2B }} /> con cotización previa
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: C_SIN }} /> sin cotización
          </span>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-neutral-400">
          Las que no cotizaron no son un fallo de datos: son corredores que venden sin pasar por Zoho Desk. Es el
          tamaño real de ese canal.
        </p>
      </Bloque>

      {d && d.n > 0 && (
        <Bloque titulo="Cuánto tarda una cotización en volverse póliza">
          <div className="mb-3 grid grid-cols-4 gap-2">
            <Cifra label="Mediana" valor={dias(d.mediana)} pie="" />
            <Cifra label="p75" valor={dias(d.p75)} pie="3 de cada 4" />
            <Cifra label="p90" valor={dias(d.p90)} pie="9 de cada 10" />
            <Cifra label="Máximo" valor={dias(d.maximo)} pie="" />
          </div>
          <div className="space-y-1.5">
            {d.buckets.map((b) => (
              <FilaMedida
                key={b.label}
                label={b.label}
                valor={b.n}
                max={maxB}
                derecha={pct(b.n, d.n)}
                anchoLabel="w-32"
              />
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-neutral-400">
            {d.nota} Medido sobre {n(d.n)} pólizas que sí cruzaron. Es lo que justifica no juzgar una cotización
            recién nacida: a los {dias(d.p90)} todavía se está emitiendo el 10%.
          </p>
        </Bloque>
      )}
    </div>
  );
}
