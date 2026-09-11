// Edge Function: kb-assemble
//
// Segunda mitad de la cola de ingesta de KB (0080). Toma los jobs cuyas tandas
// ya terminaron, une el texto en orden, juzga la VERTICAL, trocea, embebe e
// indexa en kb_documents/kb_chunks.
//
// Lo dispara `kb-assemble-worker` (pg_cron, cada minuto) y también lo llama
// directo /api/kb/jobs cuando el contenido es markdown pegado a mano — ahí no
// hay nada que transcribir y esperar al cron sería un minuto de espera para
// algo instantáneo. El cron sigue siendo la red de seguridad: mira el estado
// de la tabla, no depende de que la llamada directa haya ocurrido (misma forma
// que `zoho-kommo-push-safety`).
//
// NADA entra a una vertical sin pasar el control:
//   - vertical "mal"  → job fallido. Un tarifario de automóvil dentro de
//     "salud" hace que el agente le cite coberturas de auto a alguien que
//     pregunta por una póliza médica.
//   - reparos de fidelidad, tandas fallidas o vertical "duda" → job en
//     'revision': el texto queda a la vista para que un humano lo corrija y
//     apruebe. Ese POST vuelve con status 'aprobado' y entra saltando jueces.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { loadConfig } from "../_shared/config.ts";
import { logEvent } from "../_shared/system-log.ts";
import { MIN_CHARS, chunkText, embedTexts, validarVertical } from "../_shared/kb-extract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "kb-uploads";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Mismo criterio que kb-transcribe: no empezar un job que no vaya a terminar
// dentro de los ~400s de wall clock. Ensamblar es el juez de vertical (~10s)
// más los embeddings, que es lo que puede irse largo — un condicionado de 40
// páginas da cientos de chunks y la función `embed` va de a 3 con reintentos,
// así que se reserva ~120s para eso.
const WALL_CLOCK_MS = 400_000;
const JOB_PEOR_CASO_MS = 120_000;
const CORTE_MS = WALL_CLOCK_MS - JOB_PEOR_CASO_MS;

Deno.serve(async (req: Request) => {
  const t0 = Date.now();

  // `{ job_id }` = llamada directa desde /api/kb/jobs: markdown pegado a mano
  // (que no tiene nada que transcribir) o un texto que un humano acaba de
  // aprobar. En los dos casos es cuestión de segundos y hacer esperar un
  // minuto al cron sería absurdo. El cron sigue siendo la red de seguridad —
  // mira el estado de la tabla, no depende de esta llamada.
  const body = (await req.json().catch(() => ({}))) as { job_id?: string };
  const soloJob = typeof body.job_id === "string" ? body.job_id : null;

  const cfg = await loadConfig(supabase);
  const apiKey = cfg.get("ANTHROPIC_API_KEY");
  const judgeModel = cfg.getOr("KB_JUDGE_MODEL", "claude-sonnet-5");
  const pricingOverrideRaw = cfg.get("AI_PRICING_OVERRIDES") ?? null;

  let jobs: Job[] = [];
  if (soloJob) {
    // Hay que leer el estado ANTES de reclamarlo: el update devuelve la fila
    // ya en 'ensamblando' y se perdería justo el dato que distingue un job
    // aprobado por un humano (que se salta los jueces) de uno recién
    // transcrito.
    const { data: previo } = await supabase
      .from("kb_ingest_jobs")
      .select("status")
      .eq("id", soloJob)
      .maybeSingle();
    const eraAprobado = previo?.status === "aprobado";
    // Y que no queden tandas en vuelo, que es la condición que sí comprueba
    // `claim_kb_jobs_para_ensamblar` y que este atajo se saltaría.
    const { count: enVuelo } = await supabase
      .from("kb_ingest_tandas")
      .select("id", { count: "exact", head: true })
      .eq("job_id", soloJob)
      .in("status", ["pendiente", "procesando"]);
    if ((enVuelo ?? 0) === 0) {
      // Claim con guarda de estado: si el cron ya se lo llevó, el update no
      // toca ninguna fila y esta llamada no hace nada.
      const { data } = await supabase
        .from("kb_ingest_jobs")
        .update({ status: "ensamblando", claimed_at: new Date().toISOString() })
        .eq("id", soloJob)
        .in("status", ["transcribiendo", "aprobado"])
        .select("id, title, vertical_id, storage_path, filename, ext")
        .maybeSingle();
      if (data) jobs = [{ ...(data as Omit<Job, "aprobado">), aprobado: eraAprobado }];
    }
  } else {
    const { data, error } = await supabase.rpc("claim_kb_jobs_para_ensamblar", { p_limit: 3 });
    if (error) {
      await logEvent(supabase, "kb-assemble", "error", "claim_kb_jobs_para_ensamblar falló", {
        error: error.message,
      });
      return json({ ok: false, error: error.message }, 500);
    }
    jobs = (data ?? []) as Job[];
  }

  const resumen = { indexados: 0, revision: 0, fallidos: 0 };
  for (const job of (jobs ?? []) as Job[]) {
    if (Date.now() - t0 > CORTE_MS) break;
    try {
      const r = await ensamblar(job, { apiKey, judgeModel, pricingOverrideRaw });
      resumen[r]++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase
        .from("kb_ingest_jobs")
        .update({ status: "fallido", last_error: `error al indexar: ${msg}` })
        .eq("id", job.id);
      await logEvent(supabase, "kb-assemble", "error", "ensamblado falló", {
        job_id: job.id, error: msg,
      });
      resumen.fallidos++;
    }
  }

  return json({ ok: true, ...resumen, ms: Date.now() - t0 });
});

