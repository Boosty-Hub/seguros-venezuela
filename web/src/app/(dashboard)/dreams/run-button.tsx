"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RunButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    setError(null);
    const res = await fetch("/api/dreams/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok || !data.ok) {
      setError(data.error ?? "error");
      return;
    }
    const extra =
      typeof data.pending === "number" && data.pending > 0
        ? ` (${data.active} activos, ${data.pending} pendientes de aprobación)`
        : "";
    setResult(`✓ ${data.count} aprendizajes nuevos${extra}`);
    router.refresh();
  }

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
      >
        {busy ? "Corriendo…" : "Run ahora"}
      </button>
      {result && <span className="text-xs font-medium text-emerald-700">{result}</span>}
      {error && <span className="text-xs font-medium text-red-600">{error}</span>}
    </div>
  );
}
