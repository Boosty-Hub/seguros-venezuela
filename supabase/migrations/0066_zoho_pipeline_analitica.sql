-- =============================================================
-- 0066_zoho_pipeline_analitica.sql
-- Analítica del pipeline de Zoho para el panel lateral de /pipeline.
--
-- Una sola función que devuelve TODO lo que dibuja el panel, para que abrirlo
-- sea un solo viaje a la base y no diez.
--
-- Qué se grafica y qué no, medido contra los datos reales (14.427 tickets no
-- spam):
--   plan_hcm  99,2% lleno  -> sí
--   edad      99,2% lleno  -> sí
--   status    100%   lleno -> sí
--   monto_prima 13,6% lleno -> sí, PERO declarando cuántos no la traen
--   moneda    0%     -> no se grafica (columna vacía)
--   ramo      0%     -> no se grafica (columna vacía)
-- Graficar una columna vacía es peor que no graficarla: parece un dato.
-- =============================================================

create or replace function zoho_pipeline_analitica(p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  with base as (
    select
      t.*,
      zoho_destino(t.asesor) as destino,
      zoho_norm(t.asesor) as asesor_norm,
      zoho_cliente_key(t.subject, t.titular, t.id::text) as cliente_key,
      -- Tramos de edad con sentido para seguros de salud: menores, adulto
      -- joven, y de ahí en décadas hasta el tramo caro (66+).
      case
        when t.edad is null then null
        when t.edad < 18 then '0-17'
        when t.edad < 26 then '18-25'
        when t.edad < 36 then '26-35'
        when t.edad < 46 then '36-45'
        when t.edad < 56 then '46-55'
        when t.edad < 66 then '56-65'
        else '66+'
      end as rango_edad,
      case
        when t.edad is null then 99
        when t.edad < 18 then 1
        when t.edad < 26 then 2
        when t.edad < 36 then 3
        when t.edad < 46 then 4
        when t.edad < 56 then 5
        when t.edad < 66 then 6
        else 7
      end as rango_orden
    from tickets t
    where t.is_spam is false
      and (p_since is null or t.created_time >= p_since)
  ),
  corredores as (
    select
      asesor_norm,
      count(*) as cotizaciones,
      count(distinct cliente_key) as clientes
    from base
    where destino = 'b2b' and asesor_norm is not null
    group by asesor_norm
  ),
  top10 as (
    select * from corredores order by cotizaciones desc, asesor_norm limit 10
  ),
  clientes_b2b as (
    select cliente_key, count(*) as n
    from base where destino = 'b2b'
    group by cliente_key
  )
  select jsonb_build_object(
    'since', p_since,
    'totales', jsonb_build_object(
      'cotizaciones', (select count(*) from base),
      'b2c', (select count(*) from base where destino='b2c'),
      'b2b', (select count(*) from base where destino='b2b'),
      'sin_atribucion', (select count(*) from base where destino='sin_atribucion'),
      'corredores', (select count(*) from corredores),
      'clientes', (select count(distinct cliente_key) from base),
      'clientes_b2b', (select count(*) from clientes_b2b),
      'en_kommo', (select count(*) from base where kommo_lead_id is not null)
    ),

    -- Plan, cruzado por destino: responde si el corredor vende plan distinto
    -- al que pide el cliente final.
    'por_plan', coalesce((
      select jsonb_agg(x order by x_total desc) from (
        select jsonb_build_object(
          'plan', coalesce(plan_hcm, 'sin plan'),
          'total', count(*),
          'b2c', count(*) filter (where destino='b2c'),
          'b2b', count(*) filter (where destino='b2b')
        ) as x, count(*) as x_total
        from base group by coalesce(plan_hcm, 'sin plan')
      ) s
    ), '[]'::jsonb),

    'por_edad', coalesce((
      select jsonb_agg(x order by x_orden) from (
        select jsonb_build_object(
          'rango', coalesce(rango_edad, 'sin edad'),
          'total', count(*),
          'b2c', count(*) filter (where destino='b2c'),
          'b2b', count(*) filter (where destino='b2b')
        ) as x, rango_orden as x_orden
        from base group by rango_edad, rango_orden
      ) s
    ), '[]'::jsonb),

    -- Cruce plan x edad: dónde se concentra la demanda de verdad.
    'plan_x_edad', coalesce((
      select jsonb_agg(x order by x_orden) from (
        select jsonb_build_object(
          'plan', coalesce(plan_hcm, 'sin plan'),
          'rango', coalesce(rango_edad, 'sin edad'),
          'n', count(*)
        ) as x, rango_orden as x_orden
        from base
        where plan_hcm is not null and rango_edad is not null
        group by plan_hcm, rango_edad, rango_orden
      ) s
    ), '[]'::jsonb),

    'por_mes', coalesce((
      select jsonb_agg(x order by x_mes) from (
        select jsonb_build_object(
          'mes', to_char(date_trunc('month', created_time), 'YYYY-MM'),
          'total', count(*),
          'b2c', count(*) filter (where destino='b2c'),
          'b2b', count(*) filter (where destino='b2b')
        ) as x, to_char(date_trunc('month', created_time), 'YYYY-MM') as x_mes
        from base where created_time is not null
        group by date_trunc('month', created_time)
      ) s
    ), '[]'::jsonb),

    'por_estado', coalesce((
      select jsonb_agg(x order by x_n desc) from (
        select jsonb_build_object(
          'status', coalesce(status, 'sin estado'),
          'tipo', coalesce(status_type, '—'),
          'n', count(*)
        ) as x, count(*) as x_n
        from base group by status, status_type
      ) s
    ), '[]'::jsonb),

    'top_corredores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'asesor', asesor_norm, 'cotizaciones', cotizaciones, 'clientes', clientes
      ) order by cotizaciones desc, asesor_norm) from top10
    ), '[]'::jsonb),

    -- Concentración: cuánto del B2B depende de los 10 corredores más grandes,
    -- y cuántos corredores mandaron una sola cotización (cola larga).
    'concentracion', jsonb_build_object(
      'top10_cotizaciones', coalesce((select sum(cotizaciones) from top10), 0),
      'b2b_cotizaciones', coalesce((select sum(cotizaciones) from corredores), 0),
      'corredores_una_sola', coalesce((select count(*) from corredores where cotizaciones = 1), 0)
    ),

    -- Prima: solo el 13,6% de los tickets la trae. Se devuelve el hueco junto
    -- al dato para que el panel no presente un promedio como si fuera de todos.
    'prima', jsonb_build_object(
      'con_dato', (select count(*) from base where monto_prima is not null),
      'sin_dato', (select count(*) from base where monto_prima is null),
      'promedio', (select round(avg(monto_prima)::numeric, 2) from base where monto_prima is not null),
      'mediana', (select round(percentile_cont(0.5) within group (order by monto_prima)::numeric, 2)
                  from base where monto_prima is not null),
      'por_plan', coalesce((
        select jsonb_agg(x order by x_orden) from (
          select jsonb_build_object(
            'plan', plan_hcm,
            'n', count(*),
            'promedio', round(avg(monto_prima)::numeric, 2)
          ) as x, avg(monto_prima) as x_orden
          from base where monto_prima is not null and plan_hcm is not null
          group by plan_hcm
        ) s
      ), '[]'::jsonb)
    ),

    -- Repetición: un corredor que vuelve al mismo cliente suele ser grupo
    -- familiar o comparativa de planes.
    'repeticion', jsonb_build_object(
      'una', (select count(*) from clientes_b2b where n = 1),
      'dos_a_cinco', (select count(*) from clientes_b2b where n between 2 and 5),
      'seis_o_mas', (select count(*) from clientes_b2b where n >= 6)
    )
  ) into result;

  return result;
end;
$$;

grant execute on function zoho_pipeline_analitica(timestamptz) to authenticated, service_role;
