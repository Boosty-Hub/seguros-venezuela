import { redirect } from "next/navigation";

// Kommo se fusionó dentro de la Configuración unificada (/agent) como una
// pestaña más — este redirect existe solo para no romper marcadores viejos.
export default function KommoRedirect({
  searchParams,
}: {
  searchParams: { saved?: string };
}) {
  redirect(searchParams.saved === "1" ? "/agent?tab=kommo&kommo_saved=1" : "/agent?tab=kommo");
}
