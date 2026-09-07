"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Button, Badge, Wrench, Check, Alert, X, Spinner } from "@/components/ui";

// Revisión manual de alias de corredor.
//
// Cierra los dos huecos que el auto-mapeo no puede: los ambiguos (dos
// intermediarios empatados en parecido, no elige a ciegas) y los que no se
// parecen a ninguno. Lo que se decide acá queda con `origen = 'manual'` o
// `'rechazado'`, y el auto-mapeo de la siguiente carga no lo pisa.
//
// La lista de pendientes va ordenada por VOLUMEN de cotizaciones, no
// alfabéticamente: mapear el que trae 213 cotizaciones cambia los porcentajes,
// mapear el que trae 1 no. Así la revisión empieza por donde importa.

type Candidato = { cod: string; nombre: string; score: number };

type Pendiente = {
  asesor_norm: string;
  asesor_muestra: string | null;
  cotizaciones: number;
  clientes: number;
  ultima: string | null;
  rechazado: boolean | null;
  candidatos: Candidato[];
};

type Asignado = {
  asesor_norm: string;
  cod_intermediario: string;
  nombre_canonico: string;
  origen: string;
  similitud: number | null;
  cotizaciones: number;
};

type Intermediario = { cod: string; nombre: string };

const PAGINA = 25;
const fmtN = new Intl.NumberFormat("es-VE").format;

/** El score es orientativo: por encima de 0,6 es lo que el automático habría aceptado. */
function tonoScore(s: number): "green" | "amber" | "neutral" {
  if (s >= 0.6) return "green";
  if (s >= 0.3) return "amber";
  return "neutral";
}

