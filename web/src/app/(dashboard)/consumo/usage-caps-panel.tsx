"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function Bar({ spend, cap }: { spend: number; cap: number | null }) {
  if (!cap) return null;
  const pct = Math.min(100, Math.round((spend / cap) * 100));
  const tone = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
      <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function UsageCapsPanel({
  dailySpend,
  monthlySpend,
  initialDailyCap,
  initialMonthlyCap,
  agentEnabled,
  stoppedByCap,
}: {
  dailySpend: number;
  monthlySpend: number;
  initialDailyCap: number | null;
  initialMonthlyCap: number | null;
  agentEnabled: boolean;
  stoppedByCap: boolean;
}) {
  const router = useRouter();
  const [daily, setDaily] = useState(initialDailyCap ? String(initialDailyCap) : "");
  const [monthly, setMonthly] = useState(initialMonthlyCap ? String(initialMonthlyCap) : "");
  const [busy, setBusy] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/consumo/caps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily: daily || null, monthly: monthly || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reactivate() {
    setReactivating(true);
    try {
      await fetch("/api/agent/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_enabled: true }),
      });
      router.refresh();
    } finally {
      setReactivating(false);
    }
  }

  return (
    <div className="space-y-5 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-neutral-900">Tope de consumo</h2>
        <p className="text-xs text-neutral-500">
          Si el gasto llega al tope, el agente se apaga POR COMPLETO (ni clasifica ni responde a nada) y
          queda una alerta crítica hasta que lo reactives a mano.
        </p>
      </div>

      {!agentEnabled && stoppedByCap && (
        <div className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-red-800">
            🛑 <span className="font-semibold">Agente apagado por tope de consumo.</span> No genera ninguna
            respuesta hasta que lo reactives.
          </p>
          <button
            type="button"
            onClick={reactivate}
            disabled={reactivating}
            className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {reactivating ? "Reactivando…" : "Reactivar agente"}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-neutral-600">Hoy</span>
            <span className="text-xs text-neutral-500">
              ${dailySpend.toFixed(2)}
              {initialDailyCap ? ` / $${initialDailyCap.toFixed(2)}` : ""}
            </span>
          </div>
          <Bar spend={dailySpend} cap={initialDailyCap} />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-neutral-600">Este mes</span>
            <span className="text-xs text-neutral-500">
              ${monthlySpend.toFixed(2)}
              {initialMonthlyCap ? ` / $${initialMonthlyCap.toFixed(2)}` : ""}
            </span>
          </div>
          <Bar spend={monthlySpend} cap={initialMonthlyCap} />
        </div>
      </div>

      <form onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">Tope diario (USD)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
            placeholder="Sin tope"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">Tope mensual (USD)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
            placeholder="Sin tope"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
        <div className="sm:col-span-2 flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
          >
            {busy ? "Guardando…" : "Guardar topes"}
          </button>
          {saved && <span className="text-xs font-medium text-emerald-700">✓ Guardado</span>}
          {error && <span className="text-xs font-medium text-red-600">{error}</span>}
        </div>
      </form>
      <p className="text-[11px] text-neutral-400">
        Se revisa cada 5 minutos (mismo ciclo que las alertas). Deja un campo vacío para no poner tope ahí.
      </p>
    </div>
  );
}
