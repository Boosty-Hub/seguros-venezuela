// Edge Function: kb-transcribe
//
// Worker de la cola de ingesta de KB (tablas de la 0080). Hace dos cosas por
// invocación, en este orden:
//
//   1. TROCEAR los jobs nuevos: abre el archivo, cuenta páginas, decide si el
//      PDF trae capa de texto o hay que leerlo por visión, y crea las tandas.
//   2. TRANSCRIBIR tandas pendientes: parte el rango de páginas a un sub-PDF,
//      lo manda a visión y lo pasa por el juez de fidelidad. Si el juez no lo
//      aprueba, REPROCESA esa tanda con el modelo capaz y vuelve a juzgar.
//
// Lo dispara `kb-transcribe-worker` (pg_cron, cada minuto). No se encadena con
// kb-assemble: son crones independientes que miran el estado de la tabla, no
// un evento (trampa 16).
//
// PRESUPUESTO DE TIEMPO. El worker no toma una tanda si no le queda margen
// para terminarla dentro del wall clock (ver las constantes más abajo); lo que
// quede pendiente lo agarra el minuto siguiente. Sin eso el worker muere a
// mitad y la fila queda 'procesando' hasta que el reaper la rescata 10 minutos
// después. Varias invocaciones pueden solaparse sin problema: el claim usa
// `for update skip locked`, así que dos workers nunca toman la misma tanda.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { loadConfig } from "../_shared/config.ts";
import { esFalloDeCuenta } from "../_shared/provider-errors.ts";
import { logEvent } from "../_shared/system-log.ts";
import {
  FORMATOS_TEXTO,
  IMAGE_MEDIA_TYPES,
  MAX_BYTES_ARCHIVO,
  MIN_CHARS,
  contarPaginas,
  leerTextoPlano,
  looksMangled,
  partirPdf,
  sinCapaDeTexto,
  sondearPdf,
  transcribirPorVision,
  validarFidelidad,
} from "../_shared/kb-extract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "kb-uploads";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// El wall clock de una Edge Function es ~400s (0052). Lo que hay que evitar no
// es "pasarse al final": es EMPEZAR una tanda que no va a terminar. Una tanda
// de 10 páginas en el peor caso son cuatro llamadas al modelo (OCR barato →
// juez → reproceso con el capaz → juez) y puede irse a ~240s, así que solo se
// toma una nueva mientras quede ese margen. Parar a los 300s —como estaba—
// dejaba empezar una tanda a los 299s que moría a los 400s y había que esperar
// 10 minutos al reaper.
const WALL_CLOCK_MS = 400_000;
const TANDA_PEOR_CASO_MS = 240_000;
const CORTE_TANDAS_MS = WALL_CLOCK_MS - TANDA_PEOR_CASO_MS;
// Trocear es abrir el PDF y contar páginas: segundos, no minutos.
const CORTE_TROCEO_MS = 300_000;
// Tope duro por invocación. El corte por tiempo es el que manda casi siempre;
// esto solo evita que un lote de tandas rapidísimas monopolice un worker.
const TANDAS_POR_CORRIDA = 3;

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const quedaTiempo = (corte: number) => Date.now() - t0 < corte;

  // `{ job_id }` = llamada directa desde /api/kb/jobs justo después de subir,
  // para que las tandas aparezcan en pantalla sin esperar al cron. SOLO trocea
  // ese job y vuelve: si además drenara la cola podría tardar los 300s del
  // presupuesto y reventar los 26s de Netlify, que es de donde viene la
  // llamada. Transcribir siempre es trabajo del cron.
  const body = (await req.json().catch(() => ({}))) as { job_id?: string };
  const soloJob = typeof body.job_id === "string" ? body.job_id : null;

  const cfg = await loadConfig(supabase);
  const apiKey = cfg.get("ANTHROPIC_API_KEY");
  const ocrModel = cfg.getOr("KB_OCR_MODEL", "claude-haiku-4-5");
  const judgeModel = cfg.getOr("KB_JUDGE_MODEL", "claude-sonnet-5");
  const pricingOverrideRaw = cfg.get("AI_PRICING_OVERRIDES") ?? null;
  const paginasPorTanda = Math.max(1, Number(cfg.getOr("KB_PAGINAS_POR_TANDA", "10")) || 10);

  const resumen = { troceados: 0, tandas: 0, fallidos: 0 };

  // ---------------- 1. Trocear jobs nuevos ----------------
  // Trocear dos veces el mismo job es inofensivo: `crearTandas` hace upsert
  // sobre (job_id, idx), así que la llamada directa y el cron no se pisan.
  let nuevos: JobNuevo[] | null = null;
  if (soloJob) {
    const { data } = await supabase
      .from("kb_ingest_jobs")
      .select("id, storage_path, filename, ext, inline_content")
      .eq("id", soloJob)
      .eq("status", "pendiente")
      .maybeSingle();
    nuevos = data ? [data as JobNuevo] : [];
  } else {
    const { data, error: eNuevos } = await supabase.rpc("claim_kb_jobs_para_trocear", {
      p_limit: 5,
    });
    if (eNuevos) {
      await logEvent(supabase, "kb-transcribe", "error", "claim_kb_jobs_para_trocear falló", {
        error: eNuevos.message,
      });
    }
    nuevos = (data ?? []) as JobNuevo[];
  }

  for (const job of nuevos ?? []) {
    if (!quedaTiempo(CORTE_TROCEO_MS)) break;
    try {
      await trocear(job, { paginasPorTanda, tieneApiKey: Boolean(apiKey) });
      resumen.troceados++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await fallarJob(job.id, `no se pudo preparar el archivo: ${msg}`);
      resumen.fallidos++;
    }
  }

  // ---------------- 2. Transcribir tandas ----------------
  if (apiKey && !soloJob) {
    for (let i = 0; i < TANDAS_POR_CORRIDA && quedaTiempo(CORTE_TANDAS_MS); i++) {
      const { data: tandas, error: eTandas } = await supabase.rpc("claim_kb_tandas", {
        p_limit: 1,
      });
      if (eTandas) {
        await logEvent(supabase, "kb-transcribe", "error", "claim_kb_tandas falló", {
          error: eTandas.message,
        });
        break;
      }
      const tanda = ((tandas ?? []) as Tanda[])[0];
      if (!tanda) break;
      await procesarTanda(tanda, { apiKey, ocrModel, judgeModel, pricingOverrideRaw });
      resumen.tandas++;
    }
  }

  return new Response(JSON.stringify({ ok: true, ...resumen, ms: Date.now() - t0 }), {
    headers: { "content-type": "application/json" },
  });
});

