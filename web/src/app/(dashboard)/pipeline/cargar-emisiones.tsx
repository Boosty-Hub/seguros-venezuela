"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Button, Badge, Upload, Check, Alert } from "@/components/ui";

// Carga del "Reporte Emisión" del sistema central.
//
// Son dos pasos a propósito: primero se sube el archivo en modo `preview`, que
// lo parsea y dice EXACTAMENTE qué va a pasar (cuántos recibos nuevos, cuáles
// se actualizan, qué corredores aparecen por primera vez, cuántas pólizas van a
// cruzar con una cotización de Zoho) sin escribir nada; solo al confirmar se
// guarda. Sin ese paso, un archivo del mes equivocado o con otro delimitador se
// cargaba y había que limpiar a mano.

type IntermediarioNuevo = { cod: string; nombre: string };

type FilaMuestra = {
  recibo: string;
  nu_poliza: string;
  estatus: string | null;
  nombre_tomador: string | null;
  ci_tomador: string | null;
  nombre_asegurado: string | null;
  nombre_intermediario: string | null;
  prima_recibo: number | null;
  fecha_suscripcion: string | null;
  cruza: boolean;
};

type Preview = {
  archivo: string;
  juego_caracteres: string;
  avisos: string[];
  recibos: number;
  polizas: number;
  vigentes: number;
  anuladas: number;
  otro_estatus: number;
  periodo_desde: string | null;
  periodo_hasta: string | null;
  sin_fecha: number;
  ramos: string[];
  intermediarios_total: number;
  intermediarios_nuevos: IntermediarioNuevo[];
  recibos_nuevos: number;
  recibos_actualizados: number;
  polizas_que_cruzan: number;
  muestra: FilaMuestra[];
};

type Mapeo = { alias_nuevos?: number; ambiguos?: number; sin_candidato?: number; error?: string };

const fmtN = new Intl.NumberFormat("es-VE").format;

