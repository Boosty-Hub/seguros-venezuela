import { headers } from "next/headers";
import { configValue } from "@/lib/runtime-config";
import { getShopifyStatus } from "@/lib/shopify";
import { SectionCard } from "@/components/ui";
import { UpdatesPanel } from "./updates-panel";
import { ShopifyConnect } from "./shopify-connect";
import { SettingsTabs, type SettingsTab } from "./settings-tabs";
import { EmbedCodePanel } from "./embed-code-panel";

// Cuerpo de la sección Ajustes — pestaña de la Configuración unificada
// (/agent). Sub-pestañas propias (Conexiones/Sistema/Integrar) usan el
// querystring `asub` — NO `tab`, que ya es el selector de pestaña de arriba.
export async function SettingsBody({
  asub,
}: {
  asub?: string;
}) {
  const shopifyStatus = await getShopifyStatus();
  const autoUpdateEnabled = (await configValue("AUTO_UPDATE_ENABLED")) !== "0";

  // URL base del panel — se detecta automáticamente, sin variable de entorno
  const host = headers().get("host") ?? "tu-dominio.com";
  const proto = headers().get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const baseUrl = `${proto}://${host}`;

  const initialTab: SettingsTab =
    asub === "sistema" ? "sistema" : asub === "integrar" ? "integrar" : "conexiones";

  // ── Slot: Conexiones ──────────────────────────────────────────────────────
  const conexiones = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <ShopifyConnect connected={shopifyStatus.configured} domain={shopifyStatus.domain} />
    </div>
  );

  // ── Slot: Integrar ───────────────────────────────────────────────────────
  const integrar = (
    <SectionCard
      title="Integrar en tu app"
      description="Embebe el dashboard dentro de cualquier app existente con una sola línea de código."
    >
      <EmbedCodePanel baseUrl={baseUrl} />
    </SectionCard>
  );

  // ── Slot: Sistema ─────────────────────────────────────────────────────────
  // Las alertas viven solo en la Torre de Control (in-system) — sin
  // Slack/Discord, se quitó el webhook de salida que nunca se llegó a usar.
  const sistema = <UpdatesPanel autoUpdateEnabled={autoUpdateEnabled} />;

  return (
    <SettingsTabs
      initialTab={initialTab}
      conexiones={conexiones}
      sistema={sistema}
      integrar={integrar}
    />
  );
}
