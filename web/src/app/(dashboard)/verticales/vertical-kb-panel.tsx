"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB — igual al límite del bucket kb-uploads

type KBDocument = {
  id: string;
  title: string;
  sourceType: string;
  totalChunks: number;
  createdAt: string;
};

// Sube y lista los documentos de KB (RAG) de UNA vertical puntual. No hay
// selector de vertical acá a propósito: todo documento subido desde este
// panel queda atado a `verticalId` — ya no existe el concepto de "documento
// general" (el agente siempre responde dentro de una vertical, así que un
// documento sin vertical no tenía a quién servirle).
export function VerticalKbPanel({ verticalId, docs }: { verticalId: string; docs: KBDocument[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Revisión pendiente: el validador encontró observaciones y devolvió el
  // texto para que un humano lo apruebe (o lo corrija) antes de indexarlo.
  const [revision, setRevision] = useState<
    { text: string; issues: string[]; format: string; filename: string; viaVision: boolean } | null
  >(null);
  // Qué está pasando ahora mismo: la ingesta va en varios pasos y algunos
  // tardan ~20s, así que el usuario necesita ver que avanza.
  const [etapa, setEtapa] = useState<string | null>(null);

  const missingTitle = !title.trim();
  const missingSource = !file && !content.trim();

  function limpiarFormulario() {
    setTitle("");
    setContent("");
    setFile(null);
    setRevision(null);
    const f = document.getElementById(`kb-file-${verticalId}`) as HTMLInputElement | null;
    if (f) f.value = "";
  }

  // POST a un paso de la ingesta. Una respuesta no-JSON (timeout de la
  // plataforma, 5xx sin cuerpo) no debe dejar el botón colgado ni fallar en
  // silencio: se convierte en un error explícito.
  async function paso(url: string, payload: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
        `el archivo pesa ${(file.size / (1024 * 1024)).toFixed(1)}MB — el máximo soportado es 50MB.`
      );
    }

    setBusy(true);
    try {
      // --- Texto pegado a mano: un solo paso, no hay nada que extraer ---
      if (!file) {
        setEtapa("Validando…");
        const j = await paso("/api/kb/ingest", { title, vertical_id: verticalId, content });
        finalizar(j);
        return;
      }

      // --- Archivo: subida + extracción + verificación + indexado ---
      // El trabajo va en pasos separados porque las funciones de Netlify
      // cortan a los 26s y todo junto no entra.
      setEtapa("Subiendo archivo…");
      const supabase = createSupabaseBrowserClient();
      // Supabase Storage rechaza keys con tildes/espacios/paréntesis
      // ("Invalid key" 400, confirmado en vivo con un nombre real de archivo).
      // Se sanea SOLO la key del objeto — el nombre original va aparte en
      // `filename` para mostrar y detectar la extensión.
      const safeName = file.name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const path = `${verticalId}/${crypto.randomUUID()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from("kb-uploads").upload(path, file);
      if (upErr) throw new Error(`no se pudo subir el archivo: ${upErr.message}`);

      setEtapa("Leyendo el documento…");
      let prep = await paso("/api/kb/prepare", { storage_path: path, filename: file.name });
      let texto = String(prep.text ?? "");
      const issues: string[] = [];

      // Verificación de fidelidad, solo si el texto lo produjo un modelo.
      if (prep.needsFidelity) {
        setEtapa("Verificando que coincida con el original…");
        const v1 = await paso("/api/kb/verify", { storage_path: path, filename: file.name, text: texto });
        if (v1.veredicto !== "ok") {
          // Reproceso: se vuelve a leer el documento desde cero con el modelo
          // capaz. La transcripción no es determinista, así que el segundo
          // intento suele salir limpio.
          setEtapa("La lectura no pasó el control — reprocesando…");
          const prep2 = await paso("/api/kb/prepare", {
            storage_path: path,
            filename: file.name,
            capable: true,
          });
          const texto2 = String(prep2.text ?? "");
          setEtapa("Verificando el reproceso…");
          const v2 = await paso("/api/kb/verify", { storage_path: path, filename: file.name, text: texto2 });
          texto = texto2;
          prep = prep2;
          if (v2.veredicto !== "ok") {
            issues.push(...(Array.isArray(v2.problemas) ? v2.problemas.map(String) : []));
          }
        }
      }

      setEtapa("Validando la vertical e indexando…");
      const j = await paso("/api/kb/ingest", {
        title,
        vertical_id: verticalId,
        content: texto,
        storage_path: path,
        filename: String(prep.filename ?? file.name),
        format: String(prep.format ?? "md"),
        via_vision: prep.viaVision === true,
        issues,
      });
      finalizar(j);
    } catch (err) {
      setBusy(false);
      setEtapa(null);
      setError(err instanceof Error ? err.message : "error de red al subir el documento");
    }
  }

  function finalizar(json: Record<string, unknown>) {
    setBusy(false);
    setEtapa(null);
    // El validador tiene observaciones: nada se indexó todavía. Se muestra el
    // texto para revisar/corregir y recién al confirmar entra.
    if (json.needsConfirmation) {
      setRevision({
        text: String(json.text ?? ""),
        issues: Array.isArray(json.issues) ? json.issues.map(String) : [],
        format: String(json.format ?? "md"),
        filename: String(json.filename ?? ""),
        viaVision: json.viaVision === true,
      });
      return;
    }
    limpiarFormulario();
    router.refresh();
  }

  // Segunda vuelta: el humano revisó (y quizá corrigió) el texto y lo aprueba.
  // Va por el camino de `content` con `confirmed`, saltando el gate del juez.
  async function handleConfirmar() {
    if (!revision) return;
    setError(null);
    setBusy(true);
    setEtapa("Indexando…");
    try {
      const json = await paso("/api/kb/ingest", {
        title,
        vertical_id: verticalId,
        content: revision.text,
        confirmed: true,
        format: revision.format,
        filename: revision.filename,
        via_vision: revision.viaVision,
      });
      finalizar(json);
    } catch (err) {
      setBusy(false);
      setEtapa(null);
      setError(err instanceof Error ? err.message : "error de red al confirmar el documento");
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    const res = await fetch(`/api/kb/document/${id}`, { method: "DELETE" });
    setDeletingId(null);
    setConfirmId(null);
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        Documentos que el agente consulta (búsqueda semántica, on-demand) SOLO cuando la conversación está
        clasificada en esta vertical. Acepta PDF, DOCX, TXT, MD, SRT, VTT (hasta 50MB) e imágenes
        PNG/JPG (hasta 5MB). Los flyers y folletos sin texto seleccionable se leen automáticamente
        con IA.
      </p>

      {/*
        DIV, no <form>: este panel vive dentro del <form> de VerticalForm (guardar
        nombre/prompt de la vertical) — un <form> anidado es HTML inválido y el
        navegador lo "arregla" reasignando el submit al form de AFUERA, lo que
        guardaba la vertical Y CERRABA EL MODAL en vez de indexar el documento
        (confirmado: warning de React "form cannot be a descendant of form").
      */}
      <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // Enter en un <input> de texto dispara el submit del form
              // ancestro más cercano — acá ese es el de VerticalForm.
              if (e.key === "Enter") e.preventDefault();
            }}
            placeholder='Título — ej: "Tarifario Salud Individual 2026"'
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
        {/* Revisión pendiente: el validador tiene observaciones y NADA se
            indexó todavía. Se muestra el texto extraído (editable) para que
            el humano lo apruebe o lo corrija. */}
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
              Este es el texto que se va a indexar ({revision.text.length} caracteres). Puedes
              corregirlo aquí mismo antes de aprobarlo.
            </p>
            <textarea
              rows={12}
              value={revision.text}
              onChange={(e) => setRevision({ ...revision, text: e.target.value })}
              className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleConfirmar}
                disabled={busy || !revision.text.trim()}
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
                Descartar
              </button>
            </div>
          </div>
        )}

        {!revision && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || missingTitle || missingSource}
            title={
              missingTitle
                ? "Falta el título"
                : missingSource
                ? "Falta el archivo o el contenido"
                : undefined
            }
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? etapa ?? "Procesando…" : "Indexar en esta vertical"}
          </button>
        )}
        {busy && etapa && (
          <p className="text-[11px] text-neutral-500">
            {etapa} Leer y verificar un documento escaneado puede tomar hasta un minuto.
          </p>
        )}
      </div>

      {docs.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          <table className="w-full text-xs">
            <thead className="bg-neutral-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium text-neutral-500">Título</th>
                <th className="px-3 py-2 font-medium text-neutral-500">Chunks</th>
                <th className="px-3 py-2 font-medium text-neutral-500"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-2 text-neutral-900">{d.title}</td>
                  <td className="px-3 py-2 text-neutral-600">{d.totalChunks}</td>
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
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-neutral-400">Sin documentos todavía en esta vertical.</p>
      )}

      <ConfirmDialog
        open={confirmId !== null}
        title="Borrar documento"
        description="Se eliminará junto con sus chunks indexados. Esta acción no se puede deshacer."
        confirmLabel="Borrar"
        tone="danger"
        busy={deletingId !== null}
        onConfirm={() => confirmId && handleDelete(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}