const fmtFecha = (s: string | null) =>
  s ? new Date(`${s}T12:00:00Z`).toLocaleDateString("es-VE", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export function CargarEmisiones({ periodoCargado }: { periodoCargado: string | null }) {
  const [abierto, setAbierto] = useState(false);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ocupado, setOcupado] = useState<"preview" | "confirmar" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState<{ mapeo: Mapeo; preview: Preview } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function reiniciar() {
    setArchivo(null);
    setPreview(null);
    setError(null);
    setListo(null);
    setOcupado(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function cerrar() {
    const habiaCargado = listo !== null;
    setAbierto(false);
    reiniciar();
    // Si se cargó algo, la efectividad que se está viendo detrás quedó vieja.
    // refresh() vuelve a pedir el Server Component sin recargar la página
    // entera ni perder el scroll.
    if (habiaCargado) router.refresh();
  }

  async function enviar(modo: "preview" | "confirmar") {
    if (!archivo) return;
    setOcupado(modo);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("archivo", archivo);
      fd.append("modo", modo);
      const res = await fetch("/api/pipeline/emisiones", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Error ${res.status}`);
        return;
      }
      if (modo === "preview") {
        setPreview(json.preview as Preview);
      } else {
        setListo({ mapeo: (json.mapeo ?? {}) as Mapeo, preview: json.preview as Preview });
        setPreview(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcupado(null);
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" leftIcon={<Upload size={14} />} onClick={() => setAbierto(true)}>
        Cargar emisiones
      </Button>

      <Modal
        open={abierto}
        onClose={cerrar}
        size="xl"
        title="Cargar Reporte de Emisión"
        subtitle={periodoCargado ? `cargado hasta ahora: ${periodoCargado}` : "todavía no hay emisiones cargadas"}
        footer={
          listo ? (
            <Button variant="primary" onClick={cerrar}>
              Listo
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={cerrar}>
                Cancelar
              </Button>
              {preview ? (
                <Button
                  variant="primary"
                  busy={ocupado === "confirmar"}
                  disabled={ocupado !== null}
                  onClick={() => enviar("confirmar")}
                  leftIcon={<Check size={14} />}
                >
                  Confirmar y cargar {fmtN(preview.recibos)} recibos
                </Button>
              ) : (
                <Button
                  variant="primary"
                  busy={ocupado === "preview"}
                  disabled={!archivo || ocupado !== null}
                  onClick={() => enviar("preview")}
                >
                  Ver qué se va a cargar
                </Button>
              )}
            </>
          )
        }
      >
        <div className="space-y-4">
          {/* ── Paso 3: cargado ─────────────────────────────────────────── */}
          {listo && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
                <Check size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                <div className="text-sm text-emerald-900">
                  <p className="font-medium">
                    Cargado: {fmtN(listo.preview.polizas)} pólizas ({fmtN(listo.preview.recibos)} recibos).
                  </p>
                  <p className="mt-0.5 text-xs text-emerald-800">
                    {fmtN(listo.preview.recibos_nuevos)} nuevos · {fmtN(listo.preview.recibos_actualizados)} actualizados
                  </p>
                </div>
              </div>
              {listo.mapeo.error ? (
                <p className="text-xs text-amber-700">
                  Las pólizas se guardaron, pero el mapeo automático de corredores falló: {listo.mapeo.error}. Se puede
                  reintentar volviendo a cargar el archivo.
                </p>
              ) : (
                <p className="text-xs text-neutral-500">
                  Mapeo automático de corredores: <strong>{fmtN(listo.mapeo.alias_nuevos ?? 0)}</strong> nombres de Zoho
                  quedaron ligados a su código.
                  {(listo.mapeo.ambiguos ?? 0) > 0 && ` ${listo.mapeo.ambiguos} quedaron ambiguos (dos candidatos con el mismo parecido) y no se mapearon.`}
                  {(listo.mapeo.sin_candidato ?? 0) > 0 && ` ${fmtN(listo.mapeo.sin_candidato ?? 0)} no encontraron equivalente: son corredores que no emitieron en los meses cargados.`}
                </p>
              )}
              <p className="text-xs text-neutral-400">
                Al cerrar, la efectividad de abajo se recalcula sola.
              </p>
            </div>
          )}

          {/* ── Paso 1: elegir archivo ──────────────────────────────────── */}
          {!listo && !preview && (
            <div className="space-y-3">
              <p className="text-sm text-neutral-600">
                Sube el CSV tal como lo entrega el sistema central, sin abrirlo ni volverlo a guardar en Excel (al
                reguardar cambia el separador y las fechas). Se puede subir el mismo mes otra vez: los recibos se
                identifican por su número, así que se actualizan en vez de duplicarse.
              </p>
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-neutral-200 bg-neutral-50 px-6 py-8 text-center transition-colors hover:border-brand hover:bg-brand/5">
                <Upload size={22} className="text-neutral-400" />
                <span className="text-sm font-medium text-neutral-700">
                  {archivo ? archivo.name : "Elegir archivo .CSV"}
                </span>
                <span className="text-xs text-neutral-400">
                  {archivo ? `${(archivo.size / 1024).toFixed(0)} KB` : "Reporte Emisión — un archivo por mes"}
                </span>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,.CSV,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    setArchivo(e.target.files?.[0] ?? null);
                    setError(null);
                  }}
                />
              </label>
            </div>
          )}

          {/* ── Paso 2: preview ─────────────────────────────────────────── */}
          {preview && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Dato label="Pólizas" valor={fmtN(preview.polizas)} pista={`${fmtN(preview.recibos)} recibos`} />
                <Dato label="Vigentes" valor={fmtN(preview.vigentes)} pista={`${fmtN(preview.anuladas)} anuladas`} tono="emerald" />
                <Dato
                  label="Recibos nuevos"
                  valor={fmtN(preview.recibos_nuevos)}
                  pista={preview.recibos_actualizados > 0 ? `${fmtN(preview.recibos_actualizados)} ya cargados` : "ninguno repetido"}
                  tono={preview.recibos_nuevos === 0 ? "amber" : "default"}
                />
                <Dato
                  label="Cruzan con Zoho"
                  valor={fmtN(preview.polizas_que_cruzan)}
                  pista={`de ${fmtN(preview.polizas)} pólizas`}
                  tono="brand"
                />
              </div>

              <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-2.5 text-xs text-neutral-600">
                <p>
                  Periodo del archivo: <strong>{fmtFecha(preview.periodo_desde)}</strong> a{" "}
                  <strong>{fmtFecha(preview.periodo_hasta)}</strong> · {preview.intermediarios_total} intermediarios ·
                  ramo {preview.ramos.join(", ") || "—"} · leído como {preview.juego_caracteres}
                </p>
                {preview.recibos_nuevos === 0 && (
                  <p className="mt-1.5 font-medium text-amber-700">
                    Ningún recibo es nuevo: este archivo ya está cargado. Confirmar solo refresca los datos existentes.
                  </p>
                )}
                {preview.otro_estatus > 0 && (
                  <p className="mt-1.5 text-amber-700">
                    {preview.otro_estatus} póliza(s) con un estatus distinto de Vigente/Anulada: no cuentan como cierre.
                  </p>
                )}
                {preview.sin_fecha > 0 && (
                  <p className="mt-1.5 text-amber-700">
                    {preview.sin_fecha} fila(s) sin fecha de suscripción legible: se guardan, pero quedan fuera del
                    cálculo por periodo.
                  </p>
                )}
                {preview.avisos.map((a) => (
                  <p key={a} className="mt-1.5 text-amber-700">
                    {a}
                  </p>
                ))}
              </div>

              {preview.intermediarios_nuevos.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-neutral-700">
                    Corredores que aparecen por primera vez ({preview.intermediarios_nuevos.length})
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {preview.intermediarios_nuevos.slice(0, 14).map((i) => (
                      <Badge key={i.cod} color="neutral">
                        {i.nombre}
                      </Badge>
                    ))}
                    {preview.intermediarios_nuevos.length > 14 && (
                      <Badge color="neutral">+{preview.intermediarios_nuevos.length - 14} más</Badge>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-neutral-700">Primeras filas del archivo</p>
                <div className="overflow-x-auto rounded-lg border border-neutral-200">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-neutral-50 text-neutral-500">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Póliza</th>
                        <th className="px-2 py-1.5 font-medium">Tomador</th>
                        <th className="px-2 py-1.5 font-medium">Corredor</th>
                        <th className="px-2 py-1.5 font-medium">Suscrita</th>
                        <th className="px-2 py-1.5 text-right font-medium">Prima</th>
                        <th className="px-2 py-1.5 font-medium">Zoho</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {preview.muestra.map((f) => (
                        <tr key={f.recibo}>
                          <td className="px-2 py-1.5 font-mono text-neutral-700">
                            {f.nu_poliza}
                            {f.estatus === "Anulada" && <span className="ml-1 text-red-600">anulada</span>}
                          </td>
                          <td className="max-w-[150px] truncate px-2 py-1.5 text-neutral-600" title={f.nombre_tomador ?? ""}>
                            {f.nombre_tomador ?? "—"}
                          </td>
                          <td className="max-w-[150px] truncate px-2 py-1.5 text-neutral-600" title={f.nombre_intermediario ?? ""}>
                            {f.nombre_intermediario ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-neutral-500">{fmtFecha(f.fecha_suscripcion)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-neutral-600">
                            {f.prima_recibo === null ? "—" : f.prima_recibo.toFixed(2)}
                          </td>
                          <td className="px-2 py-1.5">
                            {f.cruza ? (
                              <span className="text-emerald-600">cotizada</span>
                            ) : (
                              <span className="text-neutral-400">sin cotización</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
              <Alert size={15} className="mt-0.5 shrink-0 text-red-600" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

function Dato({
  label,
  valor,
  pista,
  tono = "default",
}: {
  label: string;
  valor: string;
  pista?: string;
  tono?: "default" | "brand" | "emerald" | "amber";
}) {
  const color =
    tono === "brand"
      ? "text-brand"
      : tono === "emerald"
        ? "text-emerald-600"
        : tono === "amber"
          ? "text-amber-600"
          : "text-neutral-900";
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-neutral-400">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${color}`}>{valor}</p>
      {pista && <p className="text-[10px] text-neutral-400">{pista}</p>}
    </div>
  );
}
