-- ============================================================================
-- Integracion Kommo CRM: control de que tickets ya se enviaron como leads.
-- Aplicar UNA vez sobre el esquema existente (es idempotente).
-- ============================================================================

-- --- Marca en cada ticket del lead creado en Kommo ---------------------------
alter table public.tickets add column if not exists kommo_lead_id   text;
alter table public.tickets add column if not exists kommo_synced_at timestamptz;
alter table public.tickets add column if not exists kommo_error     text;

comment on column public.tickets.kommo_lead_id is
  'ID del lead creado en Kommo. NULL = todavia no enviado. Garantiza idempotencia.';

-- Indice parcial: la consulta "pendientes por enviar" solo mira estas filas.
create index if not exists idx_tickets_kommo_pending
  on public.tickets (created_time)
  where kommo_lead_id is null;

-- --- Estado de la integracion ------------------------------------------------
-- kommo_since es el CORTE: solo se envian tickets creados a partir de este
-- instante. Evita volcar el historico completo al CRM.
alter table public.sync_state add column if not exists kommo_since       timestamptz;
alter table public.sync_state add column if not exists kommo_last_run    timestamptz;
alter table public.sync_state add column if not exists kommo_last_pushed int;
alter table public.sync_state add column if not exists kommo_total       int default 0;
alter table public.sync_state add column if not exists kommo_last_error  text;

comment on column public.sync_state.kommo_since is
  'Corte de la integracion Kommo: no se envian tickets creados antes de esta fecha.';

-- --- Vista de control para el dashboard / auditoria ---------------------------
create or replace view public.kommo_sync_status as
select
  (select kommo_since       from public.sync_state where id = 1) as corte,
  (select kommo_last_run    from public.sync_state where id = 1) as ultima_corrida,
  (select kommo_last_error  from public.sync_state where id = 1) as ultimo_error,
  count(*) filter (where kommo_lead_id is not null)              as leads_creados,
  count(*) filter (
    where kommo_lead_id is null
      and created_time >= coalesce((select kommo_since from public.sync_state where id = 1), now())
  )                                                             as pendientes,
  count(*) filter (where kommo_error is not null)                as con_error
from public.tickets;

-- RLS: la vista hereda las politicas de tickets/sync_state (solo autenticados).
grant select on public.kommo_sync_status to authenticated;