// ---------------------------------------------------------------------------

type JobNuevo = {
  id: string;
  storage_path: string | null;
  filename: string;
  ext: string;
  inline_content: string | null;
};

type Tanda = {
  id: string;
  job_id: string;
  idx: number;
  page_from: number | null;
  page_to: number | null;
  storage_path: string | null;
  filename: string;
  ext: string;
};

async function descargar(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error || !data) throw new Error(`no se pudo leer el archivo subido: ${error?.message ?? "no encontrado"}`);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Abre el archivo y crea las tandas. Todo lo que NO es PDF es una sola tanda:
 * un DOCX o un TXT se leen enteros sin coste, y una imagen es una sola llamada
 * de visión.
 */
async function trocear(
  job: { id: string; storage_path: string | null; filename: string; ext: string; inline_content: string | null },
  opts: { paginasPorTanda: number; tieneApiKey: boolean }
) {
  // Markdown pegado a mano: no hay nada que extraer, la tanda nace lista.
  if (!job.storage_path) {
    const texto = (job.inline_content ?? "").trim();
    if (texto.length < MIN_CHARS) {
      await fallarJob(job.id, `el contenido es demasiado corto (menos de ${MIN_CHARS} caracteres).`);
      return;
    }
    await crearTandas(job.id, [{ idx: 0, texto, status: "listo" }]);
    await supabase.from("kb_ingest_jobs").update({ status: "transcribiendo" }).eq("id", job.id);
    return;
  }

  const bytes = await descargar(job.storage_path);
  if (bytes.byteLength > MAX_BYTES_ARCHIVO) {
    const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    await fallarJob(
      job.id,
      `el archivo pesa ${mb}MB y el máximo para procesarlo es ${Math.round(MAX_BYTES_ARCHIVO / (1024 * 1024))}MB. Divídelo y súbelo por partes.`
    );
    return;
  }

  const ext = job.ext;

  // --- Imagen: una tanda, directo a visión ---
  if (ext in IMAGE_MEDIA_TYPES) {
    if (!opts.tieneApiKey) {
      await fallarJob(job.id, "para leer imágenes hace falta configurar la clave de Anthropic; pega el contenido en el campo de markdown.");
      return;
    }
    await crearTandas(job.id, [{ idx: 0 }]);
    await supabase.from("kb_ingest_jobs").update({ status: "transcribiendo", total_pages: 1 }).eq("id", job.id);
    return;
  }

  if (!FORMATOS_TEXTO.has(ext)) {
    const soportados = [...FORMATOS_TEXTO, ...Object.keys(IMAGE_MEDIA_TYPES)].join(", ");
    await fallarJob(job.id, `formato no soportado: .${ext}. Acepta: ${soportados}`);
    return;
  }

  // --- No-PDF con capa de texto propia: una tanda, ya resuelta ---
  if (ext !== "pdf") {
    const texto = await leerTextoPlano(bytes, ext);
    if (texto.trim().length < MIN_CHARS) {
      await fallarJob(job.id, `el archivo no tiene texto suficiente para indexar (menos de ${MIN_CHARS} caracteres).`);
      return;
    }
    await crearTandas(job.id, [{ idx: 0, texto: texto.trim(), status: "listo" }]);
    await supabase.from("kb_ingest_jobs").update({ status: "transcribiendo" }).eq("id", job.id);
    return;
  }

  // --- PDF ---
  const { pages, textoCapa } = await sondearPdf(bytes);
  const total = pages || (await contarPaginas(bytes));
  const vacio = textoCapa.trim().length < MIN_CHARS || sinCapaDeTexto(textoCapa, total);
  const roto = !vacio && looksMangled(textoCapa);

  // PDF sano: el texto ya está, no se gasta un token.
  if (!vacio && !roto) {
    await crearTandas(job.id, [{ idx: 0, texto: textoCapa.trim(), status: "listo" }]);
    await supabase
      .from("kb_ingest_jobs")
      .update({ status: "transcribiendo", total_pages: total })
      .eq("id", job.id);
    return;
  }

  if (!opts.tieneApiKey) {
    const diag = vacio
      ? "este PDF no tiene texto seleccionable (es un escaneo)"
      : "el texto de este PDF se extrae ilegible (es un diseño con el texto vectorizado)";
    await fallarJob(job.id, `${diag} y para leerlo hace falta configurar la clave de Anthropic; pega el contenido en el campo de markdown.`);
    return;
  }

  // Escaneo o capa rota → tandas de páginas para visión.
  const tandas: Array<{ idx: number; page_from: number; page_to: number }> = [];
  let idx = 0;
  for (let desde = 1; desde <= total; desde += opts.paginasPorTanda) {
    tandas.push({
      idx: idx++,
      page_from: desde,
      page_to: Math.min(total, desde + opts.paginasPorTanda - 1),
    });
  }
  await crearTandas(job.id, tandas);
  await supabase
    .from("kb_ingest_jobs")
    .update({ status: "transcribiendo", total_pages: total })
    .eq("id", job.id);
  await logEvent(supabase, "kb-transcribe", "info", "documento troceado", {
    job_id: job.id, filename: job.filename, paginas: total, tandas: tandas.length,
  });
}

