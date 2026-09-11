"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { SaludDoc } from "./vertical-editor";

const MAX_FILE_BYTES = 30 * 1024 * 1024; // igual a MAX_BYTES_ARCHIVO del worker

type KBDocument = {
  id: string;
  title: string;
  sourceType: string;
  totalChunks: number;
  createdAt: string;
};

// Fila de kb_ingest_avance (0080).
type Job = {
  id: string;
  title: string;
  filename: string;
  status: "pendiente" | "transcribiendo" | "ensamblando" | "revision" | "aprobado" | "listo" | "fallido";
  total_pages: number | null;
  document_id: string | null;
  issues: string[] | null;
  last_error: string | null;
  tandas_total: number;
  tandas_listas: number;
  tandas_fallidas: number;
};

const EN_VUELO: Job["status"][] = ["pendiente", "transcribiendo", "ensamblando", "aprobado"];

// Sube y lista los documentos de KB (RAG) de UNA vertical puntual. No hay
// selector de vertical acá a propósito: todo documento subido desde este panel
// queda atado a `verticalId`.
//
// El trabajo pesado NO corre en Netlify: el navegador sube el archivo al
// bucket, encola el job y consulta el avance. Extraer, transcribir, juzgar y
// embeber ocurre en las Edge Functions kb-transcribe / kb-assemble, que tienen
// ~400s de wall clock — un condicionado escaneado de 40 páginas no cabe ni de
// lejos en los 26s de una función síncrona de Netlify (0080).
export function VerticalKbPanel({
  verticalId,
  docs,
  salud = [],
}: {
  verticalId: string;
  docs: KBDocument[];
  salud?: SaludDoc[];
}) {
  const saludPorDoc = new Map(salud.map((d) => [d.document_id, d]));
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  // Revisión abierta: el texto extraído de un job que quedó con reparos.
  const [revision, setRevision] = useState<{ id: string; texto: string; issues: string[] } | null>(null);

  const missingTitle = !title.trim();
  const missingSource = !file && !content.trim();

  // ---- Avance de la cola ----
  // Dos efectos, y tienen que ser dos: uno CARGA y otro decide si vuelve a
  // haber carga. Encadenar los setTimeout dentro de un solo efecto de montaje
  // no sirve, porque la cadena se corta en cuanto no queda nada en vuelo — que
  // es el estado normal al abrir la vertical — y ya no la revive nadie: al
  // subir un archivo la barra se quedaba clavada en "en cola…" hasta recargar
  // la página. Con el contador, encolar cambia `jobs`, el planificador lo ve y
  // la vuelve a arrancar.
  //
  // Y se DETIENE cuando no hay nada en vuelo: un intervalo corriendo con la
  // pestaña abierta y la cola vacía es ruido contra la base cada 5s para nada.
  const [pulso, setPulso] = useState(0);

  const cargarJobs = useCallback(async () => {
    try {
      const res = await fetch(`/api/kb/jobs?vertical_id=${verticalId}`);
      if (!res.ok) return;
      const { jobs: filas } = (await res.json()) as { jobs: Job[] };
      setJobs(filas ?? []);
    } catch {
      /* un fallo de red no rompe la vista: el siguiente pulso reintenta */
    }
  }, [verticalId]);

  useEffect(() => {
    void cargarJobs();
  }, [cargarJobs, pulso]);

  const hayEnVuelo = jobs.some((j) => EN_VUELO.includes(j.status));
  useEffect(() => {
    if (!hayEnVuelo) return;
    const t = setTimeout(() => setPulso((n) => n + 1), 5000);
    return () => clearTimeout(t);
  }, [hayEnVuelo, jobs]);

  // Un job que acaba de indexar tiene que aparecer en la tabla de abajo, que
  // la pinta el servidor. El ref evita refrescar en bucle: `jobs` cambia en
  // cada pulso y un job 'listo' sigue estando en la lista.
  const indexadosVistos = useRef<Set<string>>(new Set());
  useEffect(() => {
    const nuevos = jobs.filter(
      (j) => j.status === "listo" && j.document_id && !indexadosVistos.current.has(j.id)
    );
    if (nuevos.length === 0) return;
    for (const j of nuevos) indexadosVistos.current.add(j.id);
    router.refresh();
  }, [jobs, router]);

  function limpiarFormulario() {
    setTitle("");
    setContent("");
    setFile(null);
    const f = document.getElementById(`kb-file-${verticalId}`) as HTMLInputElement | null;
    if (f) f.value = "";
  }

  async function pedir(url: string, init: RequestInit) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const json = await res.json().catch(() => ({ error: `respuesta inválida del servidor (${res.status})` }));
    if (!res.ok) throw new Error(json.error ?? "error");
    return json;
  }

  async function handleSubmit() {
    setError(null);
    if (missingTitle) return setError("Falta el título — escríbelo antes de indexar.");
    if (missingSource) return setError("Falta el archivo o el contenido — sube un archivo o pega texto antes de indexar.");
    if (file && file.size > MAX_FILE_BYTES) {
      return setError(
        `el archivo pesa ${(file.size / (1024 * 1024)).toFixed(1)}MB y el máximo es ${MAX_FILE_BYTES / (1024 * 1024)}MB — divídelo y súbelo por partes.`
      );
    }

    setBusy(true);
    try {
      let storagePath: string | undefined;
      if (file) {
        // Directo del navegador al bucket: así el archivo no pasa por el
        // límite de payload (~6MB) de una función serverless.
        const supabase = createSupabaseBrowserClient();
        // Supabase Storage rechaza keys con tildes/espacios/paréntesis
        // ("Invalid key" 400, confirmado en vivo con un nombre real). Se sanea
        // SOLO la key; el nombre original viaja aparte en `filename`.
        const safeName = file.name
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/[^a-zA-Z0-9.\-_]/g, "_");
        storagePath = `${verticalId}/${crypto.randomUUID()}-${safeName}`;
        const { error: upErr } = await supabase.storage.from("kb-uploads").upload(storagePath, file);
        if (upErr) throw new Error(`no se pudo subir el archivo: ${upErr.message}`);
      }

      await pedir("/api/kb/jobs", {
        method: "POST",
        body: JSON.stringify({
          title,
          vertical_id: verticalId,
          ...(storagePath ? { storage_path: storagePath, filename: file!.name } : { content }),
        }),
      });

      limpiarFormulario();
      await cargarJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "error de red al encolar el documento");
    } finally {
      setBusy(false);
    }
  }

  async function abrirRevision(jobId: string) {
    setError(null);
    try {
      const { job } = await pedir(`/api/kb/jobs/${jobId}`, { method: "GET" });
      setRevision({
        id: jobId,
        texto: String(job.texto ?? ""),
        issues: Array.isArray(job.issues) ? job.issues.map(String) : [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "no se pudo abrir la revisión");
    }
  }

  async function handleAprobar() {
    if (!revision) return;
    setBusy(true);
    setError(null);
    try {
      await pedir(`/api/kb/jobs/${revision.id}`, {
        method: "PATCH",
        body: JSON.stringify({ texto: revision.texto }),
      });
      setRevision(null);
      await cargarJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "no se pudo aprobar el documento");
    } finally {
      setBusy(false);
    }
  }

  async function descartarJob(jobId: string) {
    setBusy(true);
    try {
      await pedir(`/api/kb/jobs/${jobId}`, { method: "DELETE" });
      if (revision?.id === jobId) setRevision(null);
      await cargarJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "no se pudo descartar");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    const res = await fetch(`/api/kb/document/${id}`, { method: "DELETE" });
    setDeletingId(null);
    setConfirmId(null);
    if (res.ok) router.refresh();
  }

  const enCurso = jobs.filter((j) => j.status !== "listo");

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        Documentos que el agente consulta (búsqueda semántica, on-demand) SOLO cuando la conversación está
        clasificada en esta vertical. Acepta PDF, DOCX, TXT, MD, SRT, VTT e imágenes PNG/JPG (hasta 30MB).
        Los escaneos y los folletos sin texto seleccionable se leen con IA página por página; el proceso
        sigue aunque cierres esta pantalla.
      </p>

      {/*
        DIV, no <form>: este panel vive dentro del <form> de VerticalForm — un
        <form> anidado es HTML inválido y el navegador lo "arregla" reasignando
        el submit al form de AFUERA, lo que guardaba la vertical Y CERRABA EL
        MODAL en vez de indexar el documento.
      */}
      <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // Enter en un <input> dispara el submit del form ancestro más
              // cercano — acá ese es el de VerticalForm.
              if (e.key === "Enter") e.preventDefault();
            }}
            placeholder='Título — ej: "Condicionado Automóvil 2026"'
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
          <label
            htmlFor={`kb-file-${verticalId}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) setFile(f);
            }}
            className={
              "flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed px-3 py-2 text-center text-xs transition-colors " +
              (dragging
                ? "border-neutral-900 bg-white"
                : "border-neutral-300 hover:border-neutral-400 hover:bg-white")
            }
          >
            {file ? (
              <span className="font-medium text-neutral-900">{file.name}</span>
            ) : (
              <span className="text-neutral-500">Arrastra un archivo o haz clic</span>
            )}
            <input
              id={`kb-file-${verticalId}`}
              type="file"
              accept=".pdf,.docx,.txt,.md,.srt,.vtt,.png,.jpg,.jpeg,.webp,.gif"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="sr-only"
            />
          </label>
        </div>
        <textarea
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="… o pega contenido en markdown"
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
            ⚠ {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={busy || missingTitle || missingSource}
          title={missingTitle ? "Falta el título" : missingSource ? "Falta el archivo o el contenido" : undefined}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Encolando…" : "Indexar en esta vertical"}
        </button>
      </div>

      {/* ---- Cargas en curso ---- */}
      {enCurso.length > 0 && (
        <div className="space-y-2">
          {enCurso.map((j) => (
            <JobCard
              key={j.id}
              job={j}
              busy={busy}
              onRevisar={() => abrirRevision(j.id)}
              onDescartar={() => descartarJob(j.id)}
            />
          ))}
        </div>
      )}

      {/* ---- Revisión humana abierta ---- */}
      {revision && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-semibold text-amber-900">
            Revisa antes de indexar — el validador encontró algo que confirmar:
          </p>
          <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-900">
            {revision.issues.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
          <p className="text-[11px] text-amber-800">
            Este es el texto que se va a indexar ({revision.texto.length.toLocaleString("es-VE")} caracteres).
            Puedes corregirlo aquí mismo antes de aprobarlo.
          </p>
          <textarea
            rows={14}
            value={revision.texto}
            onChange={(e) => setRevision({ ...revision, texto: e.target.value })}
            className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleAprobar}
              disabled={busy || !revision.texto.trim()}
              className="inline-flex items-center rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Indexando…" : "Aprobar e indexar"}
            </button>
            <button
              type="button"
              onClick={() => setRevision(null)}
              disabled={busy}
              className="inline-flex items-center rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {docs.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full text-xs">
            <thead className="bg-neutral-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium text-neutral-500">Título</th>
                <th className="px-3 py-2 font-medium text-neutral-500">Chunks</th>
                <th className="px-3 py-2 font-medium text-neutral-500">Estado</th>
                <th className="px-3 py-2 font-medium text-neutral-500">Descargar</th>
                <th className="px-3 py-2 font-medium text-neutral-500"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {docs.map((d) => {
                const sd = saludPorDoc.get(d.id);
                return (
                  <tr key={d.id}>
                    <td className="px-3 py-2 text-neutral-900">{d.title}</td>
                    <td className="px-3 py-2 text-neutral-600">{d.totalChunks}</td>
                    <td className="px-3 py-2">
                      {!sd || sd.veredicto === "ok" ? (
                        <span className="text-neutral-400">—</span>
                      ) : (
                        <span
                          title={`largo medio de palabra ${sd.largo_medio} · ${sd.pegadas_pct}% pegadas · ${sd.marcadores} chunks con marcador`}
                          className={
                            "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 " +
                            (sd.veredicto === "con_ruido"
                              ? "bg-amber-50 text-amber-700 ring-amber-200"
                              : "bg-red-50 text-red-700 ring-red-200")
                          }
                        >
                          {sd.veredicto === "con_ruido" ? "con ruido" : sd.veredicto === "vacio" ? "sin contenido" : "ilegible"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {/* El original es lo que permite reprocesar sin volver a
                          pedirle el archivo al operador (0084). Los documentos
                          anteriores a esa migración no lo tienen. */}
                      {sd?.tiene_original ? (
                        <a
                          href={`/api/kb/document/${d.id}?original=1`}
                          className="font-medium text-neutral-700 hover:underline"
                        >
                          original
                        </a>
                      ) : (
                        <span className="text-neutral-400" title="Se indexó antes de que se guardaran los originales, o su contenido se pegó a mano.">
                          sin original
                        </span>
                      )}
                      <span className="text-neutral-300"> · </span>
                      <a
                        href={`/api/kb/document/${d.id}`}
                        className="text-neutral-500 hover:underline"
                      >
                        texto
                      </a>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setConfirmId(d.id)}
                        className="font-medium text-red-600 hover:underline"
                      >
                        Borrar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-neutral-400">Sin documentos todavía en esta vertical.</p>
      )}

      <ConfirmDialog
        open={confirmId !== null}
        title="Borrar documento"
        description="Se eliminará junto con sus chunks indexados y el archivo original. Esta acción no se puede deshacer."
        confirmLabel="Borrar"
        tone="danger"
        busy={deletingId !== null}
        onConfirm={() => confirmId && handleDelete(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

function JobCard({
  job,
  busy,
  onRevisar,
  onDescartar,
}: {
  job: Job;
  busy: boolean;
  onRevisar: () => void;
  onDescartar: () => void;
}) {
  const fallido = job.status === "fallido";
  const revisable = job.status === "revision";
  const tono = fallido
    ? "border-red-200 bg-red-50"
    : revisable
    ? "border-amber-300 bg-amber-50"
    : "border-neutral-200 bg-white";

  // El troceo tarda un momento, así que un job recién encolado todavía no
  // tiene tandas: mostrar 0/0 se leería como "no avanza".
  const pct =
    job.tandas_total > 0
      ? Math.round(((job.tandas_listas + job.tandas_fallidas) / job.tandas_total) * 100)
      : 0;

  return (
    <div className={`space-y-1.5 rounded-lg border px-3 py-2 text-xs ${tono}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-neutral-900">{job.title}</span>
        <span className="text-[11px] text-neutral-500">{etiqueta(job)}</span>
      </div>

      {!fallido && !revisable && (
        <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200">
          <div
            className="h-full rounded-full bg-neutral-900 transition-[width] duration-500"
            style={{ width: `${Math.max(pct, 4)}%` }}
          />
        </div>
      )}

      {fallido && job.last_error && <p className="text-red-700">{job.last_error}</p>}
      {revisable && (
        <p className="text-amber-900">
          {job.issues?.length ?? 0} {job.issues?.length === 1 ? "observación" : "observaciones"} — nada se
          indexó todavía.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {revisable && (
          <button
            type="button"
            onClick={onRevisar}
            disabled={busy}
            className="rounded-lg bg-neutral-900 px-2.5 py-1 font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            Revisar
          </button>
        )}
        <button
          type="button"
          onClick={onDescartar}
          disabled={busy}
          className="rounded-lg border border-neutral-300 bg-white px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          Descartar
        </button>
      </div>
    </div>
  );
}

function etiqueta(job: Job): string {
  switch (job.status) {
    case "pendiente":
      return "en cola…";
    case "transcribiendo":
      return job.tandas_total > 0
        ? `leyendo ${job.tandas_listas + job.tandas_fallidas}/${job.tandas_total}${
            job.total_pages ? ` · ${job.total_pages} págs.` : ""
          }`
        : "preparando…";
    case "ensamblando":
      return "validando e indexando…";
    case "aprobado":
      return "indexando lo aprobado…";
    case "revision":
      return "necesita tu revisión";
    case "fallido":
      return "no se pudo cargar";
    default:
      return job.status;
  }
}
