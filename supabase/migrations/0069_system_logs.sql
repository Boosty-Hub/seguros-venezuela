-- =============================================================
-- 0069_system_logs.sql
-- Bitácora propia (permanente, sin depender de la retención corta de los
-- logs de Supabase) para las Edge Functions que ya causaron incidentes
-- reales sin rastro: kommo-webhook (apagones silenciosos de Kommo) y
-- process-inbound (fallas de transcripción de audio ocultas por un mensaje
-- genérico). NO reemplaza el Log Drain oficial de Supabase ($60/mes,
-- solo activable desde el dashboard) — es instrumentación puntual, barata,
-- de los puntos que ya mordieron.
--
-- Retención acotada por cron diario (SYSTEM_LOGS_RETENTION_DAYS,
-- runtime_config, default 30 días) para no crecer sin límite.
-- IDEMPOTENTE.
-- =============================================================

create table if not exists system_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  function_name text not null,
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  message text not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists system_logs_created_idx on system_logs(created_at desc);
create index if not exists system_logs_fn_created_idx on system_logs(function_name, created_at desc);
create index if not exists system_logs_error_idx on system_logs(created_at desc) where level = 'error';

alter table system_logs enable row level security;
drop policy if exists authenticated_read on system_logs;
create policy authenticated_read on system_logs
  for select to authenticated using (true);
-- Solo el service role (Edge Functions) escribe; sin policy de insert para
-- `authenticated` a propósito, mismo criterio que `alerts`.

-- ---- Limpieza diaria ----
create or replace function prune_system_logs()
returns void language plpgsql as $$
declare
  retention_days int;
begin
  select coalesce(nullif(value, '')::int, 30) into retention_days
  from runtime_config where key = 'SYSTEM_LOGS_RETENTION_DAYS';
  if retention_days is null then
    retention_days := 30;
  end if;
  delete from system_logs where created_at < now() - (retention_days || ' days')::interval;
end;
$$;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'system-logs-prune') then
    perform cron.schedule(
      'system-logs-prune',
      '17 4 * * *', -- una vez al día, hora de baja actividad
      $cron$select prune_system_logs();$cron$
    );
  end if;
end$$;

-- ---- Empujar también las alertas del auto-sanado del webhook al canal ----
update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'kommo_webhook_reconnect_failed')
 where not ('kommo_webhook_reconnect_failed' = any(webhook_kinds));

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'kommo_webhook_reconnected')
 where not ('kommo_webhook_reconnected' = any(webhook_kinds));
