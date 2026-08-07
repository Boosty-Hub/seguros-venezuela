-- ============================================================================
-- Seguros Venezuela · Pipeline de Ventas (Zoho Desk -> Supabase)
-- Esquema de base de datos
-- ============================================================================
-- Ejecutar en el proyecto Supabase "seguros venezuela Project".
-- Los tickets contienen datos personales (PII): el acceso queda restringido
-- a usuarios autenticados mediante RLS. La clave anónima NO puede leer filas.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tabla principal de tickets
-- ---------------------------------------------------------------------------
create table if not exists public.tickets (
  id                       text primary key,          -- Zoho ticket id
  ticket_number            text,
  subject                  text,
  status                   text,                       -- etapa del pipeline
  status_type              text,                       -- Open / Closed
  channel                  text,                       -- Bot / Web / EMAIL ...
  priority                 text,
  category                 text,
  sub_category             text,
  department_id            text,

  -- Contacto
  contact_id               text,
  contact_name             text,
  email                    text,
  phone                    text,

  -- Agente / equipo
  assignee_id              text,
  assignee_name            text,
  team_id                  text,

  -- Campos de negocio (seguros) extraidos de customFields
  ramo                     text,          -- ramo / linea de negocio
  plan_hcm                 text,          -- plan contratado (HCM)
  asesor                   text,          -- asesor / intermediario
  titular                  text,          -- titular de la poliza
  tipo_documento           text,          -- V / E / J ...
  edad                     int,
  monto_prima              numeric,       -- Monto Prima - Anual (parseado)
  moneda                   text,

  -- Fechas
  created_time             timestamptz,
  modified_time            timestamptz,
  closed_time              timestamptz,
  due_date                 timestamptz,
  customer_response_time   timestamptz,

  -- Contadores / banderas
  thread_count             int,
  comment_count            int,
  is_spam                  boolean default false,
  is_overdue               boolean default false,
  web_url                  text,

  -- Datos crudos completos
  custom_fields            jsonb,
  raw                      jsonb,

  synced_at                timestamptz default now()
);

comment on table public.tickets is 'Tickets de Zoho Desk (Administracion de Polizas) sincronizados para el pipeline de ventas.';

-- Indices para las consultas del dashboard
create index if not exists idx_tickets_status         on public.tickets (status);
create index if not exists idx_tickets_created_time    on public.tickets (created_time desc);
create index if not exists idx_tickets_modified_time   on public.tickets (modified_time desc);
create index if not exists idx_tickets_channel         on public.tickets (channel);
create index if not exists idx_tickets_assignee        on public.tickets (assignee_name);
create index if not exists idx_tickets_status_type     on public.tickets (status_type);

-- ---------------------------------------------------------------------------
-- Estado de sincronizacion (watermark incremental)
-- ---------------------------------------------------------------------------
create table if not exists public.sync_state (
  id                       int primary key default 1,
  last_full_sync           timestamptz,
  last_incremental_sync    timestamptz,
  last_modified_time       timestamptz,   -- watermark: max(modified_time) sincronizado
  total_tickets            int,
  last_run_inserted        int,
  last_run_updated         int,
  last_error               text,
  updated_at               timestamptz default now(),
  constraint single_row check (id = 1)
);

