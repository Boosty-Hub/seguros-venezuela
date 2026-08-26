-- =============================================================
-- 0060_zoho_kommo_cron.sql
-- Automatiza en Supabase (pg_cron + pg_net) lo que hasta ahora corría por
-- GitHub Actions (.github/workflows/sync.yml, cada 5 min) o a mano
-- (sync/sync.mjs, Node local): Zoho Desk -> tickets -> Kommo (B2C/B2B).
--
-- Dos jobs INDEPENDIENTES (se probó encadenar zoho-kommo-push directo desde
-- zoho-sync vía fire-and-forget + EdgeRuntime.waitUntil, pero no quedó
-- registro confiable de que el request llegara a completarse — se descartó
-- en vez de dejar un "encadenado" que aparenta funcionar sin estarlo):
--   zoho-sync-incremental   cada 5 min. Trae tickets nuevos/modificados de
--                           Zoho Desk (zoho-sync, modo incremental).
--   zoho-kommo-push-safety  cada 5 min, desfasado 2 min del anterior. Drena
--                           lo pendiente (idempotente — solo toca tickets
--                           con kommo_lead_id null), sin depender de que el
--                           otro job haya corrido justo antes.
--
-- Reglas de negocio que ya vive en zoho-kommo-push (ver ese archivo):
--   B2C -> VENTAS B2C / "cliente por atender": asesor = No tengo / Sin
--          Asesor / Sin Asesor (KG) / Seguros Venezuela.
--   B2B -> VENTAS B2B / "DATA ZOHO DESK": cualquier otro asesor real.
-- Cortes independientes en sync_state (kommo_since / kommo_b2b_since) — ya
-- configurados manualmente antes de esta migración.
--
-- IDEMPOTENTE: unschedule-then-schedule si el job ya existe.
-- =============================================================

create or replace function trigger_zoho_sync_incremental()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/zoho-sync',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('mode', 'incremental', 'minutes', 10),
    timeout_milliseconds := 60000
  );
end;
$$;

create or replace function trigger_zoho_kommo_push()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/zoho-kommo-push',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'zoho-sync-incremental') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'zoho-sync-incremental';
  end if;
  perform cron.schedule(
    'zoho-sync-incremental',
    '*/5 * * * *',
    $cron$select trigger_zoho_sync_incremental();$cron$
  );

  if exists (select 1 from cron.job where jobname = 'zoho-kommo-push-safety') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'zoho-kommo-push-safety';
  end if;
  perform cron.schedule(
    'zoho-kommo-push-safety',
    '2-59/5 * * * *', -- mismo intervalo de 5 min, desfasado 2 min del de arriba
    $cron$select trigger_zoho_kommo_push();$cron$
  );
end$$;