async function crearTandas(
  jobId: string,
  filas: Array<{ idx: number; page_from?: number; page_to?: number; texto?: string; status?: string }>
) {
  // `ignoreDuplicates` es lo que hace seguro trocear dos veces el mismo job
  // (la llamada directa desde /api/kb/jobs y el cron pueden coincidir en el
  // mismo segundo, y el reaper puede re-trocear uno que murió a mitad). Sin
  // esto el segundo troceo REESCRIBIRÍA las filas y devolvería a 'pendiente'
  // tandas ya transcritas, tirando el trabajo —y los tokens— a la basura.
  const { error } = await supabase.from("kb_ingest_tandas").upsert(
    filas.map((f) => ({
      job_id: jobId,
      idx: f.idx,
      page_from: f.page_from ?? null,
      page_to: f.page_to ?? null,
      texto: f.texto ?? null,
      status: f.status ?? "pendiente",
      via_vision: f.status !== "listo",
    })),
    { onConflict: "job_id,idx", ignoreDuplicates: true }
  );
  if (error) throw new Error(`no se pudieron crear las tandas: ${error.message}`);
}

async function fallarJob(jobId: string, motivo: string) {
  await supabase
    .from("kb_ingest_jobs")
    .update({ status: "fallido", last_error: motivo })
    .eq("id", jobId);
  await logEvent(supabase, "kb-transcribe", "warn", "job fallido", { job_id: jobId, motivo });
}

/**
 * Transcribe una tanda y la verifica.
 *
 * El reproceso vale la pena porque la transcripción no es determinista: en
 * pruebas reales sobre el mismo flyer, el modelo barato leyó "Remodelación y
 * limpieza de escombros" donde el documento dice "Remoción" (cambia el
 * beneficio). El juez lo detectó, el reproceso con el modelo capaz salió
 * limpio y el documento entró solo. Acá el reproceso cuesta UNA tanda, no el
 * documento entero, que es lo que hacía cara esta parte.
 */