insert into public.sync_state (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Orden canonico de las etapas del pipeline (funnel)
-- ---------------------------------------------------------------------------
create table if not exists public.pipeline_stages (
  status        text primary key,
  stage_order   int not null,
  stage_group   text not null,   -- 'abierto' | 'ganado' | 'perdido'
  color         text
);

insert into public.pipeline_stages (status, stage_order, stage_group, color) values
  ('Cotización enviada',      1, 'abierto', '#3b82f6'),
  ('Pendiente por recaudos',  2, 'abierto', '#f59e0b'),
  ('Respuesta Recaudos',      3, 'abierto', '#8b5cf6'),
  ('En proceso',              4, 'abierto', '#06b6d4'),
  ('Emitida',                 5, 'ganado',  '#22c55e'),
  ('Cerrado',                 6, 'ganado',  '#16a34a'),
  ('Anulada',                 7, 'perdido', '#ef4444'),
  ('Rechazada',               8, 'perdido', '#dc2626')
on conflict (status) do nothing;

-- ---------------------------------------------------------------------------
-- Vistas agregadas para el dashboard
-- ---------------------------------------------------------------------------

-- Embudo por etapa (respeta el orden canonico; etapas desconocidas al final)
create or replace view public.v_funnel as
select
  t.status,
  coalesce(ps.stage_order, 999)              as stage_order,
  coalesce(ps.stage_group, 'abierto')        as stage_group,
  coalesce(ps.color, '#94a3b8')              as color,
  count(*)                                   as tickets,
  coalesce(sum(t.monto_prima), 0)            as total_prima,
  coalesce(avg(t.monto_prima), 0)            as avg_prima,
  min(t.created_time)                        as first_seen,
  max(t.created_time)                        as last_seen
from public.tickets t
left join public.pipeline_stages ps on ps.status = t.status
where coalesce(t.is_spam, false) = false
group by t.status, ps.stage_order, ps.stage_group, ps.color;

-- KPIs globales
create or replace view public.v_kpis as
select
  count(*)                                                     as total_tickets,
  count(*) filter (where status_type = 'Open')                as abiertos,
  count(*) filter (where status_type = 'Closed')              as cerrados,
  count(*) filter (where ps.stage_group = 'ganado')           as ganados,
  count(*) filter (where ps.stage_group = 'perdido')          as perdidos,
  coalesce(sum(t.monto_prima), 0)                             as prima_total,
  coalesce(sum(t.monto_prima) filter (where ps.stage_group = 'ganado'), 0) as prima_ganada,
  coalesce(sum(t.monto_prima) filter (where ps.stage_group = 'abierto'), 0) as prima_en_pipeline,
  count(*) filter (where t.created_time >= now() - interval '7 days')  as nuevos_7d,
  count(*) filter (where t.created_time >= now() - interval '30 days') as nuevos_30d
from public.tickets t
left join public.pipeline_stages ps on ps.status = t.status
where coalesce(t.is_spam, false) = false;

-- Tendencia diaria (ultimos 90 dias)
create or replace view public.v_daily_trend as
select
  date_trunc('day', created_time)::date as dia,
  count(*)                              as tickets,
  coalesce(sum(monto_prima), 0)         as prima
from public.tickets
where coalesce(is_spam, false) = false
  and created_time >= now() - interval '90 days'
group by 1
order by 1;

-- Desglose por canal
create or replace view public.v_channel as
select channel, count(*) as tickets, coalesce(sum(monto_prima),0) as prima
from public.tickets
where coalesce(is_spam, false) = false
group by channel
order by tickets desc;

-- Desglose por agente
create or replace view public.v_agent as
select
  coalesce(assignee_name, 'Sin asignar') as agente,
  count(*)                               as tickets,
  count(*) filter (where status_type = 'Open')   as abiertos,
  count(*) filter (where status_type = 'Closed') as cerrados,
  coalesce(sum(monto_prima),0)           as prima
from public.tickets
where coalesce(is_spam, false) = false
group by 1
order by tickets desc;

-- ---------------------------------------------------------------------------
-- Seguridad: RLS (los tickets contienen PII -> solo usuarios autenticados)
-- ---------------------------------------------------------------------------
alter table public.tickets        enable row level security;
alter table public.sync_state     enable row level security;
alter table public.pipeline_stages enable row level security;

-- Lectura solo para usuarios autenticados
drop policy if exists "auth read tickets" on public.tickets;
create policy "auth read tickets" on public.tickets
  for select to authenticated using (true);

drop policy if exists "auth read sync_state" on public.sync_state;
create policy "auth read sync_state" on public.sync_state
  for select to authenticated using (true);

drop policy if exists "auth read stages" on public.pipeline_stages;
create policy "auth read stages" on public.pipeline_stages
  for select to authenticated using (true);

-- Las escrituras las hace el proceso de sync con la service_role key,
-- que ignora RLS. La clave anon/authenticated NO puede escribir.

-- Permisos sobre las vistas agregadas (solo authenticated)
revoke all on public.v_funnel, public.v_kpis, public.v_daily_trend,
              public.v_channel, public.v_agent from anon;
grant select on public.v_funnel, public.v_kpis, public.v_daily_trend,
                public.v_channel, public.v_agent to authenticated;

-- Realtime: publicar cambios de la tabla tickets
alter publication supabase_realtime add table public.tickets;
