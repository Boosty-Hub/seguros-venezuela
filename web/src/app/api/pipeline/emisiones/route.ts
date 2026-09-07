import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { parseEmisiones, resumir, type FilaEmision } from "@/lib/emisiones";

// nodejs: se lee un archivo completo en memoria y se usa TextDecoder con
// iso-8859-1, que no está en el runtime Edge.
export const runtime = "nodejs";
export const maxDuration = 60;

// Las funciones síncronas de Netlify cortan a los 26s, así que los upserts van
// por lotes y nunca en una sola petición gigante.
const LOTE_ESCRITURA = 400;
const LOTE_LECTURA = 200;

// GET: historial de cargas, para el panel.
export async function GET() {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const svc = createServiceClient();
    const [{ data: cargas }, { count: recibos }, { data: periodo }] = await Promise.all([
      svc.from("emision_cargas").select("*").order("creado_en", { ascending: false }).limit(12),
      svc.from("polizas_emitidas").select("recibo", { count: "exact", head: true }),
      svc.rpc("zoho_corredores_efectividad", { p_since: null, p_maduracion_dias: 60 }),
    ]);

    return NextResponse.json({
      cargas: cargas ?? [],
      recibos_totales: recibos ?? 0,
      periodo_emisiones: (periodo as { periodo_emisiones?: unknown })?.periodo_emisiones ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("pipeline/emisiones GET:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // Handler envuelto: una excepción cruda se escapaba como 500 sin cuerpo JSON
  // y el frontend explotaba en el res.json() sin mostrar nada (mismo criterio
  // que /api/kb/ingest).
  try {
    return await manejar(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("pipeline/emisiones: error inesperado:", err);
    return NextResponse.json({ error: `error inesperado: ${msg}` }, { status: 500 });
  }
}

async function manejar(request: Request): Promise<Response> {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData();
  const archivo = form.get("archivo");
  const modo = String(form.get("modo") ?? "preview");

  if (!(archivo instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo." }, { status: 400 });
  }
  if (modo !== "preview" && modo !== "confirmar") {
    return NextResponse.json({ error: `modo inválido: ${modo}` }, { status: 400 });
  }

  const buf = await archivo.arrayBuffer();
  const { filas, errores, avisos, juego } = parseEmisiones(buf);
  if (errores.length) {
    return NextResponse.json({ error: errores.join(" "), avisos }, { status: 400 });
  }

  const svc = createServiceClient();
  const resumen = resumir(filas);

  // ── Qué de esto ya está cargado ─────────────────────────────────────────
  // Se pregunta por los recibos del archivo en lotes: un `in()` con 655 ids
  // hace una URL demasiado larga, y PostgREST corta en 1000 filas sin avisar
  // (trampa 5), así que nunca se pide "todo" de una.
  const recibos = filas.map((f) => f.recibo);
  const existentes = new Set<string>();
  for (let i = 0; i < recibos.length; i += LOTE_LECTURA) {
    const trozo = recibos.slice(i, i + LOTE_LECTURA);
    const { data, error } = await svc.from("polizas_emitidas").select("recibo").in("recibo", trozo);
    if (error) return NextResponse.json({ error: `leyendo recibos: ${error.message}` }, { status: 500 });
    for (const r of data ?? []) existentes.add(r.recibo as string);
  }

  const nuevos = recibos.filter((r) => !existentes.has(r)).length;
  const actualizados = existentes.size;

  // ── Intermediarios que aparecerían por primera vez ──────────────────────
  const codigos = resumen.intermediarios.map((i) => i.cod);
  const codsConocidos = new Set<string>();
  for (let i = 0; i < codigos.length; i += LOTE_LECTURA) {
    const trozo = codigos.slice(i, i + LOTE_LECTURA);
    const { data, error } = await svc.from("intermediarios").select("cod_intermediario").in("cod_intermediario", trozo);
    if (error) return NextResponse.json({ error: `leyendo intermediarios: ${error.message}` }, { status: 500 });
    for (const r of data ?? []) codsConocidos.add(r.cod_intermediario as string);
  }
  const intermediariosNuevos = resumen.intermediarios.filter((i) => !codsConocidos.has(i.cod));

  // ── Cuántas pólizas del archivo cruzan con una cotización de Zoho ───────
  // Se estima con las cédulas del archivo contra las de los tickets. Es el
  // dato que dice si el cruce va a servir de algo antes de escribir nada.
  const cedulas = Array.from(new Set(filas.flatMap((f) => [f.ci_tomador_digitos, f.ci_asegurado_digitos]).filter((c): c is string => !!c)));
  const { data: cruce, error: errCruce } = await svc.rpc("zoho_cedulas_conocidas", { p_cedulas: cedulas });
  const cedulasEnZoho: string[] = errCruce ? [] : ((cruce as string[]) ?? []);
  const setZoho = new Set(cedulasEnZoho);
  const polizasQueCruzan = new Set(
    filas
      .filter((f) => (f.ci_tomador_digitos && setZoho.has(f.ci_tomador_digitos)) || (f.ci_asegurado_digitos && setZoho.has(f.ci_asegurado_digitos)))
      .map((f) => f.nu_poliza)
  ).size;

  const preview = {
    archivo: archivo.name,
    juego_caracteres: juego,
    avisos,
    ...resumen,
    intermediarios: undefined, // se reemplaza por el conteo + los nuevos
    intermediarios_total: resumen.intermediarios.length,
    intermediarios_nuevos: intermediariosNuevos,
    recibos_nuevos: nuevos,
    recibos_actualizados: actualizados,
    polizas_que_cruzan: polizasQueCruzan,
    muestra: filas.slice(0, 8).map((f) => ({
      recibo: f.recibo,
      nu_poliza: f.nu_poliza,
      estatus: f.estatus,
      nombre_tomador: f.nombre_tomador,
      ci_tomador: f.ci_tomador,
      nombre_asegurado: f.nombre_asegurado,
      nombre_intermediario: f.nombre_intermediario,
      prima_recibo: f.prima_recibo,
      fecha_suscripcion: f.fecha_suscripcion,
      cruza: !!((f.ci_tomador_digitos && setZoho.has(f.ci_tomador_digitos)) || (f.ci_asegurado_digitos && setZoho.has(f.ci_asegurado_digitos))),
    })),
  };

  if (modo === "preview") {
    return NextResponse.json({ modo: "preview", preview });
  }

  // ── Confirmar: escribir ─────────────────────────────────────────────────
  const { data: carga, error: errCarga } = await svc
    .from("emision_cargas")
    .insert({
      archivo: archivo.name,
      filas_archivo: filas.length,
      recibos_nuevos: nuevos,
      recibos_actualizados: actualizados,
      polizas: resumen.polizas,
      intermediarios_nuevos: intermediariosNuevos.length,
      periodo_desde: resumen.periodo_desde,
      periodo_hasta: resumen.periodo_hasta,
      subido_por: user.email ?? user.id,
    })
    .select("id")
    .single();
  if (errCarga) return NextResponse.json({ error: `registrando la carga: ${errCarga.message}` }, { status: 500 });
  const cargaId = carga.id as number;

  // Intermediarios primero: polizas_emitidas no los referencia por FK, pero
  // corredor_alias sí, y el auto-mapeo corre al final de esta misma petición.
  //
  // Vía RPC y no con un upsert directo porque `nombre_norm` tiene que salir de
  // public.zoho_norm() — es lo único contra lo que se compara al mapear alias,
  // y dos normalizaciones parecidas pero distintas (una en SQL, otra en JS)
  // romperían el mapeo justo en los nombres con acentos.
  if (resumen.intermediarios.length) {
    const { error } = await svc.rpc("emisiones_upsert_intermediarios", {
      p_rows: resumen.intermediarios,
    });
    if (error) return NextResponse.json({ error: `guardando intermediarios: ${error.message}` }, { status: 500 });
  }

  const conCarga = filas.map((f) => ({ ...f, carga_id: cargaId, actualizado_en: new Date().toISOString() }));
  for (let i = 0; i < conCarga.length; i += LOTE_ESCRITURA) {
    const { error } = await svc
      .from("polizas_emitidas")
      .upsert(conCarga.slice(i, i + LOTE_ESCRITURA) as unknown as FilaEmision[], { onConflict: "recibo" });
    if (error) return NextResponse.json({ error: `guardando pólizas: ${error.message}` }, { status: 500 });
  }

  // Auto-mapeo de alias: propone equivalencias para los asesores de Zoho que
  // todavía no tienen código. No toca los manuales ni los rechazados.
  const { data: mapeo, error: errMapeo } = await svc.rpc("zoho_mapear_corredores", { p_umbral: 0.6 });

  return NextResponse.json({
    modo: "confirmar",
    carga_id: cargaId,
    preview,
    mapeo: errMapeo ? { error: errMapeo.message } : mapeo,
  });
}
