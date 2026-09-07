import { createSupabaseServerClient } from "@/lib/supabase/server";
import { StatRow, StatCard, Users, Target, TrendUp, Check } from "@/components/ui";
import { ListaCorredores } from "./corredores";
import { PanelAnalitica } from "./analitica-panel";
import { TablaEfectividad, type CorredorEfec } from "./efectividad";
import { CargarEmisiones } from "./cargar-emisiones";
import { RevisarAlias } from "./alias-corredores";

// Vista "Destinos": a dónde va cada ticket de Zoho.
//
// En Zoho entran dos cosas distintas mezcladas: un cliente final pidiendo
// cotización (va al agente, B2C) y un corredor de seguros tramitando a SUS
// clientes (va al embudo B2B). Esta vista las separa y, del lado B2B, permite
// leerlo por intermediario: qué corredor manda cuánto y a qué clientes.

type Overview = {
  b2c_tickets: number;
  b2c_en_kommo: number;
  b2c_clientes: number;
  b2b_tickets: number;
  b2b_en_kommo: number;
  b2b_clientes: number;
  b2b_corredores: number;
  sin_atribucion_tickets: number;
  corredores: {
    asesor: string;
    asesor_original: string | null;
    cotizaciones: number;
    clientes: number;
    en_kommo: number;
    ultima: string | null;
  }[];
};

// Lo que devuelve zoho_corredores_efectividad(). `sin_datos` llega cuando
// todavía no se ha cargado ningún Reporte de Emisión.
type Efectividad = {
  sin_datos?: boolean;
  mensaje?: string;
  parcial?: boolean;
  nota_parcial?: string;
  periodo_emisiones?: { desde: string | null; hasta: string | null };
  ventana_cotizaciones?: { desde: string | null; hasta: string | null };
  corredores: CorredorEfec[];
  totales?: {
    corredores: number;
    sin_mapear: number;
    cotiz_en_ventana: number;
    cotiz_cerradas: number;
    cotiz_en_curso: number;
    clientes_en_ventana: number;
    clientes_cerrados: number;
    cerradas_otro: number;
    efec_cotizaciones: number | null;
    efec_clientes: number | null;
  };
  emisiones?: {
    polizas: number;
    vigentes: number;
    anuladas: number;
    con_cotizacion: number;
    sin_cotizacion: number;
    pct_con_cotizacion: number | null;
  };
};

