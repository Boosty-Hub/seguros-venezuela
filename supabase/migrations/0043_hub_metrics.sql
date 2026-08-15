-- =============================================================================
-- hub_metrics()  —  contrato estándar de métricas Agente → Boosty Hub
-- =============================================================================
-- Se instala en la Supabase de CADA AGENTE (no en el Hub). Devuelve SOLO
-- agregados (cero PII, cero secretos) para que el Boosty Hub muestre el
-- "Centro de IA" (costo, tokens, mensajes in/out, latencia, salud de cola).
--
-- SEGURIDAD (estándar Boosty):
--   * SECURITY DEFINER + search_path fijo.
--   * REVOKE EXECUTE FROM PUBLIC/anon/authenticated  → la anon key NO puede
--     llamarla (verificar con curl anon → 403). Solo `service_role` (que el
--     Hub custodia en Vault y usa server-side) puede ejecutarla.
--   * NO lee `runtime_config` (ahí viven secretos, incluso algunos mal
--     marcados is_secret=false). Solo toca tablas de métricas.
--   * Es STABLE (solo lectura): no escribe ni muta nada en el agente.
--
-- Tablas del template kommo que consume: messages (entrantes),
-- drafts (respuestas; sent_at != null = enviado a Kommo), usage_events
-- (tokens/costo/runtime_ms por componente), inbound_queue (salud).
-- =============================================================================

create or replace function public.hub_metrics()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with
   msg as (select
     count(*) filter (where created_at::date = now()::date)              as in_today,
     count(*) filter (where created_at > now() - interval '7 days')      as in_7d,
     count(*) filter (where created_at >= date_trunc('month', now()))    as in_month,
     max(created_at)                                                     as last_inbound
     from public.messages),
   drf as (select
     count(*) filter (where created_at::date = now()::date and sent_at is not null)          as out_today,
     count(*) filter (where created_at > now() - interval '7 days' and sent_at is not null)   as out_7d,
     count(*) filter (where created_at >= date_trunc('month', now()) and sent_at is not null) as out_month,
     count(*) filter (where created_at > now() - interval '7 days' and sent_at is null)       as shadow_7d,
     count(*) filter (where created_at > now() - interval '7 days')                           as gen_7d,
     count(*) filter (where status = 'failed' and created_at > now() - interval '7 days')     as failed_7d
     from public.drafts),
   usg as (select
     round(coalesce(sum(estimated_cost_usd) filter (where created_at::date = now()::date), 0), 2)           as cost_today,
     round(coalesce(sum(estimated_cost_usd) filter (where created_at >= date_trunc('month', now())), 0), 2) as cost_month,
     round(coalesce(sum(estimated_cost_usd) filter (where created_at > now() - interval '7 days'), 0), 2)   as cost_7d,
     coalesce(sum(input_tokens + output_tokens) filter (where created_at > now() - interval '7 days'), 0)   as tokens_7d,
     max(created_at)                                                                                        as last_event
     from public.usage_events),
   lat as (select
     round(avg(runtime_ms))                                                          as llm_avg_ms,
     round(percentile_cont(0.95) within group (order by runtime_ms))                 as llm_p95_ms
     from public.usage_events
     where component = 'generate_response' and created_at > now() - interval '7 days'),
   clat as (select
     round(percentile_cont(0.5) within group (order by extract(epoch from d.created_at - m.created_at)))  as cust_p50_s,
     round(percentile_cont(0.95) within group (order by extract(epoch from d.created_at - m.created_at))) as cust_p95_s
     from public.drafts d join public.messages m on m.id = d.message_id
     where d.created_at > now() - interval '7 days'
       and d.created_at >= m.created_at
       and d.created_at < m.created_at + interval '1 hour'),
   -- Solo backlog (pending/processing): matchea el índice parcial
   -- `inbound_queue_pending_idx` → evita el seqscan de toda la tabla (que puede
   -- tener cientos de miles de filas 'done' y tardaría segundos). La señal de
   -- fallos de respuesta ya la aporta `failed_drafts_7d` (indexado).
   q as (select
     count(*) filter (where status = 'pending')    as pending,
     count(*) filter (where status = 'processing') as processing
     from public.inbound_queue
     where status in ('pending', 'processing')),
   mdl as (select model from public.usage_events
     where created_at > now() - interval '7 days' and model is not null
     group by model order by count(*) desc limit 1)
  select jsonb_build_object(
    'schema_version', 1,
    'generated_at', now(),
    'model', (select model from mdl),
    'messages', jsonb_build_object(
      'in_today', (select in_today from msg), 'in_7d', (select in_7d from msg), 'in_month', (select in_month from msg),
      'out_today', (select out_today from drf), 'out_7d', (select out_7d from drf), 'out_month', (select out_month from drf),
      'shadow_7d', (select shadow_7d from drf), 'generated_7d', (select gen_7d from drf)),
    'cost', jsonb_build_object(
      'today', (select cost_today from usg), 'month', (select cost_month from usg),
      'd7', (select cost_7d from usg), 'tokens_7d', (select tokens_7d from usg)),
    'latency', jsonb_build_object(
      'llm_avg_ms', (select llm_avg_ms from lat), 'llm_p95_ms', (select llm_p95_ms from lat),
      'customer_p50_s', (select cust_p50_s from clat), 'customer_p95_s', (select cust_p95_s from clat)),
    'queue', jsonb_build_object(
      'pending', (select pending from q), 'processing', (select processing from q)),
    'health', jsonb_build_object(
      'last_event_at', (select last_event from usg), 'last_inbound_at', (select last_inbound from msg),
      'failed_drafts_7d', (select failed_7d from drf))
  );
$$;

-- Least-privilege: solo el Hub (service_role) puede llamarla; la anon key NO.
revoke all on function public.hub_metrics() from public;
revoke all on function public.hub_metrics() from anon, authenticated;
grant execute on function public.hub_metrics() to service_role;

comment on function public.hub_metrics() is
  'Boosty Hub AI Ops: agregados de métricas (sin PII/secretos). Solo service_role. Ver supabase/agent-side/hub_metrics.sql en projects-hub.';
