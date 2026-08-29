import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell, StatRow, StatCard, EmptyState, BarChart3 } from "@/components/ui";
import { LineAreaChart, BarBreakdown } from "../consumo/charts";

export const dynamic = "force-dynamic";

type SearchParams = { rango?: string };

const RANGE_OPTIONS: { value: string; label: string; days: number | null }[] = [
  { value: "7d", label: "7 días", days: 7 },
  { value: "30d", label: "30 días", days: 30 },
  { value: "90d", label: "90 días", days: 90 },
  { value: "all", label: "Todo", days: null },
];

type Overview = {
  since: string;
  leads_entrantes: number;
  leads_por_dia: { dia: string; leads: number }[];
  atendidos_por_agente: number;
  transferidos_humano: number;
  transferidos_ganados: number;
  transferidos_perdidos: number;
  ganados_totales: number;
  perdidos_totales: number;
  por_vertical: { slug: string; name: string; leads: number; mensajes: number }[];
  por_canal: { canal: string; leads: number }[];
  por_intencion: { intent: string; menciones: number }[];
  volumen_diario: { dia: string; inbound: number; outbound: number }[];
  tiempo_respuesta_prom_seg: number | null;
  mensajes_total: number;
  mensajes_por_lead_prom: number;
  // Contexto de calidad del dato (0063): permiten leer bien los gráficos de
  // canal e intención sin que el ruido se disfrace de categoría.
  leads_con_conversacion?: number;
  leads_sin_conversacion?: number;
  mensajes_sin_clasificar?: number;
  fallos_clasificador?: number;
  mensajes_ignorados?: number;
  mensajes_sin_contenido?: number;
};

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  telegram: "Telegram",
  // No existe un canal "Otro": si aparece esto es un dato faltante, no una
  // categoría (ver 0063 — antes los leads de Zoho sin chat caían acá).
  desconocido: "Sin identificar",
};

const INTENT_LABEL: Record<string, string> = {
  info: "Pedir información",
  purchase: "Intención de compra",
  support: "Soporte / ayuda",
  feedback: "Feedback",
  spam: "Spam",
  other: "Otro",
};

function formatDuration(seg: number | null): string {
  if (seg == null) return "—";
  if (seg < 60) return `${seg}s`;
  if (seg < 3600) return `${Math.round(seg / 60)} min`;
  return `${(seg / 3600).toFixed(1)} h`;
}

