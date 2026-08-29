-- =============================================================
-- 0063_analytics_canales_y_temas.sql
-- Corrige dos cifras de /analitica que estaban mintiendo. Mantiene TODAS las
-- claves que ya consumía la página y agrega las nuevas al final.
--
-- 1) CANALES: "Otro" era el 79% (376 de 476) y no era un canal. Eran los
--    leads importados de Zoho Desk: 0 mensajes y `leads.channel` NULL, que
--    el CASE mandaba al `else 'other'`. Mezclar una importación con
--    Instagram/WhatsApp hacía ilegible el gráfico.
--    Ahora:
--      - el canal se resuelve por `leads.channel` y, si viene NULL, se cae al
--        `source` del primer mensaje del lead (el dato existe: 87 leads lo
--        tienen ahí y antes se descartaba);
--      - los leads SIN NINGÚN mensaje quedan fuera del gráfico de canales
--        (no tienen canal de conversación) y se reportan aparte en
--        `leads_sin_conversacion`;
--      - un canal que aun así no se pueda resolver se etiqueta
--        `desconocido`, no 'other', para que se lea como dato faltante y no
--        como una categoría real.
--
-- 2) LO MÁS PREGUNTADO: "(sin clasificar)" era el bucket #1 (157 de 388) y
--    tampoco era un tema. Son 102 fallos del clasificador del 15-19/08 por
--    saldo agotado de Anthropic (classification->>'error' = "credit balance
--    is too low", ya resuelto), 53 mensajes IGNORADOS a propósito (etapa
--    pausada, comentarios apagados — nunca se clasifican por diseño) y 2
--    adjuntos sin URL procesable.
--    Un ranking de "lo más preguntado" con ruido de infraestructura adentro
--    no sirve para decidir nada: ahora solo entran mensajes realmente
--    clasificados. Lo que no se pudo clasificar NO se esconde — se expone en
--    `mensajes_sin_clasificar` / `fallos_clasificador` / `mensajes_ignorados`
--    para que el hueco sea visible como problema, no disfrazado de tema.
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
  -- Canal por lead: el de `leads.channel`; si falta, el del primer mensaje.
  cohort_canal_raw as (
    select
      c.id,
      coalesce(
        nullif(c.channel, ''),
        (select m.source
           from messages m
          where m.lead_id = c.id and nullif(m.source,'') is not null
          order by m.created_at asc
          limit 1)
      ) as canal_raw,
      exists(select 1 from messages m where m.lead_id = c.id) as tiene_conversacion
    from cohort c
  ),
  cohort_channel as (
    select
      id,
      tiene_conversacion,
      case
        when lower(coalesce(canal_raw,'')) like '%whatsapp%' or lower(coalesce(canal_raw,'')) = 'waba' then 'whatsapp'
        when lower(coalesce(canal_raw,'')) like '%instagram%' then 'instagram'
        when lower(coalesce(canal_raw,'')) like '%facebook%' or lower(coalesce(canal_raw,'')) = 'fb' then 'facebook'
        when lower(coalesce(canal_raw,'')) like '%tiktok%' then 'tiktok'
        when lower(coalesce(canal_raw,'')) like '%telegram%' then 'telegram'
        else 'desconocido'
      end as channel_norm
    from cohort_canal_raw
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
  -- Solo conversaciones reales: un lead importado sin mensajes no tiene canal.
  por_canal as (
    select channel_norm as canal, count(*) as leads
    from cohort_channel
    where tiene_conversacion
    group by channel_norm
    order by leads desc
  ),
  -- Mensajes que NO traen contenido del cliente: los genera la plataforma,
  -- no la persona. Son el 21% del inbound y 52 de los 81 que caían en "Otro",
  -- así que encabezaban "lo más preguntado" sin ser una pregunta:
  --   - "The message could not be displayed due to API restrictions" y
  --     "Unable to open this message…": avisos de Instagram/WhatsApp cuando
  --     el contenido no se puede entregar. Llegan literalmente vacíos.
  --   - "Mentioned you in their story": una mención en una historia, no un
  --     mensaje escrito para la empresa.
  -- Un saludo o un "gracias" SÍ se cuenta: lo escribió el cliente.
  inbound_util as (
    select m.*
    from messages m
    join cohort c on c.id = m.lead_id
    where m.direction = 'inbound'
      and coalesce(m.ignored, false) = false
      and coalesce(m.content,'') not ilike '%could not be displayed%'
      and coalesce(m.content,'') not ilike '%unable to open this message%'
      and coalesce(m.content,'') not ilike '%mentioned you in their story%'
  ),
  -- Solo mensajes efectivamente clasificados y con contenido real.
  por_intencion as (
    select
      m.classification->>'intent' as intent,
      count(*) as menciones
    from inbound_util m
    where nullif(m.classification->>'intent','') is not null
    group by 1
    order by menciones desc
    limit 15
  ),
  -- Salud del dato: los huecos se muestran, no se esconden.
  salud as (
    select
      count(*) filter (
        where m.direction = 'inbound'
          and coalesce(m.ignored, false) = false
          and nullif(m.classification->>'intent','') is null
      ) as sin_clasificar,
      count(*) filter (
        where m.direction = 'inbound' and m.classification ? 'error'
      ) as fallos_clasificador,
      count(*) filter (
        where m.direction = 'inbound' and coalesce(m.ignored, false)
      ) as ignorados,
      count(*) filter (
        where m.direction = 'inbound'
          and (coalesce(m.content,'') ilike '%could not be displayed%'
            or coalesce(m.content,'') ilike '%unable to open this message%'
            or coalesce(m.content,'') ilike '%mentioned you in their story%')
      ) as sin_contenido
    from messages m
    join cohort c on c.id = m.lead_id
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
    ),
    -- Nuevas: contexto para leer bien los dos gráficos corregidos.
    'leads_con_conversacion', (select count(*) from cohort_channel where tiene_conversacion),
    'leads_sin_conversacion', (select count(*) from cohort_channel where not tiene_conversacion),
    'mensajes_sin_clasificar', (select sin_clasificar from salud),
    'fallos_clasificador', (select fallos_clasificador from salud),
    'mensajes_ignorados', (select ignorados from salud),
    'mensajes_sin_contenido', (select sin_contenido from salud)
  ) into result;

  return result;
end;
$$;
