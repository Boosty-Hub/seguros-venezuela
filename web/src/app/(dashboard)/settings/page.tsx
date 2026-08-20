import { redirect } from "next/navigation";

// Ajustes se fusionó dentro de la Configuración unificada (/agent) como una
// pestaña más — este redirect existe solo para no romper marcadores viejos.
export default function SettingsRedirect({
  searchParams,
}: {
  searchParams: { alerts_saved?: string; tab?: string };
}) {
  const params = new URLSearchParams({ tab: "ajustes" });
  if (searchParams.alerts_saved === "1") params.set("alerts_saved", "1");
  if (searchParams.tab) params.set("asub", searchParams.tab);
  redirect(`/agent?${params.toString()}`);
}
