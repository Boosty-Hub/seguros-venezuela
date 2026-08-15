import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PageShell, StatRow, StatCard, Badge, EmptyState,
  BarChart3, TrendUp, Target, Users,
} from "@/components/ui";

export const dynamic = "force-dynamic";

const nfInt = new Intl.NumberFormat("es-VE", { maximumFractionDigits: 0 });
const fmtN = (n: number | null | undefined) => nfInt.format(Number(n || 0));
const fmtMoney = (n: number | null | undefined) =>
  Number(n || 0) ? `$${nfInt.format(Math.round(Number(n)))}` : "—";
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("es-VE", { day: "2-digit", month: "short" }) : "—";

type Stage = { status: string; stage_order: number; stage_group: string; color: string | null };
type FunnelRow = { status: string; stage_order: number; stage_group: string; color: string | null; tickets: number; total_prima: number | null };
type Kpis = { total_tickets: number; nuevos_30d: number; nuevos_7d: number; ganados: number; perdidos: number };
type ChannelRow = { channel: string | null; tickets: number };
type AgentRow = { agente: string; tickets: number };
type TicketRow = {
  id: string; ticket_number: string | null; subject: string | null; status: string | null;
  channel: string | null; assignee_name: string | null; contact_name: string | null;
  email: string | null; monto_prima: number | null; plan_hcm: string | null;
  created_time: string | null; web_url: string | null;
};

type SearchParams = { q?: string; status?: string; channel?: string; page?: string };

function Bar({ value, max, color }: { value: number; max: number; color?: string }) {
  const w = Math.max(2, (value / (max || 1)) * 100);
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100">
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: color || "var(--brand, #12b0a8)" }} />
    </div>
  );
}

