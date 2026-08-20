"use client";

// Torre de control: campana en el header que abre un panel deslizable desde
// la derecha con TODO lo que hay que revisar de un vistazo — alertas activas,
// estado del agente (encendido/publicación/revisión), consumo vs topes, y
// revisiones pendientes — con los botones para actuar sin salir del panel.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, X } from "@/components/ui";

type Alert = {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string | null;
  created_at: string;
  ref_table: string | null;
  ref_id: string | null;
};

type TowerData = {
  alerts: Alert[];
  agent: { enabled: boolean; publishing: boolean; bypassReview: boolean };
  consumption: { dailySpend: number; monthlySpend: number; dailyCap: number | null; monthlyCap: number | null };
  reviews: { pendingDrafts: number; needsReview: number };
};

const SEVERITY_STYLE: Record<Alert["severity"], string> = {
  critical: "border-red-200 bg-red-50 text-red-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

function Pill({ ok, onLabel, offLabel }: { ok: boolean; onLabel: string; offLabel: string }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
        (ok ? "bg-emerald-100 text-emerald-700" : "bg-neutral-100 text-neutral-500")
      }
    >
      {ok ? onLabel : offLabel}
    </span>
  );
}

function Bar({ spend, cap }: { spend: number; cap: number | null }) {
  if (!cap) return null;
  const pct = Math.min(100, Math.round((spend / cap) * 100));
  const tone = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
      <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ControlTower() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<TowerData | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);
  const [reactivating, setReactivating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/control-tower");
      if (!res.ok) return;
      const json = (await res.json()) as TowerData;
      setData(json);
    } catch {
      // silencioso: la campana simplemente no actualiza el contador
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function acknowledge(id: string) {
    setBusyId(id);
    await fetch(`/api/alerts/${id}/acknowledge`, { method: "POST" });
    setBusyId(null);
    await load();
    router.refresh();
  }

  async function acknowledgeAll() {
    setBusyAll(true);
    await fetch("/api/alerts/acknowledge-all", { method: "POST" });
    setBusyAll(false);
    await load();
    router.refresh();
  }

  async function reactivateAgent() {
    setReactivating(true);
    await fetch("/api/agent/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_enabled: true }),
    });
    setReactivating(false);
    await load();
    router.refresh();
  }

  const alertCount = data?.alerts.length ?? 0;
  const criticalCount = data?.alerts.filter((a) => a.severity === "critical").length ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Torre de control"
        title="Torre de control"
        className="relative grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell size={18} />
        {alertCount > 0 && (
          <span
            className={
              "absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white " +
              (criticalCount > 0 ? "bg-red-500" : "bg-amber-500")
            }
          >
            {alertCount > 9 ? "9+" : alertCount}
          </span>
        )}
      </button>

      <div
        className={
          "fixed inset-0 z-50 transition-opacity duration-200 " +
          (open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0")
        }
      >
        <div className="absolute inset-0 bg-neutral-900/40" onClick={() => setOpen(false)} />
        <aside
          className={
            "absolute right-0 top-0 flex h-full w-full max-w-sm flex-col overflow-y-auto border-l border-neutral-200 bg-white shadow-modal transition-transform duration-200 ease-out " +
            (open ? "translate-x-0" : "translate-x-full")
          }
        >
            <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
              <h2 className="text-sm font-semibold tracking-tight text-neutral-900">🎛️ Torre de control</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar"
                className="grid h-7 w-7 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              >
                <X size={16} />
              </button>
            </div>

            {!data ? (
              <div className="p-4 text-sm text-neutral-500">Cargando…</div>
            ) : (
              <div className="flex-1 space-y-5 p-4">
                {/* Estado del agente */}
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    Estado del agente
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    <Pill ok={data.agent.enabled} onLabel="Encendido" offLabel="Apagado" />
                    <Pill ok={data.agent.publishing} onLabel="Producción" offLabel="Validación" />
                    <Pill ok={data.agent.bypassReview} onLabel="Sin revisión" offLabel="Con revisión" />
                  </div>
                  {!data.agent.enabled && (
                    <button
                      type="button"
                      onClick={reactivateAgent}
                      disabled={reactivating}
                      className="w-full rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                    >
                      {reactivating ? "Reactivando…" : "🛑 Reactivar agente"}
                    </button>
                  )}
                  <a href="/agent" className="block text-xs font-medium text-brand hover:underline">
                    Ir a Configuración →
                  </a>
                </section>

                {/* Consumo */}
                <section className="space-y-2 border-t border-neutral-100 pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    Consumo vs. tope
                  </h3>
                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between text-xs text-neutral-600">
                      <span>Hoy</span>
                      <span>
                        ${data.consumption.dailySpend.toFixed(2)}
                        {data.consumption.dailyCap ? ` / $${data.consumption.dailyCap.toFixed(2)}` : " (sin tope)"}
                      </span>
                    </div>
                    <Bar spend={data.consumption.dailySpend} cap={data.consumption.dailyCap} />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between text-xs text-neutral-600">
                      <span>Este mes</span>
                      <span>
                        ${data.consumption.monthlySpend.toFixed(2)}
                        {data.consumption.monthlyCap ? ` / $${data.consumption.monthlyCap.toFixed(2)}` : " (sin tope)"}
                      </span>
                    </div>
                    <Bar spend={data.consumption.monthlySpend} cap={data.consumption.monthlyCap} />
                  </div>
                  <a href="/consumo" className="block text-xs font-medium text-brand hover:underline">
                    Ir a Consumo →
                  </a>
                </section>

                {/* Revisiones pendientes */}
                <section className="space-y-2 border-t border-neutral-100 pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    Revisiones pendientes
                  </h3>
                  <a
                    href="/inbox"
                    className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50"
                  >
                    <span className="text-neutral-700">Drafts esperando aprobación</span>
                    <span className="font-semibold text-neutral-900">{data.reviews.pendingDrafts}</span>
                  </a>
                  <a
                    href="/inbox"
                    className="flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50"
                  >
                    <span className="text-neutral-700">Mensajes marcados para revisión humana</span>
                    <span className="font-semibold text-neutral-900">{data.reviews.needsReview}</span>
                  </a>
                </section>

                {/* Alertas activas */}
                <section className="space-y-2 border-t border-neutral-100 pt-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                      Alertas activas ({alertCount})
                    </h3>
                    {alertCount > 0 && (
                      <button
                        type="button"
                        onClick={acknowledgeAll}
                        disabled={busyAll}
                        className="text-xs font-medium text-neutral-500 hover:text-neutral-800 disabled:opacity-50"
                      >
                        Marcar todas
                      </button>
                    )}
                  </div>
                  {alertCount === 0 ? (
                    <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                      Sin alertas pendientes.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {data.alerts.map((a) => (
                        <div key={a.id} className={`rounded-lg border px-3 py-2 ${SEVERITY_STYLE[a.severity]}`}>
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-semibold">{a.title}</p>
                            <span className="shrink-0 text-[10px] opacity-70">{timeAgo(a.created_at)}</span>
                          </div>
                          {a.description && (
                            <p className="mt-0.5 line-clamp-3 text-[11px] opacity-90">{a.description}</p>
                          )}
                          <button
                            type="button"
                            onClick={() => acknowledge(a.id)}
                            disabled={busyId === a.id}
                            className="mt-1.5 text-[11px] font-medium underline decoration-current/40 underline-offset-2 hover:opacity-80 disabled:opacity-50"
                          >
                            Marcar como vista
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <a href="/alerts" className="block text-xs font-medium text-brand hover:underline">
                    Ver historial completo →
                  </a>
                </section>
              </div>
            )}
          </aside>
        </div>
    </>
  );
}