const fmtDia = (s: string | null | undefined) =>
  s ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`).toLocaleDateString("es-VE", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export async function DestinosView({ since }: { since: string | null }) {
  const supabase = createSupabaseServerClient();
  // Las dos en paralelo: la de efectividad tarda ~150ms y no depende de la otra.
  const [{ data, error }, { data: efecData, error: efecError }] = await Promise.all([
    supabase.rpc("zoho_pipeline_overview", { p_since: since }),
    supabase.rpc("zoho_corredores_efectividad", { p_since: since, p_maduracion_dias: 60 }),
  ]);
  const ov = (data ?? null) as Overview | null;
  const efec = (efecData ?? null) as Efectividad | null;

  if (error || !ov) {
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        No se pudo cargar: {error?.message ?? "sin datos"}
      </p>
    );
  }

  const pendienteB2c = ov.b2c_tickets - ov.b2c_en_kommo;
  const pendienteB2b = ov.b2b_tickets - ov.b2b_en_kommo;

  return (
    <PanelAnalitica since={since}>
      <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight text-neutral-900">A dónde va cada ticket</h2>
        <StatRow>
          <StatCard
            label="Al agente (B2C)"
            value={ov.b2c_tickets}
            hint={`${ov.b2c_en_kommo} ya en Kommo · ${pendienteB2c} por migrar`}
            icon={<Target size={14} />}
            tone="brand"
          />
          <StatCard
            label="A corredores (B2B)"
            value={ov.b2b_tickets}
            hint={`${ov.b2b_en_kommo} ya en Kommo · ${pendienteB2b} por migrar`}
            icon={<Users size={14} />}
            tone="default"
          />
          <StatCard
            label="Corredores distintos"
            value={ov.b2b_corredores}
            hint={`${ov.b2b_clientes} clientes finales`}
            icon={<TrendUp size={14} />}
            tone="default"
          />
          <StatCard
            label="Sin atribución"
            value={ov.sin_atribucion_tickets}
            hint={
              ov.sin_atribucion_tickets > 0
                ? "Asesor vacío en Zoho"
                : "todo clasificado"
            }
            tone={ov.sin_atribucion_tickets > 0 ? "amber" : "emerald"}
          />
        </StatRow>
        <p className="text-[11px] text-neutral-400">
          La regla es la misma que usa la migración a Kommo: el campo <span className="font-mono">Asesor</span> del
          ticket. Si dice &quot;No tengo&quot;, &quot;Sin Asesor&quot;, &quot;Seguros Venezuela&quot;, &quot;Directo
          Caracas&quot; o &quot;No Posee&quot;, es un cliente final y va al agente; cualquier otro nombre es un
          corredor tramitando a su cliente.
          {ov.sin_atribucion_tickets > 0 && (
            <>
              {" "}
              Los <span className="font-medium text-amber-700">{ov.sin_atribucion_tickets} sin atribución</span> tienen
              ese campo vacío en el propio Zoho. Desde el 06-09 <strong>sí migran a Kommo, al embudo B2C</strong> (un
              cliente sin corredor es un cliente final), pero se cuentan aparte acá porque no hay corredor al que
              atribuirles la venta — eso solo se arregla llenando el campo en Zoho.
            </>
          )}
        </p>
      </section>

      {/* ── Efectividad: cotizado vs. emitido ──────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
            Efectividad: de lo cotizado, cuánto se emitió
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {efec?.totales && efec.totales.sin_mapear > 0 && (
              <RevisarAlias
                sinMapear={efec.totales.sin_mapear}
                totalCorredores={efec.totales.corredores}
              />
            )}
            <CargarEmisiones
              periodoCargado={
                efec?.periodo_emisiones?.desde
                  ? `${fmtDia(efec.periodo_emisiones.desde)} – ${fmtDia(efec.periodo_emisiones.hasta)}`
                  : null
              }
            />
          </div>
        </div>

        {efecError && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            No se pudo calcular la efectividad: {efecError.message}
          </p>
        )}

        {!efecError && efec?.sin_datos && (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center">
            <p className="text-sm text-neutral-600">{efec.mensaje}</p>
            <p className="mt-1 text-xs text-neutral-400">
              El cruce es por cédula del tomador o del asegurado contra la cédula del asunto del ticket.
            </p>
          </div>
        )}

        {!efecError && efec && !efec.sin_datos && efec.totales && efec.emisiones && (
          <>
            <StatRow>
              <StatCard
                label="Efectividad por cotizaciones"
                value={efec.totales.efec_cotizaciones === null ? "—" : `${efec.totales.efec_cotizaciones}%`}
                hint={`${efec.totales.cotiz_cerradas} cerradas de ${efec.totales.cotiz_en_ventana} en ventana`}
                icon={<Target size={14} />}
                tone="brand"
              />
              <StatCard
                label="Efectividad por clientes"
                value={efec.totales.efec_clientes === null ? "—" : `${efec.totales.efec_clientes}%`}
                hint={`${efec.totales.clientes_cerrados} clientes emitidos de ${efec.totales.clientes_en_ventana}`}
                icon={<Users size={14} />}
                tone="brand"
              />
              <StatCard
                label="Pólizas emitidas cargadas"
                value={efec.emisiones.polizas}
                hint={`${efec.emisiones.vigentes} vigentes · ${efec.emisiones.anuladas} anuladas`}
                icon={<Check size={14} />}
                tone="default"
              />
              <StatCard
                label="Emitidas que sí cotizaron"
                value={efec.emisiones.pct_con_cotizacion === null ? "—" : `${efec.emisiones.pct_con_cotizacion}%`}
                hint={`${efec.emisiones.con_cotizacion} de ${efec.emisiones.polizas} · ${efec.emisiones.sin_cotizacion} sin cotización previa`}
                icon={<TrendUp size={14} />}
                tone="default"
              />
            </StatRow>

            {/* El aviso de parcialidad NO es decorativo: con un solo mes de
                emisiones el porcentaje es un suelo, y sin decirlo se leería
                como el desempeño real de los corredores. */}
            {efec.parcial && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                <strong>Los dos primeros porcentajes son un suelo, no la cifra final.</strong> {efec.nota_parcial} Solo
                se juzgan las cotizaciones nacidas entre{" "}
                <strong>{fmtDia(efec.ventana_cotizaciones?.desde)}</strong> y{" "}
                <strong>{fmtDia(efec.ventana_cotizaciones?.hasta)}</strong>, que son las que pudieron emitirse dentro
                del rango cargado; las anteriores probablemente emitieron antes de ese rango y no hay dato, y las{" "}
                {efec.totales.cotiz_en_curso > 0 && (
                  <>
                    <strong>{efec.totales.cotiz_en_curso}</strong> posteriores{" "}
                  </>
                )}
                todavía no han tenido tiempo. El desfase medido entre cotizar y emitir es de 12 días de mediana, pero
                llega a 57 en el 10% de los casos. La cuarta tarjeta, en cambio, no depende de ninguna ventana: es el
                dato firme.
              </p>
            )}

            {efec.totales.sin_mapear > 0 && (
              <p className="text-[11px] text-neutral-500">
                {efec.totales.sin_mapear} de {efec.totales.corredores} nombres de Zoho todavía no están ligados a un
                código del sistema central: son corredores que no aparecen en los meses de emisión cargados, así que no
                se les puede acreditar ni negar ningún cierre. Se van ligando solos al cargar más meses, o a mano
                desde <strong>Revisar corredores</strong>.
                {efec.totales.cerradas_otro > 0 && (
                  <>
                    {" "}
                    Aparte, <strong>{efec.totales.cerradas_otro}</strong> cotizaciones acabaron en póliza pero con un
                    intermediario distinto del que cotizó.
                  </>
                )}
              </p>
            )}

            <TablaEfectividad corredores={efec.corredores ?? []} />
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
          B2B por corredor
        </h2>
        <p className="text-[11px] text-neutral-500">
          Despliega un corredor para ver sus clientes y, dentro de cada cliente, todas sus cotizaciones. Los clientes
          agrupan por cédula + titular, así que varias cotizaciones a la misma persona (normalmente un grupo familiar,
          una por edad) quedan juntas, sin fusionar a gente distinta que comparte una cédula de relleno.
        </p>
        <ListaCorredores corredores={ov.corredores} since={since} />
      </section>
      </div>
    </PanelAnalitica>
  );
}
