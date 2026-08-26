-- =============================================================
-- 0059_analytics_overview.sql
-- Módulo de Analítica: trazabilidad completa del funnel del agente sobre
-- el MISMO cohorte (leads cuyo first_seen_at cae en el rango elegido):
--   entra a Kommo → lo atiende el agente → lo transfiere a un humano →
--   de esos, cuántos terminan Ganados.
--
-- Sigue el mismo patrón que hub_metrics() (0043_hub_metrics.sql): una sola
-- función SECURITY DEFINER que agrega todo en Postgres y devuelve un JSONB,
-- para que la página de Next.js haga UNA sola llamada RPC en vez de traer
-- filas crudas y agregar en JS (que no escala — ver nota de auditoría del
-- inbox: limit(500) + filtro en memoria).
--
-- IDs de "Ganado"/"Perdido": 142/143 son estados GLOBALES compartidos por
-- Kommo entre TODOS los pipelines de esta cuenta (confirmado contra la API
-- real de Kommo — 142 = "poliza adquirida"/"RENOVÓ POLIZA"/"Logrado con
-- éxito" según el pipeline; 143 = "cliente Perdido"/"NO RENOVÓ"/"Ventas
-- Perdidos"). Si se clona este template a otra cuenta de Kommo, estos IDs
-- pueden diferir — no hay forma de resolverlos por nombre de forma genérica
-- porque el nombre cambia por pipeline.
-- =============================================================

create or replace function analytics_overview(p_since timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  with
  cohort as (
    select l.*
    from leads l
    where l.first_seen_at >= p_since
  ),
  cohort_channel as (
    select
      c.id,
      case
        when lower(coalesce(c.channel,'')) like '%whatsapp%' or lower(coalesce(c.channel,'')) = 'waba' then 'whatsapp'
        when lower(coalesce(c.channel,'')) like '%instagram%' then 'instagram'
        when lower(coalesce(c.channel,'')) like '%facebook%' or lower(coalesce(c.channel,'')) = 'fb' then 'facebook'
        when lower(coalesce(c.channel,'')) like '%tiktok%' then 'tiktok'
        when lower(coalesce(c.channel,'')) like '%telegram%' then 'telegram'
        else 'other'
      end as channel_norm
    from cohort c
  ),
  atendidos as (
    select distinct m.lead_id
    from drafts d
    join messages m on m.id = d.message_id
    join cohort c on c.id = m.lead_id
    where d.status in ('auto_sent','sent')
  ),
  transferidos as (
    select c.*
    from cohort c
    where c.transferred_to_human_at is not null
  ),
  por_vertical as (
    select
      v.slug,
      v.name,
      count(distinct m.lead_id) as leads,
      count(*) as mensajes
    from messages m
    join cohort c on c.id = m.lead_id
    join verticals v on v.id = m.vertical_id
    group by v.slug, v.name
    order by leads desc
  ),
  por_canal as (
    select channel_norm as canal, count(*) as leads
    from cohort_channel
    group by channel_norm
    order by leads desc
  ),
  por_intencion as (
    select
      coalesce(nullif(m.classification->>'intent',''), '(sin clasificar)') as intent,
      count(*) as menciones
    from messages m
    join cohort c on c.id = m.lead_id
    where m.direction = 'inbound'
    group by 1
    order by menciones desc
    limit 15
  ),
  volumen_diario as (
    select
      date_trunc('day', m.created_at)::date as dia,
      count(*) filter (where m.direction = 'inbound') as inbound,
      count(*) filter (where m.direction = 'outbound') as outbound
    from messages m
    join cohort c on c.id = m.lead_id
    group by 1
    order by 1
  ),
  leads_por_dia as (
    select date_trunc('day', c.first_seen_at)::date as dia, count(*) as leads
    from cohort c
    group by 1
    order by 1
  ),
  tiempos_respuesta as (
    select extract(epoch from (d.created_at - m.created_at)) as seg
    from drafts d
    join messages m on m.id = d.message_id
    join cohort c on c.id = m.lead_id
    where d.status in ('auto_sent','sent') and m.direction = 'inbound'
  ),
  mensajes_cohort as (
    select count(*) as total from messages m join cohort c on c.id = m.lead_id
  )
  select jsonb_build_object(
    'since', p_since,
    'leads_entrantes', (select count(*) from cohort),
    'leads_por_dia', (select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'leads', leads) order by dia), '[]'::jsonb) from leads_por_dia),
    'atendidos_por_agente', (select count(*) from atendidos),
    'transferidos_humano', (select count(*) from transferidos),
    'transferidos_ganados', (select count(*) from transferidos where kommo_stage_id = 142),
    'transferidos_perdidos', (select count(*) from transferidos where kommo_stage_id = 143),
    'ganados_totales', (select count(*) from cohort where kommo_stage_id = 142),
    'perdidos_totales', (select count(*) from cohort where kommo_stage_id = 143),
    'por_vertical', (select coalesce(jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'leads', leads, 'mensajes', mensajes)), '[]'::jsonb) from por_vertical),
    'por_canal', (select coalesce(jsonb_agg(jsonb_build_object('canal', canal, 'leads', leads)), '[]'::jsonb) from por_canal),
    'por_intencion', (select coalesce(jsonb_agg(jsonb_build_object('intent', intent, 'menciones', menciones)), '[]'::jsonb) from por_intencion),
    'volumen_diario', (select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'inbound', inbound, 'outbound', outbound) order by dia), '[]'::jsonb) from volumen_diario),
    'tiempo_respuesta_prom_seg', (select round(avg(seg))::int from tiempos_respuesta where seg >= 0),
    'mensajes_total', (select total from mensajes_cohort),
    'mensajes_por_lead_prom', (
      select case when (select count(*) from cohort) > 0
        then round((select total from mensajes_cohort)::numeric / (select count(*) from cohort), 1)
        else 0 end
    )
  ) into result;

  return result;
end;
$$;

grant execute on function analytics_overview(timestamptz) to authenticated;
