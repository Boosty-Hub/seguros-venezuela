"use client";

import { useState } from "react";
import { AgentPromptAssistant } from "@/components/agent-prompt-assistant";

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
    systemPrompt: string;
  };
  /** El system prompt COMPLETO leído en vivo del agente en Anthropic (operatorPrompt
   * + maquinaria fija + tools ya sustituidos). null si el agente todavía no está
   * aprovisionado. Es de SOLO LECTURA: es la única forma de saber con certeza qué
   * hay adentro de Anthropic ahora mismo, sin recomponerlo localmente. */
  liveSystemPrompt: string | null;
  liveSystemPromptError: string | null;
}) {
  const [showFull, setShowFull] = useState(false);
  // Only the system prompt is controlled — the AI assistant edits it live.
  // The other fields stay uncontrolled (defaultValue) and submit normally.
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt);

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

      {/* Asistente IA — franja full-width sobre el textarea */}
      <div className="space-y-2">
        <AgentPromptAssistant value={systemPrompt} onChange={setSystemPrompt} />
        <p className="text-xs text-neutral-500">
          Los cambios se aplican en el prompt de abajo. Acuérdate de{" "}
          <strong>Guardar y sincronizar</strong> para subirlos a Anthropic.
        </p>
      </div>

      {/* System prompt — ancho completo debajo del asistente */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">
          System prompt — voz e identidad
        </label>
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
          Acá va SOLO la voz, identidad y reglas de negocio del operador. La
          maquinaria técnica (leer la memoria, el formato de salida, el uso de
          la KB, las prioridades y la seguridad anti-abuso) la agrega el sistema
          automáticamente por detrás — no hace falta escribirla acá, y así no se
          puede romper sin querer.
        </p>
        <textarea
          name="system_prompt"
          rows={24}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="La voz e identidad del operador. Puedes usar los placeholders {{OPERATOR_NAME}}, {{MASTER_PATH}}, {{LEADS_PATH}}, {{MEMORY_STORE_MASTER}}, {{MEMORY_STORE_LEADS}} — se sustituyen al sincronizar."
          className={inputCls + " font-mono leading-relaxed"}
        />
        <p className="text-xs text-neutral-500">
          Placeholders:{" "}
          <span className="font-mono">{"{{OPERATOR_NAME}}"}</span>,{" "}
          <span className="font-mono">{"{{MASTER_PATH}}"}</span>,{" "}
          <span className="font-mono">{"{{LEADS_PATH}}"}</span>,{" "}
          <span className="font-mono">{"{{MEMORY_STORE_MASTER}}"}</span>,{" "}
          <span className="font-mono">{"{{MEMORY_STORE_LEADS}}"}</span>.
        </p>
      </div>

      <button
        type="submit"
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
      >
        Guardar y sincronizar
      </button>

      {/* System prompt COMPLETO, tal cual vive en Anthropic ahora mismo —
          solo lectura, leído en vivo del agente (no recompuesto acá). Es la
          única forma de saber con certeza qué hay adentro: lo de arriba es
          SOLO la mitad editable (voz/identidad); esto es esa mitad + la
          maquinaria fija (formato de salida, prioridades, seguridad, tools). */}
      <div className="space-y-2 border-t border-neutral-200 pt-5">
        <button
          type="button"
          onClick={() => setShowFull((v) => !v)}
          className="text-sm font-medium text-neutral-700 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900"
        >
          {showFull ? "Ocultar" : "Ver"} el system prompt completo (solo lectura, tal cual está en Anthropic)
        </button>
        {showFull && (
          <div className="space-y-2">
            {liveSystemPromptError ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                No se pudo leer desde Anthropic: <span className="font-mono">{liveSystemPromptError}</span>
              </p>
            ) : liveSystemPrompt ? (
              <>
                <p className="text-xs text-neutral-500">
                  Esto es EXACTAMENTE lo que Anthropic tiene guardado para este agente ahora mismo — tu prompt de
                  arriba + la maquinaria fija (formato de salida, prioridades, seguridad, acciones de CRM ya
                  resueltas) + los placeholders ya sustituidos. No es editable acá: si quieres cambiar algo, edita
                  el prompt de arriba (la voz/identidad) y Guarda y sincroniza.
                </p>
                <textarea
                  readOnly
                  value={liveSystemPrompt}
                  rows={20}
                  className={inputCls + " font-mono leading-relaxed bg-neutral-50 text-neutral-600"}
                />
              </>
            ) : (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                El agente todavía no está aprovisionado en Anthropic — no hay nada que leer todavía.
              </p>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
