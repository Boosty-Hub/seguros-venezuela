"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui";

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

  const missingTitle = !title.trim();
  const missingSource = !file && !content.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (missingTitle) return setError("Falta el título — escríbelo antes de indexar.");
    if (missingSource) return setError("Falta el archivo o el contenido — sube un archivo o pega texto antes de indexar.");

    setBusy(true);
    const form = new FormData();
    form.set("title", title);
    form.set("vertical_id", verticalId);
    if (file) form.set("file", file);
    if (content.trim()) form.set("content", content);

    const res = await fetch("/api/kb/ingest", { method: "POST", body: form });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "error");
      return;
    }
    setTitle("");
    setContent("");
    setFile(null);
    const f = document.getElementById(`kb-file-${verticalId}`) as HTMLInputElement | null;
    if (f) f.value = "";
    router.refresh();
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
        clasificada en esta vertical. Acepta PDF, DOCX, TXT, MD, SRT, VTT.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
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
              accept=".pdf,.docx,.txt,.md,.srt,.vtt"
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
          type="submit"
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
          {busy ? "Procesando…" : "Indexar en esta vertical"}
        </button>
      </form>

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
