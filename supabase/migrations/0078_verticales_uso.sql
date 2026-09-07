-- =============================================================
-- 0078_verticales_uso.sql
-- Cuantos mensajes ha pasado el clasificador por cada vertical, para la
-- columna del modulo /verticales.
--
-- El dato vive en `messages.vertical_id`, que es lo que escribe
-- `process-inbound` tras clasificar. Solo hay mensajes `inbound` en esa tabla
-- (los del agente no se guardan ahi), asi que no hace falta filtrar por
-- direccion — pero se deja explicito para que siga siendo correcto si algun
-- dia se guardan los salientes.
--
-- POR QUE DEVUELVE TAMBIEN LA RECONCILIACION: la suma de la columna NO da el
-- total de mensajes, y sin explicarlo parece que el modulo se come registros.
-- Medido hoy: 611 inbound = 391 clasificados + 118 ignorados a proposito
-- (etapa del lead o media desactivada, nunca llegan al clasificador) + 102
-- fallidos. Los 102 son del apagon de saldo de Anthropic del 15-19 ago: ver
-- trampa 30.
--
-- El porcentaje se calcula sobre los CLASIFICADOS, no sobre el total: es la
-- pregunta que responde ("de lo que el clasificador reparte, cuanto se lleva
-- esta vertical"). Sobre el total, los porcentajes no sumarian 100 y se leeria
-- como si faltara algo.
-- =============================================================

create or replace function verticales_uso(p_dias_recientes int default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result jsonb;
  v_clasificados bigint;
begin
  select count(*) into v_clasificados
  from messages where direction = 'inbound' and vertical_id is not null;

  with uso as (
    select m.vertical_id,
           count(*) as mensajes,
           count(*) filter (where m.created_at > now() - make_interval(days => p_dias_recientes)) as recientes,
           max(m.created_at) as ultimo
    from messages m
    where m.direction = 'inbound' and m.vertical_id is not null
    group by m.vertical_id
  )
  select jsonb_build_object(
    'dias_recientes', p_dias_recientes,
    'por_vertical', coalesce((
      select jsonb_object_agg(vertical_id, jsonb_build_object(
        'mensajes',  mensajes,
        'recientes', recientes,
        'ultimo',    ultimo,
        -- null (no 0) cuando no hay nada clasificado: el front pinta "—".
        'pct', case when v_clasificados > 0
                    then round(100.0 * mensajes / v_clasificados, 1) end
      ))
      from uso
    ), '{}'::jsonb),
    'reconciliacion', (
      select jsonb_build_object(
        'total',          count(*),
        'clasificados',   count(*) filter (where vertical_id is not null),
        'ignorados',      count(*) filter (where vertical_id is null and ignored),
        'sin_clasificar', count(*) filter (where vertical_id is null and not ignored),
        -- De los sin clasificar, cuantos fallaron de verdad (tienen error) y
        -- cuantos siguen en cola. Se distingue porque uno es un problema y el
        -- otro es normal si el cron acaba de recibirlos.
        'fallidos',       count(*) filter (
                            where vertical_id is null and not ignored
                              and classification->>'error' is not null),
        'en_cola',        count(*) filter (
                            where vertical_id is null and not ignored
                              and classification->>'error' is null),
        'fallidos_desde', (select min(created_at)::date from messages
                           where direction = 'inbound' and vertical_id is null
                             and not ignored and classification->>'error' is not null),
        'fallidos_hasta', (select max(created_at)::date from messages
                           where direction = 'inbound' and vertical_id is null
                             and not ignored and classification->>'error' is not null)
      ) from messages where direction = 'inbound'
    )
  ) into result;

  return result;
end;
$fn$;

grant execute on function verticales_uso(int) to authenticated, service_role;

-- Sin este indice, cada carga de /verticales recorre `messages` entera para
-- agrupar. Con 611 filas da igual, pero la tabla crece con cada conversacion.
create index if not exists messages_vertical_id_idx
  on messages (vertical_id) where vertical_id is not null;
