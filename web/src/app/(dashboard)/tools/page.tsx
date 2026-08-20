import { redirect } from "next/navigation";

// Herramientas se fusionó dentro de la Configuración unificada (/agent) como
// una pestaña más — este redirect existe solo para no romper marcadores viejos.
export default function ToolsRedirect() {
  redirect("/agent?tab=herramientas");
}
