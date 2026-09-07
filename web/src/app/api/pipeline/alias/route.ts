import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// Revisión manual de los alias de corredor (PENDIENTE 8).
//
// El auto-mapeo de `zoho_mapear_corredores()` resuelve la mayoría pero deja
// ambiguos (dos candidatos empatados) y sin candidato. Esta ruta permite
// cerrarlos a mano desde /pipeline.
//
// `origen` manda: el auto-mapeo NO toca lo que tiene origen 'manual' ni
// 'rechazado', así que una decisión humana no se pisa en la siguiente carga.

export const runtime = "nodejs";

type Accion =
  | { accion: "fijar"; asesor_norm: string; cod_intermediario: string }
  | { accion: "rechazar"; asesor_norm: string }
  | { accion: "borrar"; asesor_norm: string };

export async function GET(request: Request) {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(request.url);
    const vista = url.searchParams.get("vista") ?? "pendientes";
    const busqueda = url.searchParams.get("q") ?? null;
    const limite = Math.min(100, Math.max(1, Number(url.searchParams.get("limite") ?? 25)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

    const svc = createServiceClient();

    if (vista === "asignados") {
      const soloAuto = url.searchParams.get("solo_auto") === "1";
      const { data, error } = await svc.rpc("zoho_alias_asignados", {
        p_busqueda: busqueda,
        p_solo_auto: soloAuto,
        p_limite: limite,
        p_offset: offset,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ vista, ...(data as object) });
    }

    if (vista === "intermediarios") {
      const { data, error } = await svc.rpc("zoho_intermediarios_buscar", {
        p_busqueda: busqueda,
        p_limite: limite,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ vista, intermediarios: data ?? [] });
    }

    const { data, error } = await svc.rpc("zoho_alias_pendientes", {
      p_busqueda: busqueda,
      p_limite: limite,
      p_offset: offset,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ vista: "pendientes", ...(data as object) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("pipeline/alias GET:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await request.json()) as Partial<Accion>;
    const asesor = typeof body.asesor_norm === "string" ? body.asesor_norm.trim() : "";
    if (!asesor) return NextResponse.json({ error: "falta asesor_norm" }, { status: 400 });

    const svc = createServiceClient();

    if (body.accion === "fijar") {
      const cod = typeof body.cod_intermediario === "string" ? body.cod_intermediario.trim() : "";
      if (!cod) return NextResponse.json({ error: "falta cod_intermediario" }, { status: 400 });
      // Se comprueba que el código exista antes de escribir: la FK lo haría
      // igual, pero el mensaje de Postgres no le dice nada a quien lo lee.
      const { data: existe, error: errBusca } = await svc
        .from("intermediarios")
        .select("cod_intermediario,nombre")
        .eq("cod_intermediario", cod)
        .maybeSingle();
      if (errBusca) return NextResponse.json({ error: errBusca.message }, { status: 500 });
      if (!existe) {
        return NextResponse.json(
          { error: `El código ${cod} no está en el registro de intermediarios.` },
          { status: 400 }
        );
      }
      const { error } = await svc.from("corredor_alias").upsert(
        { asesor_norm: asesor, cod_intermediario: cod, origen: "manual", similitud: null },
        { onConflict: "asesor_norm" }
      );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, asesor_norm: asesor, nombre: existe.nombre });
    }

    if (body.accion === "rechazar") {
      // 'rechazado' necesita un cod por la FK, pero el valor no se usa para
      // nada: la efectividad filtra `origen <> 'rechazado'`. Se guarda el
      // candidato que hubiera ganado, solo para dejar rastro de qué se
      // descartó. Si no hay ninguno, no hay nada que rechazar.
      const { data: cands, error: errCand } = await svc.rpc("zoho_alias_candidatos", {
        p_asesor_norm: asesor,
        p_limite: 1,
      });
      const primero = (cands as { cod: string }[] | null)?.[0];
      if (errCand || !primero) {
        return NextResponse.json(
          { error: "Este nombre no tiene ningún candidato, así que no hay nada que rechazar." },
          { status: 400 }
        );
      }
      const { error } = await svc.from("corredor_alias").upsert(
        { asesor_norm: asesor, cod_intermediario: primero.cod, origen: "rechazado", similitud: null },
        { onConflict: "asesor_norm" }
      );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, asesor_norm: asesor, rechazado: true });
    }

    if (body.accion === "borrar") {
      const { error } = await svc.from("corredor_alias").delete().eq("asesor_norm", asesor);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, asesor_norm: asesor, borrado: true });
    }

    return NextResponse.json({ error: `acción inválida: ${String(body.accion)}` }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("pipeline/alias POST:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