function pct(part: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((part / total) * 100)}%`;
}

export default async function AnaliticaPage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createSupabaseServerClient();
  const rango = RANGE_OPTIONS.find((r) => r.value === searchParams.rango) ?? RANGE_OPTIONS[1];
  const since =
    rango.days == null
      ? "2000-01-01T00:00:00Z"
      : new Date(Date.now() - rango.days * 86_400_000).toISOString();

  const { data, error } = await supabase.rpc("analytics_overview", { p_since: since });
  const overview = (data ?? null) as Overview | null;

  return (
    <PageShell
      title="Analítica"
      description="Trazabilidad completa del funnel: leads que entran a Kommo, cuántos atiende el agente, cuántos transfiere a un humano, y cuántos de esos se convierten en ganados."
      actions={
        <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
          {RANGE_OPTIONS.map((r) => (
            <Link
              key={r.value}
              href={`/analitica?rango=${r.value}`}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
                (rango.value === r.value
                  ? "bg-white text-neutral-900 shadow-sm"
                  : "text-neutral-600 hover:text-neutral-900")
              }
            >
              {r.label}
            </Link>
          ))}
        </div>
      }
    >
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          No se pudo cargar la analítica: {error.message}
        </div>
      )}

      {!error && overview && overview.leads_entrantes === 0 ? (
        <EmptyState
          icon={<BarChart3 size={20} />}
          title="Sin leads en este rango."
          description="Prueba con un rango más amplio (ej. Todo)."
        />
      ) : (
        overview && (
          <div className="space-y-8">
            {/* ---- Funnel principal ---- */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                Funnel del agente
              </h2>
              <StatRow>
                <StatCard
                  label="Leads entrantes"
                  value={overview.leads_entrantes}
                  hint={
                    (overview.leads_sin_conversacion ?? 0) > 0
                      ? `${overview.leads_con_conversacion} con conversación`
                      : undefined
                  }
                  tone="brand"
                />
                {/* El porcentaje va sobre las CONVERSACIONES, no sobre el total
                    de leads: el agente no puede atender a un lead importado de
                    Zoho que nunca escribió. Medido contra el total daba 14% en
                    vez del 66% real y hacía ver mal al agente. */}
                <StatCard
                  label="Atendidos por el agente"
                  value={overview.atendidos_por_agente}
                  hint={`${pct(
                    overview.atendidos_por_agente,
                    overview.leads_con_conversacion ?? overview.leads_entrantes
                  )} de las conversaciones`}
                  tone="default"
                />
                <StatCard
                  label="Transferidos a humano"
                  value={overview.transferidos_humano}
                  hint={`${pct(
                    overview.transferidos_humano,
                    overview.leads_con_conversacion ?? overview.leads_entrantes
                  )} de las conversaciones`}
                  tone="amber"
                />
                <StatCard
                  label="Ganados (de transferidos)"
                  value={overview.transferidos_ganados}
                  hint={pct(overview.transferidos_ganados, overview.transferidos_humano)}
                  tone="emerald"
                />
              </StatRow>

              {/* Barras del funnel, todas a escala de leads_entrantes */}
              <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
                <BarBreakdown
                  rows={[
                    { label: "Leads entrantes", value: overview.leads_entrantes },
                    { label: "Atendidos por el agente", value: overview.atendidos_por_agente },
                    { label: "Transferidos a humano", value: overview.transferidos_humano },
                    { label: "→ Ganados", value: overview.transferidos_ganados },
                    { label: "→ Perdidos", value: overview.transferidos_perdidos },
                  ]}
                  formatValue={(n) => String(n)}
                />
              </div>

              <p className="text-xs text-neutral-500">
                Ganados totales del período (transferidos o no): <span className="font-medium text-neutral-700">{overview.ganados_totales}</span>
                {" · "}
                Perdidos totales: <span className="font-medium text-neutral-700">{overview.perdidos_totales}</span>
              </p>
            </section>

            {/* ---- Volumen diario ---- */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                Volumen de mensajes por día
              </h2>
              <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
                <LineAreaChart
                  days={overview.volumen_diario.map((d) => d.dia)}
                  series={[
                    {
                      label: "Del lead",
                      color: "#6366f1",
                      values: overview.volumen_diario.map((d) => d.inbound),
                    },
                    {
                      label: "Del agente",
                      color: "#10b981",
                      values: overview.volumen_diario.map((d) => d.outbound),
                    },
                  ]}
                  formatY={(n) => String(Math.round(n))}
                />
              </div>
            </section>

            {/* ---- Por vertical / canal / intención ---- */}
            <div className="grid gap-6 lg:grid-cols-3">
              <section className="space-y-3">
                <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                  Por vertical
                </h2>
                <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
                  {overview.por_vertical.length === 0 ? (
                    <p className="text-xs text-neutral-400">Sin datos.</p>
                  ) : (
                    <BarBreakdown
                      rows={overview.por_vertical.map((v) => ({ label: v.name, value: v.leads }))}
                      formatValue={(n) => `${n} leads`}
                    />
                  )}
                </div>
              </section>

              <section className="space-y-3">
                <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                  Canales más atendidos
                </h2>
                <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
                  {overview.por_canal.length === 0 ? (
                    <p className="text-xs text-neutral-400">Sin datos.</p>
                  ) : (
                    <BarBreakdown
                      rows={overview.por_canal.map((c) => ({
                        label: CHANNEL_LABEL[c.canal] ?? c.canal,
                        value: c.leads,
                      }))}
                      formatValue={(n) => `${n} leads`}
                    />
                  )}
                </div>
                {/* El canal solo existe si hubo conversación. Los leads
                    importados de Zoho no tienen chat, y antes inflaban un
                    bucket "Otro" que se comía el gráfico. */}
                <p className="text-[11px] text-neutral-400">
                  Cuenta las {overview.leads_con_conversacion ?? 0} conversaciones reales.
                  {(overview.leads_sin_conversacion ?? 0) > 0 && (
                    <> Los otros {overview.leads_sin_conversacion} leads entraron por la migración de Zoho Desk y no tienen canal de chat.</>
                  )}
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                  Lo más preguntado
                </h2>
                <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
                  {overview.por_intencion.length === 0 ? (
                    <p className="text-xs text-neutral-400">Sin datos.</p>
                  ) : (
                    <BarBreakdown
                      rows={overview.por_intencion.map((i) => ({
                        label: INTENT_LABEL[i.intent] ?? i.intent,
                        value: i.menciones,
                      }))}
                      formatValue={(n) => `${n}`}
                    />
                  )}
                </div>
                <p className="text-[11px] text-neutral-400">
                  Aproximado por intención clasificada de cada mensaje entrante — no es un análisis de texto libre.
                  Se excluyen los mensajes que no traen contenido del cliente (menciones en historias y avisos de
                  Instagram/WhatsApp).
                </p>
                {/* Los huecos se muestran; antes se colaban al ranking como
                    "(sin clasificar)" y parecían el tema más preguntado. */}
                {((overview.mensajes_sin_clasificar ?? 0) > 0 ||
                  (overview.mensajes_sin_contenido ?? 0) > 0 ||
                  (overview.mensajes_ignorados ?? 0) > 0) && (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] text-neutral-600">
                    <span className="font-medium text-neutral-700">Fuera del ranking:</span>{" "}
                    {[
                      (overview.mensajes_sin_contenido ?? 0) > 0 &&
                        `${overview.mensajes_sin_contenido} sin contenido del cliente`,
                      (overview.mensajes_ignorados ?? 0) > 0 &&
                        `${overview.mensajes_ignorados} ignorados por configuración`,
                      (overview.mensajes_sin_clasificar ?? 0) > 0 &&
                        `${overview.mensajes_sin_clasificar} que no se pudieron clasificar`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {(overview.fallos_clasificador ?? 0) > 0 && (
                      <>
                        {" "}
                        <span className="text-neutral-500">
                          ({overview.fallos_clasificador} por un fallo del clasificador — revisa que no se repita.)
                        </span>
                      </>
                    )}
                  </div>
                )}
              </section>
            </div>

            {/* ---- Otras métricas ---- */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                Otras métricas
              </h2>
              <StatRow>
                <StatCard label="Mensajes totales" value={overview.mensajes_total} />
                <StatCard label="Mensajes por lead (prom.)" value={overview.mensajes_por_lead_prom} />
                <StatCard
                  label="Tiempo de respuesta (prom.)"
                  value={formatDuration(overview.tiempo_respuesta_prom_seg)}
                  hint="Desde el mensaje del lead hasta la respuesta enviada"
                />
              </StatRow>
            </section>
          </div>
        )
      )}
    </PageShell>
  );
}
