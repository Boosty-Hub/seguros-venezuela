-- ============================================================================
-- Leads de Meta (formularios de Instagram/Facebook) que llegan a la hoja de
-- Google del equipo de marketing. Se replican aqui y de aqui salen a Kommo.
--
-- CONTIENEN DATOS PERSONALES (nombre, fecha de nacimiento, telefono, correo):
-- misma proteccion que public.tickets -> RLS, solo lectura autenticada.
-- ============================================================================

create table if not exists public.meta_leads (
  id                text primary key,     -- id de Meta, p.ej. l:1352596806759555
  created_time      timestamptz,          -- cuando el usuario envio el formulario

  -- Atribucion de la campana
  ad_id             text,
  ad_name           text,
  adset_id          text,
  adset_name        text,
  campaign_id       text,
  campaign_name     text,
  form_id           text,
  form_name         text,
  is_organic        boolean,
  platform          text,                 -- ig | fb

  -- Datos del prospecto
  nombre_completo   text,
  fecha_nacimiento  date,
  telefono          text,                 -- normalizado a +58...
  telefono_raw      text,                 -- tal como vino de la hoja
  correo            text,
  lead_status       text,                 -- estado que reporta Meta

  -- Control de la creacion en Kommo (misma mecanica que tickets)
  kommo_lead_id     text,
  kommo_synced_at   timestamptz,
  kommo_error       text,

  synced_at         timestamptz default now()
);

comment on table public.meta_leads is
  'Leads de formularios de Meta (Instagram/Facebook) replicados desde la hoja de Google de marketing.';

create index if not exists idx_meta_leads_created    on public.meta_leads (created_time desc);
create index if not exists idx_meta_leads_campaign   on public.meta_leads (campaign_name);
create index if not exists idx_meta_leads_ad         on public.meta_leads (ad_name);
create index if not exists idx_meta_leads_correo     on public.meta_leads (lower(correo));
create index if not exists idx_meta_leads_telefono   on public.meta_leads (telefono);
create index if not exists idx_meta_leads_kommo_pend on public.meta_leads (created_time)
  where kommo_lead_id is null;

-- --- RLS: identico criterio que tickets ---------------------------------------
alter table public.meta_leads enable row level security;

drop policy if exists "auth read meta_leads" on public.meta_leads;
create policy "auth read meta_leads" on public.meta_leads
  for select to authenticated using (true);

-- --- Estado de la sincronizacion de la hoja -----------------------------------
alter table public.sync_state add column if not exists meta_since        timestamptz;
alter table public.sync_state add column if not exists meta_last_run     timestamptz;
alter table public.sync_state add column if not exists meta_total        int default 0;
alter table public.sync_state add column if not exists meta_last_error   text;

comment on column public.sync_state.meta_since is
  'Corte para enviar leads de Meta a Kommo: no se envian los creados antes.';

-- --- Vista de control ---------------------------------------------------------
create or replace view public.meta_sync_status as
select
  (select meta_since    from public.sync_state where id = 1) as corte,
  (select meta_last_run from public.sync_state where id = 1) as ultima_corrida,
  count(*)                                                   as leads_en_supabase,
  count(*) filter (where kommo_lead_id is not null)           as leads_en_kommo,
  count(*) filter (
    where kommo_lead_id is null
      and created_time >= coalesce((select meta_since from public.sync_state where id = 1), now())
  )                                                          as pendientes,
  count(*) filter (where kommo_error is not null)             as con_error,
  min(created_time)                                          as primer_lead,
  max(created_time)                                          as ultimo_lead
from public.meta_leads;

grant select on public.meta_sync_status to authenticated;

-- ---------------------------------------------------------------------------
-- Deteccion de solapamiento: leads de Meta que YA estan en Kommo porque la
-- misma persona entro antes por un ticket de Zoho. Compara correo exacto o los
-- ultimos 10 digitos del telefono (los formatos vienen mezclados).
-- ---------------------------------------------------------------------------
create or replace function public.meta_leads_solapados(p_since timestamptz default null)
returns table (
  meta_id        text,
  nombre         text,
  correo         text,
  telefono       text,
  ticket_id      text,
  ticket_number  text,
  kommo_lead_id  text,
  coincide_por   text
)
language sql
stable
as $$
  select distinct
    m.id, m.nombre_completo, m.correo, m.telefono,
    t.id, t.ticket_number, t.kommo_lead_id,
    case
      when m.correo is not null and lower(t.email) = m.correo then 'correo'
      else 'telefono'
    end
  from public.meta_leads m
  join public.tickets t
    on (m.correo is not null and lower(t.email) = m.correo)
    or (
      m.telefono is not null and t.phone is not null
      and length(regexp_replace(m.telefono, '\D', '', 'g')) >= 10
      and length(regexp_replace(t.phone,   '\D', '', 'g')) >= 10
      and right(regexp_replace(m.telefono, '\D', '', 'g'), 10)
        = right(regexp_replace(t.phone,    '\D', '', 'g'), 10)
    )
  where t.kommo_lead_id is not null
    and m.kommo_lead_id is null
    and (p_since is null or m.created_time >= p_since);
$$;

grant execute on function public.meta_leads_solapados(timestamptz) to authenticated;