export function RevisarAlias({ sinMapear, totalCorredores }: { sinMapear: number; totalCorredores: number }) {
  const [abierto, setAbierto] = useState(false);
  const [vista, setVista] = useState<"pendientes" | "asignados">("pendientes");
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [asignados, setAsignados] = useState<Asignado[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busqueda, setBusqueda] = useState("");
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null);
  const [hechos, setHechos] = useState<Record<string, string>>({});
  const [cambios, setCambios] = useState(0);
  // Buscador de intermediario para asignar uno que no salga sugerido.
  const [buscandoPara, setBuscandoPara] = useState<string | null>(null);
  const [qInterm, setQInterm] = useState("");
  const [intermediarios, setIntermediarios] = useState<Intermediario[]>([]);
  const router = useRouter();

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const p = new URLSearchParams({ vista, limite: String(PAGINA), offset: String(offset) });
      if (busqueda.trim()) p.set("q", busqueda.trim());
      const res = await fetch(`/api/pipeline/alias?${p}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Error ${res.status}`);
        return;
      }
      setTotal(json.total ?? 0);
      if (vista === "pendientes") setPendientes((json.filas ?? []) as Pendiente[]);
      else setAsignados((json.filas ?? []) as Asignado[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCargando(false);
    }
  }, [vista, offset, busqueda]);

  useEffect(() => {
    if (abierto) void cargar();
  }, [abierto, cargar]);

  async function actuar(asesor_norm: string, accion: "fijar" | "rechazar" | "borrar", cod?: string) {
    setGuardando(asesor_norm);
    setError(null);
    try {
      const res = await fetch("/api/pipeline/alias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion, asesor_norm, cod_intermediario: cod }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Error ${res.status}`);
        return;
      }
      setCambios((n) => n + 1);
      setHechos((h) => ({
        ...h,
        [asesor_norm]:
          accion === "fijar" ? `ligado a ${json.nombre}` : accion === "rechazar" ? "descartado" : "alias eliminado",
      }));
      setBuscandoPara(null);
      // En la vista de asignados, borrar saca la fila: se recarga para no
      // dejarla en pantalla con un estado que ya no existe.
      if (vista === "asignados") void cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(null);
    }
  }

  async function buscarIntermediarios(q: string) {
    setQInterm(q);
    if (q.trim().length < 2) {
      setIntermediarios([]);
      return;
    }
    const res = await fetch(`/api/pipeline/alias?vista=intermediarios&limite=15&q=${encodeURIComponent(q.trim())}`);
    const json = await res.json();
    if (res.ok) setIntermediarios((json.intermediarios ?? []) as Intermediario[]);
  }

  function cerrar() {
    setAbierto(false);
    setHechos({});
    setBuscandoPara(null);
    setOffset(0);
    setBusqueda("");
    // Cada alias cambia a quién se le acreditan las pólizas, así que la
    // efectividad de detrás quedó vieja.
    if (cambios > 0) {
      setCambios(0);
      router.refresh();
    }
  }

  const paginas = Math.max(1, Math.ceil(total / PAGINA));
  const paginaActual = Math.floor(offset / PAGINA) + 1;

  return (
    <>
      <Button variant="secondary" size="sm" leftIcon={<Wrench size={14} />} onClick={() => setAbierto(true)}>
        Revisar corredores{sinMapear > 0 ? ` (${fmtN(sinMapear)})` : ""}
      </Button>

      <Modal
        open={abierto}
        onClose={cerrar}
        size="xl"
        title="Revisar corredores"
        subtitle={`${fmtN(sinMapear)} de ${fmtN(totalCorredores)} nombres de Zoho sin código del sistema central`}
        footer={
          <Button variant="primary" onClick={cerrar}>
            {cambios > 0 ? `Listo (${cambios} cambio${cambios === 1 ? "" : "s"})` : "Cerrar"}
          </Button>
        }
      >
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-neutral-500">
            El campo <span className="font-mono">Asesor</span> de Zoho es texto libre, así que un mismo corredor
            aparece escrito de varias formas. Ligar cada forma a su código del sistema central es lo que permite
            acreditarle sus pólizas. Lo que decidas acá queda marcado como manual y el mapeo automático de la próxima
            carga <strong>no lo pisa</strong>.
          </p>

          {/* Pestañas */}
          <div className="flex gap-1 border-b border-neutral-200">
            {(
              [
                ["pendientes", "Sin ligar"],
                ["asignados", "Ya ligados"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  setVista(v);
                  setOffset(0);
                  setHechos({});
                }}
                className={
                  "-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors " +
                  (vista === v
                    ? "border-brand text-neutral-900"
                    : "border-transparent text-neutral-500 hover:text-neutral-800")
                }
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={busqueda}
              onChange={(e) => {
                setBusqueda(e.target.value);
                setOffset(0);
              }}
              placeholder="Buscar nombre…"
              className="w-full max-w-xs rounded-lg border border-neutral-300 px-3 py-1.5 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
            />
            <span className="text-xs text-neutral-400">
              {cargando ? "cargando…" : `${fmtN(total)} en total`}
            </span>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
              <Alert size={15} className="mt-0.5 shrink-0 text-red-600" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {cargando && !pendientes.length && !asignados.length && (
            <div className="flex justify-center py-8">
              <Spinner size={20} />
            </div>
          )}

          {/* ── Sin ligar ────────────────────────────────────────────────── */}
          {vista === "pendientes" && (
            <div className="space-y-2">
              {!cargando && pendientes.length === 0 && (
                <p className="py-6 text-center text-sm text-neutral-500">
                  No queda ningún nombre sin ligar{busqueda ? " con esa búsqueda" : ""}.
                </p>
              )}
              {pendientes.map((p) => {
                const hecho = hechos[p.asesor_norm];
                return (
                  <div
                    key={p.asesor_norm}
                    className={
                      "rounded-lg border px-3 py-2.5 " +
                      (hecho ? "border-emerald-200 bg-emerald-50/60" : "border-neutral-200 bg-white")
                    }
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <span className="text-sm font-medium text-neutral-900">{p.asesor_norm}</span>
                        {p.rechazado && (
                          <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                            descartado antes
                          </span>
                        )}
                        <span className="ml-2 text-[11px] text-neutral-400">
                          {fmtN(p.cotizaciones)} cotizaciones · {fmtN(p.clientes)} clientes
                        </span>
                      </div>
                      {hecho ? (
                        <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
                          <Check size={13} /> {hecho}
                        </span>
                      ) : (
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => setBuscandoPara(buscandoPara === p.asesor_norm ? null : p.asesor_norm)}
                            className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50"
                          >
                            Buscar otro…
                          </button>
                          <button
                            type="button"
                            disabled={guardando === p.asesor_norm || !p.candidatos.length}
                            onClick={() => actuar(p.asesor_norm, "rechazar")}
                            title="Marcar que ninguno de estos es el corredor. No se vuelve a proponer."
                            className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-50 disabled:opacity-40"
                          >
                            <X size={11} className="inline" /> Ninguno
                          </button>
                        </div>
                      )}
                    </div>

                    {!hecho && (
                      <>
                        {p.candidatos.length === 0 ? (
                          <p className="mt-1.5 text-[11px] text-neutral-400">
                            Sin ningún parecido en el registro. Este corredor no aparece en los meses de emisión
                            cargados, o el nombre de Zoho no es un corredor real.
                          </p>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {p.candidatos.map((c) => (
                              <button
                                key={c.cod}
                                type="button"
                                disabled={guardando === p.asesor_norm}
                                onClick={() => actuar(p.asesor_norm, "fijar", c.cod)}
                                className="group flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 py-1 text-[11px] transition-colors hover:border-brand hover:bg-brand/5 disabled:opacity-50"
                                title={`Ligar "${p.asesor_norm}" a ${c.nombre} (código ${c.cod})`}
                              >
                                <span className="text-neutral-700 group-hover:text-neutral-900">{c.nombre}</span>
                                <Badge color={tonoScore(c.score)} size="sm">
                                  {(c.score * 100).toFixed(0)}%
                                </Badge>
                              </button>
                            ))}
                          </div>
                        )}

                        {buscandoPara === p.asesor_norm && (
                          <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2">
                            <input
                              autoFocus
                              value={qInterm}
                              onChange={(e) => void buscarIntermediarios(e.target.value)}
                              placeholder="Nombre del corredor en el sistema central…"
                              className="w-full rounded-md border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-900 focus:outline-none"
                            />
                            <div className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
                              {intermediarios.map((i) => (
                                <button
                                  key={i.cod}
                                  type="button"
                                  onClick={() => actuar(p.asesor_norm, "fijar", i.cod)}
                                  className="block w-full rounded px-2 py-1 text-left text-[11px] text-neutral-700 hover:bg-white"
                                >
                                  {i.nombre} <span className="text-neutral-400">· {i.cod}</span>
                                </button>
                              ))}
                              {qInterm.trim().length >= 2 && intermediarios.length === 0 && (
                                <p className="px-2 py-1 text-[11px] text-neutral-400">Sin resultados.</p>
                              )}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Ya ligados ───────────────────────────────────────────────── */}
          {vista === "asignados" && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-neutral-500">
                Conviene mirar los <strong>automáticos</strong>: un mapeo equivocado es peor que ninguno, porque le
                acredita a un corredor las pólizas de otro. &quot;Desligar&quot; lo devuelve a la lista de sin ligar.
              </p>
              {!cargando && asignados.length === 0 && (
                <p className="py-6 text-center text-sm text-neutral-500">Todavía no hay alias ligados.</p>
              )}
              {asignados.map((a) => (
                <div
                  key={a.asesor_norm}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2"
                >
                  <div className="min-w-0">
                    <span className="text-sm text-neutral-900">{a.asesor_norm}</span>
                    <span className="mx-1.5 text-neutral-300">→</span>
                    <span className="text-sm font-medium text-neutral-700">{a.nombre_canonico}</span>
                    <span className="ml-2 text-[11px] text-neutral-400">
                      {fmtN(a.cotizaciones)} cotizaciones
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge color={a.origen === "manual" ? "blue" : "neutral"} size="sm">
                      {a.origen}
                      {a.similitud !== null && ` ${(Number(a.similitud) * 100).toFixed(0)}%`}
                    </Badge>
                    <button
                      type="button"
                      disabled={guardando === a.asesor_norm}
                      onClick={() => actuar(a.asesor_norm, "borrar")}
                      className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-50 disabled:opacity-40"
                    >
                      Desligar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {paginas > 1 && (
            <div className="flex items-center justify-between border-t border-neutral-100 pt-2 text-xs">
              <span className="text-neutral-500">
                Página {paginaActual} de {paginas}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setOffset(Math.max(0, offset - PAGINA))}
                  disabled={offset === 0}
                  className="rounded-md border border-neutral-200 px-2 py-1 disabled:opacity-40"
                >
                  Anterior
                </button>
                <button
                  type="button"
                  onClick={() => setOffset(offset + PAGINA)}
                  disabled={paginaActual >= paginas}
                  className="rounded-md border border-neutral-200 px-2 py-1 disabled:opacity-40"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
