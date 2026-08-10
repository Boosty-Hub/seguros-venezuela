-- ============================================================================
-- Bitacora de ejecuciones. Una fila por corrida del sync, con lo que hizo y lo
-- que fallo. Sirve para que cualquiera (o una sesion futura) sepa que paso
-- mientras nadie miraba, sin depender de los logs de GitHub Actions, que
-- caducan a los 90 dias.
-- ============================================================================

create table if not exists public.sync_log (
  id                  bigserial primary key,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  duracion_seg        numeric,
  modo                text,                  -- incremental | full | kommo | meta | ...
  entorno             text,                   -- github-actions | local
  ok                  boolean,

  -- Zoho -> Supabase
  tickets_nuevos      int default 0,
  tickets_refrescados int default 0,

  -- Supabase -> Kommo (Zoho)
  leads_zoho_creados  int default 0,
  zoho_vinculados     int default 0,          -- duplicados que reusaron un lead

  -- Hoja de Drive -> Supabase -> Kommo
  meta_filas_hoja     int default 0,
  leads_meta_creados  int default 0,
  meta_vinculados     int default 0,

  error               text,
  detalle             jsonb
);

comment on table public.sync_log is
  'Bitacora: una fila por corrida del sync. Ver la vista bitacora_reciente.';

create index if not exists idx_sync_log_started on public.sync_log (started_at desc);
create index if not exists idx_sync_log_error   on public.sync_log (started_at desc) where error is not null;

alter table public.sync_log enable row level security;
drop policy if exists "auth read sync_log" on public.sync_log;
create policy "auth read sync_log" on public.sync_log
  for select to authenticated using (true);

-- --- Lectura rapida: que ha pasado ultimamente --------------------------------
create or replace view public.bitacora_reciente as
select
  to_char(started_at at time zone 'America/Caracas', 'DD/MM HH24:MI') as cuando,
  modo,
  entorno,
  case when ok then 'ok' else 'FALLO' end as resultado,
  round(duracion_seg)                     as seg,
  tickets_nuevos                          as zoho_nuevos,
  leads_zoho_creados                      as leads_zoho,
  zoho_vinculados                         as zoho_dup_vinc,
  meta_filas_hoja                         as hoja_filas,
  leads_meta_creados                      as leads_meta,
  meta_vinculados                         as meta_dup_vinc,
  error
from public.sync_log
order by started_at desc;

grant select on public.bitacora_reciente to authenticated;

-- --- Resumen del estado, todo en una consulta ---------------------------------
-- Lo primero que deberia mirar una sesion futura.
create or replace view public.estado_general as
select
  (select count(*) from public.tickets)                                                    as tickets_supabase,
  (select count(distinct kommo_lead_id) from public.tickets where kommo_lead_id is not null) as leads_zoho_en_kommo,
  (select count(*) from public.meta_leads)                                                 as meta_en_supabase,
  (select count(distinct kommo_lead_id) from public.meta_leads where kommo_lead_id is not null) as leads_meta_en_kommo,
  (select count(*) from public.kommo_duplicados)                                           as grupos_duplicados_pendientes,
  (select count(*) from public.tickets where kommo_error like 'duplicado%')                as tickets_marcados_duplicado,
  (select kommo_since from public.sync_state where id = 1)                                 as corte_kommo,
  (select meta_since  from public.sync_state where id = 1)                                 as corte_meta,
  (select max(created_time) from public.tickets)                                            as ultimo_ticket,
  (select max(created_time) from public.meta_leads)                                         as ultimo_lead_meta,
  (select max(started_at) from public.sync_log)                                             as ultima_corrida,
  (select count(*) from public.sync_log where error is not null
     and started_at > now() - interval '24 hours')                                          as fallos_24h;

grant select on public.estado_general to authenticated;