async function procesarTanda(
  tanda: Tanda,
  opts: { apiKey: string; ocrModel: string; judgeModel: string; pricingOverrideRaw: string | null }
) {
  try {
    if (!tanda.storage_path) throw new Error("la tanda no tiene archivo asociado");
    const completo = await descargar(tanda.storage_path);
    const esPdf = tanda.ext === "pdf";
    const mediaType = esPdf ? "application/pdf" : IMAGE_MEDIA_TYPES[tanda.ext];
    if (!mediaType) throw new Error(`no se puede leer por imagen un .${tanda.ext}`);

    // Solo las páginas de esta tanda. Una imagen viaja entera.
    const trozo =
      esPdf && tanda.page_from && tanda.page_to
        ? await partirPdf(completo, tanda.page_from, tanda.page_to)
        : completo;
    const paginas =
      tanda.page_from && tanda.page_to ? tanda.page_to - tanda.page_from + 1 : 1;
    const meta = {
      job_id: tanda.job_id,
      tanda: tanda.idx,
      paginas: tanda.page_from ? `${tanda.page_from}-${tanda.page_to}` : null,
    };

    // Intento 1: modelo barato.
    const primero = await transcribirPorVision(supabase, trozo, {
      apiKey: opts.apiKey, model: opts.ocrModel, filename: tanda.filename,
      mediaType, paginas, pricingOverrideRaw: opts.pricingOverrideRaw, metadata: meta,
    });
    if (!primero.ok) {
      await fallarTanda(tanda, primero.reason);
      return;
    }

    const v1 = await validarFidelidad(supabase, trozo, primero.text, {
      apiKey: opts.apiKey, model: opts.judgeModel, mediaType,
      filename: tanda.filename, pricingOverrideRaw: opts.pricingOverrideRaw, metadata: meta,
    });
    if (v1.veredicto === "ok") {
      await listarTanda(tanda, primero.text, []);
      return;
    }

    // Intento 2: el modelo capaz relee desde cero. No se le pide "corregir" el
    // texto anterior a propósito — arrastraría sus errores.
    const segundo = await transcribirPorVision(supabase, trozo, {
      apiKey: opts.apiKey, model: opts.judgeModel, filename: tanda.filename,
      mediaType, paginas, pricingOverrideRaw: opts.pricingOverrideRaw,
      metadata: { ...meta, reproceso: true },
    });
    if (!segundo.ok) {
      // El reproceso falló: queda lo del primer intento, con sus reparos.
      await listarTanda(tanda, primero.text, v1.problemas);
      return;
    }
    const v2 = await validarFidelidad(supabase, trozo, segundo.text, {
      apiKey: opts.apiKey, model: opts.judgeModel, mediaType,
      filename: tanda.filename, pricingOverrideRaw: opts.pricingOverrideRaw,
      metadata: { ...meta, reproceso: true },
    });
    // Sigue sin pasar limpio: se guarda la MEJOR versión (la del modelo capaz)
    // con los reparos, para que un humano decida al ensamblar.
    await listarTanda(tanda, segundo.text, v2.veredicto === "ok" ? [] : v2.problemas);
  } catch (err) {
    await fallarTanda(tanda, err instanceof Error ? err.message : String(err));
  }
}

async function listarTanda(tanda: Tanda, texto: string, issues: string[]) {
  await supabase
    .from("kb_ingest_tandas")
    .update({ status: "listo", texto, issues, via_vision: true, last_error: null })
    .eq("id", tanda.id);
}

/**
 * Marca la tanda como pendiente otra vez si le quedan reintentos (el claim la
 * volverá a tomar), o fallida si ya se agotaron. Que una tanda falle NO tumba
 * el documento: el ensamblador lo reporta como reparo y el operador decide.
 *
 * Un fallo de CUENTA o de plataforma (sin saldo, 429, 5xx, timeout) NO gasta
 * intento y además devuelve el que consumió el claim: es la trampa 30, que ya
 * costó 102 mensajes en `process-inbound`. Si la cuenta se queda sin crédito a
 * mitad de cargar los condicionados, con un tope ciego las tandas quemarían
 * sus 4 intentos contra un 400 que no tiene nada que ver con el documento y
 * quedarían condenadas. Reintentar indefinidamente ahí es seguro: mientras
 * dura el corte fallan TODAS (no hay llamadas que consumir) y al resolverse la
 * cola se drena sola.
 */
async function fallarTanda(tanda: Tanda, motivo: string) {
  const deCuenta = esFalloDeCuenta(motivo);
  const { data } = await supabase
    .from("kb_ingest_tandas")
    .select("attempts")
    .eq("id", tanda.id)
    .single();
  const attempts = (data?.attempts as number) ?? 99;
  const definitivo = !deCuenta && attempts >= 4;
  await supabase
    .from("kb_ingest_tandas")
    .update({
      status: definitivo ? "fallido" : "pendiente",
      attempts: deCuenta ? Math.max(0, attempts - 1) : attempts,
      claimed_at: null,
      last_error: motivo,
    })
    .eq("id", tanda.id);
  await logEvent(supabase, "kb-transcribe", definitivo ? "error" : "warn", "tanda no transcrita", {
    job_id: tanda.job_id, tanda: tanda.idx, intento: attempts, de_cuenta: deCuenta, definitivo, motivo,
  });
}
