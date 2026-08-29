import { createSupabaseServerClient } from "@/lib/supabase/server";
import { StatRow, StatCard, Users, Target, TrendUp } from "@/components/ui";
import { ListaCorredores } from "./corredores";

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

export async function DestinosView({ since }: { since: string | null }) {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc("zoho_pipeline_overview", { p_since: since });
  const ov = (data ?? null) as Overview | null;

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
              ese campo vacío en el propio Zoho, así que no hay forma de saber si vienen de un corredor o de un cliente
              final — se completan al llenarlo allá.
            </>
          )}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
          B2B por corredor
        </h2>
        <p className="text-[11px] text-neutral-500">
          Despliega un corredor para ver sus clientes y, dentro de cada cliente, todas sus cotizaciones. Los clientes
          agrupan por cédula, así que varias cotizaciones a la misma persona (normalmente un grupo familiar, una por
          edad) quedan juntas.
        </p>
        <ListaCorredores corredores={ov.corredores} since={since} />
      </section>
    </div>
  );
}
