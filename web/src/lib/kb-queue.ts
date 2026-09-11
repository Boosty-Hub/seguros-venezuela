// server-only: despertar a los workers de la cola de KB.
//
// Los dos workers (kb-transcribe, kb-assemble) los dispara `pg_cron` cada
// minuto, que es la red de seguridad de verdad — mira el estado de la tabla y
// no depende de que nadie le avise. Esta llamada directa existe solo para que
// el operador no espere hasta un minuto por trabajo que dura segundos (crear
// las tandas al subir, indexar un markdown pegado a mano, confirmar una
// revisión).
//
// Por eso es FAIL-OPEN: si la llamada se cae, no se rompe nada, el cron lo
// recoge en el siguiente minuto. Nunca debe propagar un error al operador ni,
// mucho menos, dejar el job sin encolar.
//
// El timeout es corto a propósito: estas invocaciones van acotadas a UN job
// (`job_id`) justamente para que quepan de sobra en los 26s de Netlify.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const TIMEOUT_MS = 20_000;

export async function pokeWorker(
  slug: "kb-transcribe" | "kb-assemble",
  jobId: string
): Promise<void> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    await fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ job_id: jobId }),
      signal: ac.signal,
    });
    clearTimeout(t);
  } catch (err) {
    console.warn(`pokeWorker(${slug}) falló, lo recoge el cron:`, err instanceof Error ? err.message : String(err));
  }
}