export default async function PipelinePage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createSupabaseServerClient();

  const [{ data: stagesData }, { data: kpisData }, { data: funnelData }, { data: channelData }, { data: agentData }] =
    await Promise.all([
      supabase.from("pipeline_stages").select("status,stage_order,stage_group,color").order("stage_order"),
      supabase.from("v_kpis").select("*").maybeSingle(),
      supabase.from("v_funnel").select("*").order("stage_order"),
      supabase.from("v_channel").select("*"),
      supabase.from("v_agent").select("*").limit(12),
    ]);

  const stages = (stagesData ?? []) as Stage[];
  const kpis = (kpisData ?? {}) as Partial<Kpis>;
  const funnel = (funnelData ?? []) as FunnelRow[];
  const channels = ((channelData ?? []) as ChannelRow[]).filter((r) => r.channel);
  const agents = (agentData ?? []) as AgentRow[];

  const openStatuses = stages.filter((s) => s.stage_group === "abierto").map((s) => s.status);
  const stageByStatus = new Map(stages.map((s) => [s.status, s]));

  const abierto = funnel.filter((r) => r.stage_group === "abierto");
  const abiertoCnt = abierto.reduce((a, r) => a + Number(r.tickets), 0);
  const primaPipe = abierto.reduce((a, r) => a + Number(r.total_prima || 0), 0);
  const ganados = Number(kpis.ganados || 0);
  const perdidos = Number(kpis.perdidos || 0);
  const conv = ganados + perdidos ? (ganados / (ganados + perdidos)) * 100 : 0;
  const funnelMax = Math.max(1, ...funnel.map((r) => Number(r.tickets)));
  const channelMax = Math.max(1, ...channels.map((r) => Number(r.tickets)));
  const agentMax = Math.max(1, ...agents.map((r) => Number(r.tickets)));

  // ---- Kanban: tickets abiertos, agrupados por etapa ----
  let kanbanTickets: TicketRow[] = [];
  if (openStatuses.length) {
    const { data } = await supabase
      .from("tickets")
      .select("id,ticket_number,subject,status,channel,assignee_name,contact_name,monto_prima,plan_hcm,created_time,web_url")
      .in("status", openStatuses)
      .order("created_time", { ascending: false })
      .limit(1500);
    kanbanTickets = (data ?? []) as TicketRow[];
  }
  const byStatus = new Map<string, TicketRow[]>();
  for (const t of kanbanTickets) {
    const list = byStatus.get(t.status ?? "") ?? [];
    list.push(t);
    byStatus.set(t.status ?? "", list);
  }

  // ---- Tabla filtrable de tickets ----
  const PAGE_SIZE = 25;
  const q = (searchParams.q ?? "").trim();
  const fStatus = searchParams.status ?? "";
  const fChannel = searchParams.channel ?? "";
  const page = Math.max(0, parseInt(searchParams.page ?? "0", 10) || 0);
  const from = page * PAGE_SIZE;

  let tableQuery = supabase
    .from("tickets")
    .select(
      "id,ticket_number,subject,status,channel,assignee_name,contact_name,email,monto_prima,created_time,web_url",
      { count: "exact" }
    );
  if (fStatus) tableQuery = tableQuery.eq("status", fStatus);
  if (fChannel) tableQuery = tableQuery.eq("channel", fChannel);
  if (q) {
    const s = q.replace(/[,()]/g, " ");
    tableQuery = tableQuery.or(
      `subject.ilike.%${s}%,contact_name.ilike.%${s}%,email.ilike.%${s}%,ticket_number.ilike.%${s}%`
    );
  }
  const { data: tableData, count } = await tableQuery
    .order("created_time", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  const tickets = (tableData ?? []) as TicketRow[];
  const total = count ?? 0;

  const channelOptions = Array.from(new Set(channels.map((r) => r.channel).filter(Boolean))) as string[];

  function pageHref(patch: Record<string, string>) {
    const params = new URLSearchParams({ q, status: fStatus, channel: fChannel, page: String(page) });
    for (const [k, v] of Object.entries(patch)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    for (const k of ["q", "status", "channel", "page"]) {
      if (!params.get(k)) params.delete(k);
    }
    const qs = params.toString();
    return qs ? `/pipeline?${qs}` : "/pipeline";
  }

  return (
    <PageShell
      title="Pipeline Zoho Desk"
      description="Embudo de ventas sincronizado desde Zoho Desk — mismos datos que el dashboard público del pipeline."
    >
      <StatRow>
        <StatCard label="Total tickets" value={fmtN(kpis.total_tickets)} hint={`${fmtN(kpis.nuevos_30d)} en 30 días`} icon={<BarChart3 size={18} />} tone="brand" />
        <StatCard label="Pipeline activo" value={fmtN(abiertoCnt)} hint={`prima ${fmtMoney(primaPipe)}`} icon={<TrendUp size={18} />} tone="default" />
        <StatCard label="Ganados" value={fmtN(ganados)} hint={`${conv.toFixed(1)}% de conversión`} icon={<Target size={18} />} tone="emerald" />
        <StatCard label="Perdidos" value={fmtN(perdidos)} hint="anulada / rechazada" tone="red" />
        <StatCard label="Nuevos (7 días)" value={fmtN(kpis.nuevos_7d)} icon={<Users size={18} />} tone="amber" />
      </StatRow>

      {/* Embudo */}
      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Embudo</h2>
        {funnel.length === 0 ? (
          <EmptyState title="Sin datos del embudo." />
        ) : (
          <div className="space-y-2.5">
            {funnel.map((r) => {
              const cnt = Number(r.tickets);
              const share = r.stage_group === "abierto" && abiertoCnt ? ` · ${((cnt / abiertoCnt) * 100).toFixed(0)}% del pipeline` : "";
              return (
                <div key={r.status}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium text-neutral-700">{r.status}</span>
                    <span className="text-neutral-500">{fmtN(cnt)} · {fmtMoney(r.total_prima)}</span>
                  </div>
                  <Bar value={cnt} max={funnelMax} color={r.color ?? undefined} />
                  <p className="mt-0.5 text-[11px] text-neutral-400">{r.stage_group}{share}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Kanban de etapas abiertas */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Kanban (etapas abiertas)</h2>
        {openStatuses.length === 0 ? (
          <EmptyState title="No hay etapas abiertas configuradas." />
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {stages.filter((s) => s.stage_group === "abierto").map((s) => {
              const items = byStatus.get(s.status) ?? [];
              return (
                <div key={s.status} className="w-64 shrink-0 rounded-xl border border-neutral-200 bg-neutral-50/60">
                  <div className="flex items-center justify-between border-b border-neutral-200/80 px-3 py-2">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-700">
                      <span className="h-2 w-2 rounded-full" style={{ background: s.color ?? "#94a3b8" }} />
                      {s.status}
                    </span>
                    <span className="text-xs text-neutral-400">{items.length}</span>
                  </div>
                  <div className="max-h-96 space-y-2 overflow-y-auto p-2">
                    {items.slice(0, 40).map((t) => (
                      <div key={t.id} className="rounded-lg border border-neutral-200 bg-white p-2 text-xs shadow-sm">
                        <p className="truncate font-medium text-neutral-800">{t.subject || "(sin asunto)"}</p>
                        <div className="mt-1 flex items-center justify-between text-neutral-500">
                          <span>#{t.ticket_number}</span>
                          <span className="font-semibold text-neutral-700">{fmtMoney(t.monto_prima)}</span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between text-neutral-400">
                          <span className="truncate">{t.contact_name || t.assignee_name || "—"}</span>
                          <span>{t.channel || ""}</span>
                        </div>
                      </div>
                    ))}
                    {items.length > 40 && (
                      <p className="text-center text-[11px] text-neutral-400">+{items.length - 40} más</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Canal y asesor */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
          <h2 className="mb-3 text-sm font-semibold text-neutral-900">Por canal</h2>
          {channels.length === 0 ? <EmptyState title="Sin datos." /> : (
            <div className="space-y-2">
              {channels.map((r) => (
                <div key={r.channel} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 truncate text-neutral-600">{r.channel}</span>
                  <Bar value={Number(r.tickets)} max={channelMax} />
                  <span className="w-10 shrink-0 text-right text-neutral-500">{fmtN(r.tickets)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
          <h2 className="mb-3 text-sm font-semibold text-neutral-900">Por asesor</h2>
          {agents.length === 0 ? <EmptyState title="Sin datos." /> : (
            <div className="space-y-2">
              {agents.map((r) => (
                <div key={r.agente} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 truncate text-neutral-600" title={r.agente}>{r.agente}</span>
                  <Bar value={Number(r.tickets)} max={agentMax} />
                  <span className="w-10 shrink-0 text-right text-neutral-500">{fmtN(r.tickets)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tabla de tickets */}
      <div className="rounded-xl border border-neutral-200 bg-white shadow-card">
        <div className="flex flex-col gap-2 border-b border-neutral-100 p-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">Tickets</h2>
          <form className="flex flex-wrap items-center gap-2" action="/pipeline" method="get">
            <input
              type="text" name="q" defaultValue={q} placeholder="Buscar asunto, contacto, correo…"
              className="w-56 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
            <select name="status" defaultValue={fStatus} className="rounded-lg border border-neutral-200 px-2 py-1.5 text-xs">
              <option value="">Todas las etapas</option>
              {stages.map((s) => <option key={s.status} value={s.status}>{s.status}</option>)}
            </select>
            <select name="channel" defaultValue={fChannel} className="rounded-lg border border-neutral-200 px-2 py-1.5 text-xs">
              <option value="">Todos los canales</option>
              {channelOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button type="submit" className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground hover:bg-brand-strong">
              Filtrar
            </button>
          </form>
        </div>
        {tickets.length === 0 ? (
          <EmptyState title="Sin resultados." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-neutral-50/60 text-left">
                <tr>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Ticket</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Asunto</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Contacto</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Etapa</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Canal</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Asesor</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Prima</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Fecha</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {tickets.map((t) => {
                  const st = stageByStatus.get(t.status ?? "");
                  return (
                    <tr key={t.id} className="hover:bg-neutral-50/70">
                      <td className="px-4 py-3 font-mono text-xs text-neutral-500">#{t.ticket_number}</td>
                      <td className="px-4 py-3">
                        {t.web_url ? (
                          <Link href={t.web_url} target="_blank" className="text-brand hover:text-brand-strong">
                            {(t.subject || "(sin asunto)").slice(0, 70)}
                          </Link>
                        ) : (
                          (t.subject || "(sin asunto)").slice(0, 70)
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {t.contact_name || "—"}
                        <div className="text-[11px] text-neutral-400">{t.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge color="neutral" variant="ring">{t.status}</Badge>
                        {st?.stage_group && <span className="ml-1 text-[10px] text-neutral-400">{st.stage_group}</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-500">{t.channel || "—"}</td>
                      <td className="px-4 py-3 text-xs text-neutral-500">{t.assignee_name || "—"}</td>
                      <td className="px-4 py-3 font-semibold">{fmtMoney(t.monto_prima)}</td>
                      <td className="px-4 py-3 text-xs text-neutral-500">{fmtDate(t.created_time)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-2.5 text-xs text-neutral-500">
          <span>{total ? `${from + 1}–${Math.min(from + PAGE_SIZE, total)} de ${fmtN(total)}` : "0 resultados"}</span>
          <div className="flex gap-2">
            <Link
              href={pageHref({ page: String(Math.max(0, page - 1)) })}
              className={`rounded-lg border border-neutral-200 px-2.5 py-1 ${page === 0 ? "pointer-events-none opacity-40" : "hover:bg-neutral-50"}`}
            >
              Anterior
            </Link>
            <Link
              href={pageHref({ page: String(page + 1) })}
              className={`rounded-lg border border-neutral-200 px-2.5 py-1 ${from + PAGE_SIZE >= total ? "pointer-events-none opacity-40" : "hover:bg-neutral-50"}`}
            >
              Siguiente
            </Link>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
