import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell, EmptyState } from "@/components/ui";
import { VerticalRow, NewVerticalForm, type UsoVertical, type SaludDoc } from "./vertical-editor";

export const dynamic = "force-dynamic";

// Ventana de "actividad reciente" de la columna de mensajes.
const DIAS_RECIENTES = 7;

const nf = new Intl.NumberFormat("es-VE");
const fmtDia = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("es-VE", { day: "2-digit", month: "short" });

type Vertical = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  system_prompt: string;
  auto_reply: boolean;
  requires_review: boolean;
  ignore: boolean;
};

type Uso = {
  dias_recientes: number;
  por_vertical: Record<string, UsoVertical>;
  reconciliacion: {
    total: number;
    clasificados: number;
    ignorados: number;
    sin_clasificar: number;
    fallidos: number;
    en_cola: number;
    fallidos_desde: string | null;
    fallidos_hasta: string | null;
  };
};

type KBDocument = {
  id: string;
  title: string;
  sourceType: string;
  totalChunks: number;
  createdAt: string;
};

export default async function VerticalesPage() {
  const supabase = createSupabaseServerClient();
  const [{ data: verticals }, { data: rawDocs }, { data: usoData }, { data: saludData }] =
    await Promise.all([
    supabase
      .from("verticals")
      .select("id, slug, name, description, system_prompt, auto_reply, requires_review, ignore")
      .order("slug"),
    supabase
      .from("kb_documents")
      .select("id, title, source_type, total_chunks, created_at, vertical_id")
      .order("created_at", { ascending: false }),
    // Cuántos mensajes ha clasificado el agente en cada vertical (0078).
    supabase.rpc("verticales_uso", { p_dias_recientes: DIAS_RECIENTES }),
    // Calidad de lo YA indexado (0084): es lo que hace visible un documento
    // roto sin tener que abrir la vertical y leerlo.
    supabase.rpc("kb_salud_documentos"),
  ]);

  const saludPorVertical = new Map<string, SaludDoc[]>();
  for (const d of (saludData ?? []) as SaludDoc[]) {
    if (!d.vertical_id) continue;
    const list = saludPorVertical.get(d.vertical_id) ?? [];
    list.push(d);
    saludPorVertical.set(d.vertical_id, list);
  }

  const uso = (usoData ?? null) as Uso | null;
  const usoPorVertical = uso?.por_vertical ?? {};
  const rec = uso?.reconciliacion;

  const verticalList = (verticals ?? []) as Vertical[];

  // Documentos de KB agrupados por vertical — cada vertical solo ve (y sube)
  // los suyos; no existe más el concepto de "documento general".
  const docsByVertical = new Map<string, KBDocument[]>();
  for (const d of rawDocs ?? []) {
    if (!d.vertical_id) continue;
    const list = docsByVertical.get(d.vertical_id as string) ?? [];
    list.push({
      id: d.id as string,
      title: d.title as string,
      sourceType: d.source_type as string,
      totalChunks: (d.total_chunks as number) ?? 0,
      createdAt: d.created_at as string,
    });
    docsByVertical.set(d.vertical_id as string, list);
  }

  return (
    <PageShell
      title="Verticales"
      description="Categorías de mensajes. El clasificador usa la descripción para asignar la vertical; el agente usa el prompt específico como instrucción por vertical y solo consulta los documentos de conocimiento (RAG) de la vertical activa — súbelos entrando a cada una."
      actions={<NewVerticalForm />}
    >
      {verticalList.length === 0 ? (
        <EmptyState
          title="Sin verticales configuradas"
          description="Agrega una vertical para que el clasificador pueda categorizar los mensajes entrantes."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="sticky top-0 bg-neutral-50/60 text-left">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Identificador</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Nombre</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Respuesta automática</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Revisión humana</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">No clasificar</th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400"
                    title={`Mensajes que el clasificador ha metido en esta vertical. El segundo número son los de los últimos ${DIAS_RECIENTES} días; el tercero, su peso sobre todo lo clasificado.`}
                  >
                    Mensajes · {DIAS_RECIENTES}d · %
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Documentos KB</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {verticalList.map((v) => (
                  <VerticalRow
                    key={v.id}
                    vertical={v}
                    docs={docsByVertical.get(v.id) ?? []}
                    salud={saludPorVertical.get(v.id) ?? []}
                    uso={usoPorVertical[v.id]}
                    diasRecientes={uso?.dias_recientes ?? DIAS_RECIENTES}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {/* Pie de tabla.
              La reconciliación no es adorno: la columna de mensajes NO suma el
              total de entrantes, y sin decir por qué parece que el módulo se
              come registros. Los ignorados nunca llegan al clasificador (el
              lead está en una etapa que el agente no atiende, o la media está
              desactivada); los fallidos sí deberían estar clasificados. */}
          <div className="space-y-1 border-t border-neutral-100 px-4 py-2.5 text-xs text-neutral-500">
            <div>
              {verticalList.length} {verticalList.length === 1 ? "vertical" : "verticales"} en total
              {rec && (
                <>
                  {" · "}
                  <strong className="text-neutral-700">{nf.format(rec.clasificados)}</strong> mensajes clasificados
                  {" de "}
                  {nf.format(rec.total)} entrantes
                </>
              )}
            </div>
            {rec && (rec.ignorados > 0 || rec.sin_clasificar > 0) && (
              <div className="text-[11px] text-neutral-400">
                Los otros {nf.format(rec.total - rec.clasificados)}:{" "}
                <strong>{nf.format(rec.ignorados)} ignorados a propósito</strong> (el lead está en una etapa que el
                agente no atiende, o llegó una imagen/documento con su manejo desactivado — nunca pasan por el
                clasificador)
                {rec.fallidos > 0 && (
                  <>
                    {" y "}
                    <strong className="text-amber-700">{nf.format(rec.fallidos)} que fallaron</strong>
                    {rec.fallidos_desde && rec.fallidos_hasta && (
                      <> (entre el {fmtDia(rec.fallidos_desde)} y el {fmtDia(rec.fallidos_hasta)})</>
                    )}
                  </>
                )}
                {rec.en_cola > 0 && <> y {nf.format(rec.en_cola)} en cola de clasificación</>}.
              </div>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
