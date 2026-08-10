-- ============================================================================
-- Control de duplicados en la entrada a Kommo.
--
-- Zoho abre varios tickets para la misma solicitud (mismo asunto, mismo
-- contacto, mismo titular) y sin esto cada uno generaba un lead. La clave
-- incluye el TITULAR a proposito: hay asuntos con cedula placeholder
-- (V-00000000) que se repiten entre personas distintas, y agrupar solo por
-- asunto + contacto fusionaba clientes que no son el mismo.
-- ============================================================================

-- Clave canonica de deduplicacion de un ticket.
create or replace function public.ticket_dedup_key(
  p_subject text, p_email text, p_phone text, p_contact text, p_titular text
) returns text
language sql
immutable
as $$
  select lower(coalesce(p_subject, ''))
      || '|' || coalesce(lower(p_email), regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), lower(coalesce(p_contact,'')), '')
      || '|' || lower(coalesce(p_titular, ''));
$$;

-- ---------------------------------------------------------------------------
-- Tickets pendientes que YA tienen un lead en Kommo creado por otro ticket
-- equivalente. Se usa para vincular en vez de crear un duplicado.
-- ---------------------------------------------------------------------------
create or replace function public.tickets_ya_en_kommo(p_since timestamptz default null)
returns table (
  ticket_id     text,
  ticket_number text,
  kommo_lead_id text,
  origen_ticket text
)
language sql
stable
as $$
  with c as (
    select id, ticket_number, kommo_lead_id, created_time,
           public.ticket_dedup_key(subject, email, phone, contact_name, titular) as k
    from public.tickets
    where is_spam is false
  )
  select distinct on (p.id) p.id, p.ticket_number, s.kommo_lead_id, s.ticket_number
  from c p
  join c s
    on s.k = p.k
   and s.id <> p.id
   and s.kommo_lead_id is not null
  where p.kommo_lead_id is null
    and (p_since is null or p.created_time >= p_since)
  order by p.id, s.created_time asc;
$$;

grant execute on function public.tickets_ya_en_kommo(timestamptz) to authenticated;
grant execute on function public.ticket_dedup_key(text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Auditoria: grupos de tickets equivalentes que produjeron mas de un lead.
-- Con la prevencion activa esta vista deberia quedarse vacia.
-- ---------------------------------------------------------------------------
create or replace view public.kommo_duplicados as
with c as (
  select id, ticket_number, kommo_lead_id, created_time,
         public.ticket_dedup_key(subject, email, phone, contact_name, titular) as k
  from public.tickets
  where kommo_lead_id is not null and is_spam is false
),
-- Un registro por (grupo, lead), con la fecha del ticket mas antiguo que lo creo.
l as (
  select distinct on (k, kommo_lead_id) k, kommo_lead_id, created_time, ticket_number
  from c
  order by k, kommo_lead_id, created_time asc
)
select k,
       count(*)                                                  as leads,
       min(created_time)                                         as primero,
       (array_agg(kommo_lead_id order by created_time asc))[1]    as lead_conservado,
       (array_agg(kommo_lead_id order by created_time asc))[2:]   as leads_duplicados,
       (array_agg(ticket_number  order by created_time asc))      as tickets
from l
group by k
-- Un grupo esta sucio solo si genero MAS DE UN lead. Que varios tickets
-- equivalentes apunten al mismo lead es exactamente el resultado buscado.
having count(*) > 1;

grant select on public.kommo_duplicados to authenticated;
