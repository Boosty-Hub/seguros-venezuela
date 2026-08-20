import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ToolEditor } from "./tool-editor";

export type AgentTool = {
  id: string;
  name: string;
  description: string;
  tool_type: "system" | "http";
  enabled: boolean;
  http_method: string | null;
  url_template: string | null;
  headers: Array<{ name: string; value: string }>;
  body_template: unknown | null;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  timeout_ms: number;
  created_at: string;
};

// Cuerpo de la sección Herramientas — pestaña de la Configuración unificada
// (/agent). Sin querystring propio: nada que reconciliar con las otras pestañas.
export async function ToolsBody() {
  const supabase = createSupabaseServerClient();
  const { data: tools } = await supabase
    .from("agent_tools")
    .select("*")
    .order("tool_type", { ascending: false }) // 'system' > 'http'
    .order("created_at", { ascending: true });

  const rows = (tools ?? []) as AgentTool[];
  const enabledHttpCount = rows.filter(
    (t) => t.tool_type === "http" && t.enabled
  ).length;

  return <ToolEditor tools={rows} enabledHttpCount={enabledHttpCount} />;
}
