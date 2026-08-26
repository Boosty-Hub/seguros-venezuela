"use client";

import { useState } from "react";
import {
  FiltersPanel,
  type Rule,
  type Limits,
  type VerticalLite,
  type ChannelsData,
  type MediaFlags,
} from "./filters-panel";
import { CrmActionsPanel, type CrmFlags } from "./crm-actions-panel";
import { ShopifyActionsPanel, type ShopifyFlags } from "./shopify-actions-panel";
import { BcvPanel } from "./bcv-panel";
import { BusinessHoursPanel, type BusinessHours } from "./business-hours-panel";
import { CommentsPanel, type CommentsConfig } from "./comments-panel";

type Tab =
  | "agente"
  | "kommo"
  | "herramientas"
  | "seguimiento"
  | "ajustes";

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-1.5 text-sm font-medium rounded-md transition-colors " +
        (active
          ? "bg-white text-neutral-900 shadow-sm"
          : "text-neutral-600 hover:text-neutral-900")
      }
    >
      {children}
    </button>
  );
}

export function AgentTabs({
  initialTab,
  rules,
  limits,
  verticals,
  channels,
  ignoredStageIds,
  debounce,
  freshness,
  media,
  crm,
  shopify,
  shopifyConnected,
  bcvEnabled,
  bcvHasCustomSource,
  businessHours,
  comments,
  hasOpenaiKey = false,
  children,
  kommoSlot,
  toolsSlot,
  seguimientoSlot,
  ajustesSlot,
}: {
  initialTab: Tab;
  rules: Rule[];
  limits: Limits;
  verticals: VerticalLite[];
  channels: ChannelsData;
  ignoredStageIds: number[];
  debounce: number;
  freshness: number;
  media: MediaFlags;
  crm: CrmFlags;
  shopify: ShopifyFlags;
  shopifyConnected: boolean;
  bcvEnabled: boolean;
  bcvHasCustomSource: boolean;
  businessHours: BusinessHours | null;
  comments: CommentsConfig;
  hasOpenaiKey?: boolean;
  children: React.ReactNode; // panel de Identidad (server-rendered)
  kommoSlot: React.ReactNode;
  toolsSlot: React.ReactNode;
  seguimientoSlot: React.ReactNode;
  ajustesSlot: React.ReactNode;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="space-y-6">
      {/* Segmented control tabs */}
      <div className="flex flex-wrap gap-1 rounded-lg bg-neutral-100 p-1">
        <TabBtn active={tab === "agente"} onClick={() => setTab("agente")}>
          Agente
        </TabBtn>
        <TabBtn active={tab === "kommo"} onClick={() => setTab("kommo")}>
          Kommo
        </TabBtn>
        <TabBtn active={tab === "herramientas"} onClick={() => setTab("herramientas")}>
          Herramientas
        </TabBtn>
        <TabBtn active={tab === "seguimiento"} onClick={() => setTab("seguimiento")}>
          Seguimiento
        </TabBtn>
        <TabBtn active={tab === "ajustes"} onClick={() => setTab("ajustes")}>
          Ajustes
        </TabBtn>
      </div>

      {/* Todas las pestañas se mantienen montadas (CSS hidden) para no perder
          ediciones de forms al cambiar de pestaña. */}
      <div className={tab === "kommo" ? "" : "hidden"}>{kommoSlot}</div>
      <div className={tab === "herramientas" ? "" : "hidden"}>{toolsSlot}</div>
      <div className={tab === "seguimiento" ? "" : "hidden"}>{seguimientoSlot}</div>
      <div className={tab === "ajustes" ? "" : "hidden"}>{ajustesSlot}</div>

      {/* Agente: fusiona Identidad + Comportamiento + Acciones en una sola
          pestaña (antes separadas). Se mantiene montada con CSS hidden igual
          que el resto, para no perder ediciones de forms al cambiar de tab. */}
      <div className={(tab === "agente" ? "" : "hidden") + " space-y-8"}>
        <div>{children}</div>

        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Comportamiento
          </p>
          <BusinessHoursPanel initial={businessHours} />
          <FiltersPanel
            freshness={freshness}
            rules={rules}
            limits={limits}
            verticals={verticals}
            channels={channels}
            ignoredStageIds={ignoredStageIds}
            debounce={debounce}
            media={media}
            hasOpenaiKey={hasOpenaiKey}
          />
        </div>

        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Acciones
          </p>
          <CrmActionsPanel initial={crm} />
          <ShopifyActionsPanel initial={shopify} connected={shopifyConnected} />
          <BcvPanel initialEnabled={bcvEnabled} hasCustomSource={bcvHasCustomSource} />
          <CommentsPanel initial={comments} />
        </div>
      </div>
    </div>
  );
}
