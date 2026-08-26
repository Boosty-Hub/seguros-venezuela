"use client";

const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none";

export function AgentForm({
  initial,
  liveSystemPrompt,
  liveSystemPromptError,
}: {
  initial: {
    operatorName: string;
    agentName: string;
    agentLabel: string;
  };
  /** El system prompt COMPLETO leído en vivo del agente en Anthropic (voz +
   * maquinaria fija + tools ya sustituidos). null si el agente todavía no está
   * aprovisionado. SOLO LECTURA en el dashboard: se lee en vivo de Anthropic,
   * nunca se recompone localmente. Para cambiarlo hay que editarlo en una
   * sesión (como esta), no desde acá. */
  liveSystemPrompt: string | null;
  liveSystemPromptError: string | null;
}) {
  return (
    <form
      action="/api/agent"
      method="post"
      className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-neutral-700">
            Nombre del operador
          </label>
          <input
            type="text"
            name="operator_name"
            defaultValue={initial.operatorName}
            placeholder="Ej: María, Estudio Jurídico X"
            className={inputCls}
          />
          <p className="text-xs text-neutral-500">
            Reemplaza <span className="font-mono">{"{{OPERATOR_NAME}}"}</span> en el prompt.
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-neutral-700">
            Nombre del agente (Anthropic)
          </label>
          <input
            type="text"
            name="agent_name"
            defaultValue={initial.agentName}
            placeholder="Ej: agente-maria-prod"
            className={inputCls + " font-mono"}
          />
          <p className="text-xs text-neutral-500">
            Identifica el agente en tu cuenta de Anthropic.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">
          Branding del dashboard
        </label>
        <input
          type="text"
          name="agent_label"
          defaultValue={initial.agentLabel}
          placeholder="Ej: Agente de Ventas"
          className={inputCls}
        />
        <p className="text-xs text-neutral-500">
          Título que se muestra en la barra lateral y el login.
        </p>
      </div>

      <button
        type="submit"
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
      >
        Guardar
      </button>

      {/* System prompt COMPLETO, tal cual vive en Anthropic ahora mismo — la
          ÚNICA fuente del prompt en este dashboard, de solo lectura. Ya no hay
          un editor acá: cambiarlo se hace en una sesión (como esta), no desde
          el dashboard. */}
      <div className="space-y-2 border-t border-neutral-200 pt-5">
        <label className="text-sm font-medium text-neutral-700">
          System prompt (solo lectura, tal cual está en Anthropic)
        </label>
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
          Este es exactamente lo que Anthropic tiene guardado para este agente ahora mismo — no es
          editable desde acá. Para cambiar la voz, identidad o reglas de negocio, hazlo en una
          sesión (como esta).
        </p>
        {liveSystemPromptError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            No se pudo leer desde Anthropic: <span className="font-mono">{liveSystemPromptError}</span>
          </p>
        ) : liveSystemPrompt ? (
          <textarea
            readOnly
            value={liveSystemPrompt}
            rows={24}
            className={inputCls + " font-mono leading-relaxed bg-neutral-50 text-neutral-600"}
          />
        ) : (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            El agente todavía no está aprovisionado en Anthropic — no hay nada que leer todavía.
          </p>
        )}
      </div>
    </form>
  );
}
