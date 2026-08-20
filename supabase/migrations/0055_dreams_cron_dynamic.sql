-- =============================================================
-- 0055_dreams_cron_dynamic.sql
-- Reemplaza los crons fijos de Dreams (dreams-daily 3am, dreams-weekly
-- domingo) por UN SOLO cron ('dreams-run') cuya cadencia real es la que el
-- operador elige en /dreams (dropdown DREAMS_FREQUENCY: daily/3d/7d/15d) —
-- ya no hay due-check interno en la función, el propio cron dispara al
-- intervalo correcto. set_dreams_schedule() reprograma ese job; la UI la
-- llama vía RPC cada vez que cambia el dropdown (/api/dreams/frequency).
--
-- Suma un cron de CONSOLIDACIÓN mensual ('dreams-consolidate-monthly'): cada
-- 30 días relee TODOS los dreams activos, deduplica/resuelve contradicciones
-- y reescribe el digest único (runtime_config.DREAMS_DIGEST) que de verdad
-- alimenta al agente — acotado en tamaño (rebuildDigest, DIGEST_MAX_WORDS)
-- para que no crezca sin límite con los meses.
-- =============================================================

-- Limpieza de los crons viejos (fijos, con due-check interno en la función).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dreams-daily') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'dreams-daily';
  end if;
  if exists (select 1 from cron.job where jobname = 'dreams-weekly') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'dreams-weekly';
  end if;
end$$;

-- Expresión cron para cada frecuencia del dropdown. pg_cron no tiene "cada N
-- días desde una fecha ancla": usamos el campo día-del-mes ('*/N') — se
-- resetea en el borde de mes (mejor esfuerzo, documentado), pero dreams-run
-- igual cubre el hueco real desde la última corrida (DREAMS_LAST_RUN), así
-- que ningún día se pierde aunque el intervalo entre disparos no sea exacto.
create or replace function dreams_cron_expr(p_frequency text)
returns text language sql immutable as $$
  select case p_frequency
    when '3d'  then '0 3 */3 * *'
    when '7d'  then '0 3 */7 * *'
    when '15d' then '0 3 */15 * *'
    else            '0 3 * * *'   -- 'daily' y cualquier valor desconocido
  end;
$$;

-- Reprograma el job 'dreams-run' con la cadencia elegida. SECURITY DEFINER
-- porque cron.schedule/unschedule requieren el owner de la extensión
-- (postgres) y esta función la llama el dashboard como 'authenticated'.
create or replace function set_dreams_schedule(p_frequency text)
returns void
language plpgsql
security definer
set search_path = public, cron, pg_catalog
as $$
begin
  if exists (select 1 from cron.job where jobname = 'dreams-run') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'dreams-run';
  end if;
  perform cron.schedule(
    'dreams-run',
    dreams_cron_expr(p_frequency),
    $cron$select trigger_dreams('daily');$cron$
  );
end;
$$;

grant execute on function set_dreams_schedule(text) to authenticated;

-- Trigger de la consolidación mensual: reconstruye SOLO el digest (dedupe +
-- contradicciones sobre todos los dreams activos), sin extraer aprendizajes
-- nuevos — eso lo sigue haciendo 'dreams-run' en su propia cadencia.
create or replace function trigger_dreams_consolidate()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/dreams-run',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('digest_only', true),
    timeout_milliseconds := 120000
  );
end;
$$;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'dreams-consolidate-monthly') then
    perform cron.schedule(
      'dreams-consolidate-monthly',
      '0 4 1,31 * *', -- primer día de cada mes (y el 31 cuando el mes lo tiene, como red por si el 1 se pierde) — mejor esfuerzo de "cada 30 días" con cron estándar
      $cron$select trigger_dreams_consolidate();$cron$
    );
  end if;
end$$;

-- Programa el job 'dreams-run' inicial con la frecuencia ya guardada en
-- runtime_config (o 'daily' si nunca se tocó el dropdown).
select set_dreams_schedule(coalesce((select value from runtime_config where key = 'DREAMS_FREQUENCY'), 'daily'));