// ---------------------------------------------------------------------------

type Job = {
  id: string;
  title: string;
  vertical_id: string;
  storage_path: string | null;
  filename: string;
  ext: string;
  aprobado: boolean;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function ensamblar(
  job: Job,
  opts: { apiKey?: string; judgeModel: string; pricingOverrideRaw: string | null }
): Promise<"indexados" | "revision" | "fallidos"> {
  const reparos: string[] = [];
  let texto: string;

  if (job.aprobado) {
    // Ya lo revisó un humano: su texto (posiblemente corregido) manda, y no se
    // vuelve a juzgar nada. Una persona es más autoridad que el juez.
    const { data } = await supabase
      .from("kb_ingest_jobs")
      .select("texto")
      .eq("id", job.id)
      .single();
    texto = String(data?.texto ?? "");
  } else {
    const { data: tandas, error } = await supabase
      .from("kb_ingest_tandas")
      .select("idx, texto, issues, status, last_error, page_from, page_to")
      .eq("job_id", job.id)
      .order("idx");
    if (error) throw new Error(`no se pudieron leer las tandas: ${error.message}`);

    const filas = (tandas ?? []) as Array<{
      idx: number; texto: string | null; issues: string[] | null;
      status: string; last_error: string | null; page_from: number | null; page_to: number | null;
    }>;
    for (const t of filas) {
      if (t.status === "fallido") {
        const donde = t.page_from ? `páginas ${t.page_from}-${t.page_to}` : `parte ${t.idx + 1}`;
        reparos.push(`no se pudieron leer las ${donde}: ${t.last_error ?? "motivo desconocido"}`);
        continue;
      }
      for (const p of t.issues ?? []) {
        const donde = t.page_from ? `págs. ${t.page_from}-${t.page_to}` : `parte ${t.idx + 1}`;
        reparos.push(`[${donde}] ${p}`);
      }
    }
    texto = filas
      .filter((t) => t.status === "listo" && t.texto)
      .map((t) => (t.texto ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  if (texto.trim().length < MIN_CHARS) {
    await supabase
      .from("kb_ingest_jobs")
      .update({
        status: "fallido",
        texto,
        issues: reparos,
        last_error: `no se extrajo texto suficiente para indexar (menos de ${MIN_CHARS} caracteres).`,
      })
      .eq("id", job.id);
    return "fallidos";
  }

  // ---- Juez de vertical (no corre sobre lo ya aprobado por un humano) ----
  if (!job.aprobado) {
    if (!opts.apiKey) {
      reparos.push("no se pudo validar automáticamente (falta la clave de Anthropic)");
    } else {
      const { data: vs } = await supabase.from("verticals").select("id, slug, name, description");
      const todas = (vs ?? []) as Array<{ id: string; slug: string; name: string; description: string | null }>;
      const destino = todas.find((v) => v.id === job.vertical_id);
      if (destino) {
        const ver = await validarVertical(supabase, texto, {
          apiKey: opts.apiKey,
          model: opts.judgeModel,
          verticalSlug: destino.slug,
          verticalNombre: destino.name,
          verticalDescripcion: destino.description,
          otrasVerticales: todas
            .filter((v) => v.id !== job.vertical_id)
            .map((v) => ({ slug: v.slug, description: v.description })),
          filename: job.filename,
          pricingOverrideRaw: opts.pricingOverrideRaw,
        });
        if (ver.veredicto === "mal") {
          const sugerencia = ver.vertical_sugerida ? ` Parece pertenecer a "${ver.vertical_sugerida}".` : "";
          await limpiarStorage(job);
          await supabase
            .from("kb_ingest_jobs")
            .update({
              status: "fallido",
              texto,
              issues: reparos,
              last_error:
                `Este documento no corresponde a la vertical destino.${sugerencia} ${ver.motivo ?? ""} No se indexó — súbelo en la vertical correcta.`.trim(),
            })
            .eq("id", job.id);
          return "fallidos";
        }
        if (ver.veredicto === "duda") {
          reparos.push(
            ver.motivo
              ? `encaje con la vertical "${destino.slug}" no es claro: ${ver.motivo}`
              : `no está claro si corresponde a la vertical "${destino.slug}"`
          );
        }
      }
    }
  }

  // ---- Hay reparos: no se indexa, va a revisión humana ----
  if (reparos.length > 0) {
    await supabase
      .from("kb_ingest_jobs")
      .update({ status: "revision", texto, issues: reparos, claimed_at: null })
      .eq("id", job.id);
    await logEvent(supabase, "kb-assemble", "info", "job a revisión humana", {
      job_id: job.id, filename: job.filename, reparos: reparos.length,
    });
    return "revision";
  }

  // ---- Indexar ----
  await indexar(job, texto);
  return "indexados";
}

async function indexar(job: Job, texto: string) {
  const chunks = chunkText(texto, { maxTokens: 450, overlapTokens: 60 });
  if (chunks.length === 0) throw new Error("el troceo semántico produjo 0 fragmentos");

  // Trazabilidad de CÓMO se leyó: un documento transcrito por un modelo no se
  // audita igual que uno con capa de texto. Sale de las tandas, no de una
  // constante, porque dentro de un mismo job puede haber de las dos.
  const { count: porVision } = await supabase
    .from("kb_ingest_tandas")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id)
    .eq("via_vision", true);

  const { data: doc, error: docErr } = await supabase
    .from("kb_documents")
    .insert({
      title: job.title,
      source_type: job.ext,
      source_filename: job.filename,
      raw_text: texto,
      embeddings_provider: "supabase_ai_gte_small",
      embeddings_dim: 384,
      total_chunks: chunks.length,
      metadata: {
        format: job.ext,
        ...((porVision ?? 0) > 0 ? { extracted_via: "vision" } : {}),
        validation: job.aprobado ? "humano" : "automatico",
      },
      vertical_id: job.vertical_id,
    })
    .select("id")
    .single();
  if (docErr || !doc) throw new Error(docErr?.message ?? "no se pudo crear el documento");

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(chunks, { supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE });
  } catch (err) {
    await supabase.from("kb_documents").delete().eq("id", doc.id);
    throw new Error(`embeddings: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { error: chunksErr } = await supabase.from("kb_chunks").insert(
    chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: embeddings[i],
      token_count: Math.ceil(content.split(/\s+/).length * 1.8),
      metadata: {},
    }))
  );
  if (chunksErr) {
    await supabase.from("kb_documents").delete().eq("id", doc.id);
    throw new Error(chunksErr.message);
  }

  await limpiarStorage(job);
  await supabase
    .from("kb_ingest_jobs")
    .update({ status: "listo", texto, issues: [], document_id: doc.id, last_error: null })
    .eq("id", job.id);
  await logEvent(supabase, "kb-assemble", "info", "documento indexado", {
    job_id: job.id, document_id: doc.id, filename: job.filename, chunks: chunks.length,
  });
}

/** El original solo hace falta hasta que el documento entra. */
async function limpiarStorage(job: Job) {
  if (!job.storage_path) return;
  try {
    await supabase.storage.from(BUCKET).remove([job.storage_path]);
  } catch { /* fail-open: dejar un temporal huérfano no puede tumbar la ingesta */ }
}
