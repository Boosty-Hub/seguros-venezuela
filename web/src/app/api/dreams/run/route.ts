import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // El botón manual "Run ahora" siempre corre YA, con la ventana real desde la
  // última corrida (ya no hay distinción daily/weekly ni due-check: eso lo
  // gobierna el cron dinámico de la migración 0055).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const res = await fetch(`${supabaseUrl}/functions/v1/dreams-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: true }),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.ok ? 200 : 500 });
}
