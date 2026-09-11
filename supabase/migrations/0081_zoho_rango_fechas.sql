-- =============================================================
-- 0081_zoho_rango_fechas.sql
-- Rango de fechas en /pipeline: las funciones ya aceptaban `p_since` (un
-- "desde" abierto), pero no había forma de acotar el final, así que "el mes
-- pasado" o un rango cerrado eran imposibles. Se agrega `p_hasta` a las cinco
-- funciones del módulo y se crea `zoho_embudo_resumen`, que es lo que le
-- faltaba a la pestaña "Embudo Zoho": sus cuatro vistas (v_kpis, v_funnel,
-- v_channel, v_agent) agregan sobre TODO el histórico y no se pueden filtrar.
--
-- El corte es SIEMPRE `>= desde` y `< hasta`, medio abierto: así un día
-- concreto es [día, día+1) y no hay que preocuparse por la hora ni por dejar
-- fuera lo que pasó a las 23:59.
--
-- Agregar un parámetro con default NO reemplaza la función: crea una
-- SOBRECARGA, y entonces una llamada con un solo argumento queda ambigua
-- ("function is not unique"). Por eso cada una se dropea antes. Los cuerpos
-- son los vigentes (0067, 0072, 0077) con el predicado nuevo y nada más —
-- generados por transformación del original y revisados por diff, no
-- transcritos a mano.
--
-- IDEMPOTENTE.
-- =============================================================

drop function if exists zoho_pipeline_overview(timestamptz);

create or replace function zoho_pipeline_overview(
  p_since timestamptz default null,
  p_hasta timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  with base as (
    select * from mv_zoho_clasificacion
    where (p_since is null or created_time >= p_since)
      and (p_hasta is null or created_time < p_hasta)
  ),
  totales as (
    select destino, count(*) as tickets,
           count(*) filter (where kommo_lead_id is not null) as en_kommo,
           count(distinct cliente_key) as clientes
    from base group by destino
  ),
  corredores as (
    select asesor_norm,
           min(asesor_original) as asesor_muestra,
           count(*) as cotizaciones,
           count(distinct cliente_key) as clientes,
           count(*) filter (where kommo_lead_id is not null) as en_kommo,
           max(created_time) as ultima
    from base
    where destino = 'b2b' and asesor_norm is not null
    group by asesor_norm
  )
  select jsonb_build_object(
    'since', p_since,
    'hasta', p_hasta,
    'b2c_tickets', coalesce((select tickets from totales where destino='b2c'), 0),
    'b2c_en_kommo', coalesce((select en_kommo from totales where destino='b2c'), 0),
    'b2c_clientes', coalesce((select clientes from totales where destino='b2c'), 0),
    'b2b_tickets', coalesce((select tickets from totales where destino='b2b'), 0),
    'b2b_en_kommo', coalesce((select en_kommo from totales where destino='b2b'), 0),
    'b2b_clientes', coalesce((select clientes from totales where destino='b2b'), 0),
    'b2b_corredores', coalesce((select count(*) from corredores), 0),
    'sin_atribucion_tickets', coalesce((select tickets from totales where destino='sin_atribucion'), 0),
    'corredores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'asesor', asesor_norm,
        'asesor_original', asesor_muestra,
        'cotizaciones', cotizaciones,
        'clientes', clientes,
        'en_kommo', en_kommo,
        'ultima', ultima
      ) order by cotizaciones desc, asesor_norm)
      from corredores
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;


drop function if exists zoho_corredor_detalle(text, timestamptz);

create or replace function zoho_corredor_detalle(
  p_asesor text,
  p_since timestamptz default null,
  p_hasta timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  with base as (
    -- La clasificación sale de la vista (barata); el detalle de cada
    -- cotización, de `tickets` (dato vivo).
    select t.*, c.cedula, c.cliente_key
    from mv_zoho_clasificacion c
    join tickets t on t.id = c.id
    where c.destino = 'b2b'
      and c.asesor_norm = zoho_norm(p_asesor)
      and (p_since is null or c.created_time >= p_since)
      and (p_hasta is null or c.created_time < p_hasta)
  ),
  cotis as (
    select
      cliente_key,
      cedula,
      jsonb_agg(jsonb_build_object(
        'id', id, 'ticket_number', ticket_number, 'subject', subject,
        'plan', plan_hcm, 'edad', edad, 'prima', monto_prima, 'moneda', moneda,
        'status', status, 'status_type', status_type, 'creado', created_time,
        'web_url', web_url, 'en_kommo', (kommo_lead_id is not null)
      ) order by created_time desc) as cotizaciones,
      count(*) as n_cotizaciones,
      max(created_time) as ultima,
      (array_agg(titular order by created_time desc)
        filter (where zoho_norm(titular) is not null
                  and zoho_norm(titular) not in ('DIRECTO','SI','NO','N/A','NA','SIN','-')))[1] as titular,
      (array_agg(email order by created_time desc) filter (where coalesce(email,'') <> ''))[1] as email,
      (array_agg(phone order by created_time desc) filter (where coalesce(phone,'') <> ''))[1] as telefono
    from base
    group by cliente_key, cedula
  )
  select jsonb_build_object(
    'asesor', zoho_norm(p_asesor),
    'total_cotizaciones', (select count(*) from base),
    'total_clientes', (select count(*) from cotis),
    'clientes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'cedula', cedula, 'titular', titular, 'email', email, 'telefono', telefono,
        'n_cotizaciones', n_cotizaciones, 'ultima', ultima, 'cotizaciones', cotizaciones
      ) order by n_cotizaciones desc, ultima desc)
      from cotis
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;


drop function if exists zoho_pipeline_analitica(timestamptz);

create or replace function zoho_pipeline_analitica(
  p_since timestamptz default null,
  p_hasta timestamptz default null
)
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
      c.destino, c.asesor_norm, c.cliente_key, c.kommo_lead_id, c.created_time,
      t.plan_hcm, t.edad, t.monto_prima, t.status, t.status_type,
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
        when t.edad < 18 then 1  when t.edad < 26 then 2
        when t.edad < 36 then 3  when t.edad < 46 then 4
        when t.edad < 56 then 5  when t.edad < 66 then 6
        else 7
      end as rango_orden
    from mv_zoho_clasificacion c
    join tickets t on t.id = c.id
    where (p_since is null or c.created_time >= p_since)
      and (p_hasta is null or c.created_time < p_hasta)
  ),
  corredores as (
    select asesor_norm, count(*) as cotizaciones, count(distinct cliente_key) as clientes
    from base where destino = 'b2b' and asesor_norm is not null
    group by asesor_norm
  ),
  top10 as (select * from corredores order by cotizaciones desc, asesor_norm limit 10),
  clientes_b2b as (
    select cliente_key, count(*) as n from base where destino = 'b2b' group by cliente_key
  )
  select jsonb_build_object(
    'since', p_since,
    'hasta', p_hasta,
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
    'por_plan', coalesce((
      select jsonb_agg(x order by x_total desc) from (
        select jsonb_build_object(
          'plan', coalesce(plan_hcm, 'sin plan'), 'total', count(*),
          'b2c', count(*) filter (where destino='b2c'),
          'b2b', count(*) filter (where destino='b2b')
        ) as x, count(*) as x_total
        from base group by coalesce(plan_hcm, 'sin plan')
      ) s
    ), '[]'::jsonb),
    'por_edad', coalesce((
      select jsonb_agg(x order by x_orden) from (
        select jsonb_build_object(
          'rango', coalesce(rango_edad, 'sin edad'), 'total', count(*),
          'b2c', count(*) filter (where destino='b2c'),
          'b2b', count(*) filter (where destino='b2b')
        ) as x, rango_orden as x_orden
        from base group by rango_edad, rango_orden
      ) s
    ), '[]'::jsonb),
    'plan_x_edad', coalesce((
      select jsonb_agg(x order by x_orden) from (
        select jsonb_build_object(
          'plan', coalesce(plan_hcm,'sin plan'), 'rango', coalesce(rango_edad,'sin edad'), 'n', count(*)
        ) as x, rango_orden as x_orden
        from base where plan_hcm is not null and rango_edad is not null
        group by plan_hcm, rango_edad, rango_orden
      ) s
    ), '[]'::jsonb),
    'por_mes', coalesce((
      select jsonb_agg(x order by x_mes) from (
        select jsonb_build_object(
          'mes', to_char(date_trunc('month', created_time), 'YYYY-MM'), 'total', count(*),
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
          'status', coalesce(status,'sin estado'), 'tipo', coalesce(status_type,'—'), 'n', count(*)
        ) as x, count(*) as x_n
        from base group by status, status_type
      ) s
    ), '[]'::jsonb),
    'top_corredores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'asesor', asesor_norm, 'cotizaciones', cotizaciones, 'clientes', clientes
      ) order by cotizaciones desc, asesor_norm) from top10
    ), '[]'::jsonb),
    'concentracion', jsonb_build_object(
      'top10_cotizaciones', coalesce((select sum(cotizaciones) from top10), 0),
      'b2b_cotizaciones', coalesce((select sum(cotizaciones) from corredores), 0),
      'corredores_una_sola', coalesce((select count(*) from corredores where cotizaciones = 1), 0)
    ),
    'prima', jsonb_build_object(
      'con_dato', (select count(*) from base where monto_prima is not null),
      'sin_dato', (select count(*) from base where monto_prima is null),
      'promedio', (select round(avg(monto_prima)::numeric,2) from base where monto_prima is not null),
      'mediana', (select round(percentile_cont(0.5) within group (order by monto_prima)::numeric,2)
                  from base where monto_prima is not null),
      'por_plan', coalesce((
        select jsonb_agg(x order by x_orden) from (
          select jsonb_build_object('plan', plan_hcm, 'n', count(*), 'promedio', round(avg(monto_prima)::numeric,2)) as x,
                 avg(monto_prima) as x_orden
          from base where monto_prima is not null and plan_hcm is not null
          group by plan_hcm
        ) s
      ), '[]'::jsonb)
    ),
    'repeticion', jsonb_build_object(
      'una', (select count(*) from clientes_b2b where n = 1),
      'dos_a_cinco', (select count(*) from clientes_b2b where n between 2 and 5),
      'seis_o_mas', (select count(*) from clientes_b2b where n >= 6)
    )
  ) into result;

  return result;
end;
$$;


drop function if exists zoho_corredores_efectividad(timestamptz, int);

create or replace function zoho_corredores_efectividad(
  p_since timestamptz default null,
  p_maduracion_dias int default 60,
  p_hasta timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  result jsonb;
  v_desde date;
  v_hasta date;
  v_ini timestamptz;
  v_fin timestamptz;
begin
  select min(fecha_suscripcion), max(fecha_suscripcion) into v_desde, v_hasta from v_polizas;

  -- Sin emisiones cargadas no hay nada que cruzar: se responde explicito en
  -- vez de devolver ceros que se leerian como "todos los corredores fallan".
  if v_desde is null then
    return jsonb_build_object(
      'sin_datos', true,
      'mensaje', 'No hay emisiones cargadas todavia. Sube el Reporte de Emision para ver la efectividad.',
      'corredores', '[]'::jsonb
    );
  end if;

  v_ini := (v_desde - make_interval(days => p_maduracion_dias))::timestamptz;
  v_fin := (v_hasta + interval '1 day')::timestamptz;
  -- El filtro de periodo del usuario no puede ensanchar la ventana observable.
  if p_since is not null and p_since > v_ini then
    v_ini := p_since;
  end if;
  -- Simetrico por arriba: el corte de fin del usuario tampoco puede
  -- ensanchar la ventana observable, solo estrecharla.
  if p_hasta is not null and p_hasta < v_fin then
    v_fin := p_hasta;
  end if;

  with emis as (
    -- Una poliza aporta sus DOS cedulas (tomador y asegurado, que a menudo son
    -- personas distintas). distinct porque cuando coinciden saldria duplicada.
    select distinct nu_poliza, cod_intermediario, estatus, ced
    from (
      select nu_poliza, cod_intermediario, estatus, ci_tomador_digitos   as ced from v_polizas
      union all
      select nu_poliza, cod_intermediario, estatus, ci_asegurado_digitos as ced from v_polizas
    ) s
    where ced is not null
  ),
  -- RENDIMIENTO: antes esto eran tres `exists` correlacionados por cotizacion
  -- (3 x 12.286 pasadas sobre una CTE sin indice) y la funcion tardaba 2,5 s,
  -- el triple de lo que tarda toda la pagina /pipeline. Pre-agregando por
  -- (cedula, codigo) y uniendo UNA vez con hash join baja a decimas.
  emis_agg as (
    select ced, cod_intermediario,
           bool_or(estatus = 'Vigente') as vigente,
           bool_or(estatus = 'Anulada') as anulada
    from emis
    group by ced, cod_intermediario
  ),
  -- Para "el cliente emitio con OTRO": basta saber cuantos codigos distintos
  -- tiene esa cedula y cual es uno de ellos. Si hay mas de uno, alguno es
  -- distinto del del corredor sin necesidad de compararlos todos.
  emis_ced as (
    select ced, count(distinct cod_intermediario) as cods, min(cod_intermediario) as un_cod
    from emis
    group by ced
  ),
  cot as (
    select m.id, m.cedula, m.cliente_key, m.created_time, m.asesor_norm, m.asesor_original,
           a.cod_intermediario,
           (m.created_time >= v_ini and m.created_time < v_fin) as en_ventana,
           (m.created_time >= v_fin)                            as posterior
    from mv_zoho_clasificacion m
    left join corredor_alias a
      on a.asesor_norm = m.asesor_norm and a.origen <> 'rechazado'
    where m.destino = 'b2b'
      and m.asesor_norm is not null
      and (p_since is null or m.created_time >= p_since)
      and (p_hasta is null or m.created_time < p_hasta)
  ),
  marcada as (
    select c.*,
      -- Igualdad estricta en el join: si el asesor no esta mapeado (cod null)
      -- no machea nada y no se le acredita ningun cierre. Con `is not distinct
      -- from` las cotizaciones sin mapear machearian polizas sin codigo e
      -- inventarian efectividad.
      coalesce(g.vigente, false) as cerrada,
      coalesce(g.anulada, false) as anulada,
      case
        when x.ced is null then false
        when c.cod_intermediario is null then true   -- sin mapear: cualquiera es "otro"
        when x.cods > 1 then true
        else x.un_cod <> c.cod_intermediario
      end as cerrada_otro
    from cot c
    left join emis_agg g on g.ced = c.cedula and g.cod_intermediario = c.cod_intermediario
    left join emis_ced x on x.ced = c.cedula
  ),
  agr as (
    select
      coalesce(cod_intermediario, 'zoho:' || asesor_norm) as clave,
      max(cod_intermediario)                              as cod_intermediario,
      count(distinct asesor_norm)                         as alias_n,
      min(asesor_original)                                as asesor_muestra,
      count(*)                                            as cotizaciones,
      count(distinct cliente_key)                         as clientes,
      count(*) filter (where en_ventana)                  as cotiz_en_ventana,
      count(distinct cliente_key) filter (where en_ventana) as clientes_en_ventana,
      count(*) filter (where posterior)                   as cotiz_en_curso,
      count(*) filter (where en_ventana and cerrada)      as cotiz_cerradas,
      count(distinct cliente_key) filter (where en_ventana and cerrada) as clientes_cerrados,
      count(*) filter (where en_ventana and anulada)      as cotiz_anuladas,
      count(*) filter (where en_ventana and not cerrada and cerrada_otro) as cerradas_otro,
      max(created_time)                                   as ultima
    from marcada
    group by 1
  ),
  -- Medida inversa, la fiable con un solo mes: de las polizas emitidas del
  -- corredor, cuantas venian de una cotizacion en Zoho.
  --
  -- Las cedulas cotizadas se sacan una sola vez y se unen con dos left join
  -- (tomador y asegurado) en vez de un exists por poliza: el exists corria
  -- 539 veces sobre 15.000 filas de la mv.
  ced_b2b as (
    select distinct cedula
    from mv_zoho_clasificacion
    where destino = 'b2b' and cedula is not null
  ),
  pol_marcada as (
    select p.cod_intermediario, p.estatus,
           (t.cedula is not null or s2.cedula is not null) as tiene_cotizacion
    from v_polizas p
    left join ced_b2b t  on t.cedula  = p.ci_tomador_digitos
    left join ced_b2b s2 on s2.cedula = p.ci_asegurado_digitos
    where p.cod_intermediario is not null
  ),
  pol as (
    select cod_intermediario,
           count(*) as polizas_emitidas,
           count(*) filter (where estatus = 'Vigente') as polizas_vigentes,
           count(*) filter (where estatus = 'Anulada') as polizas_anuladas,
           count(*) filter (where tiene_cotizacion)    as polizas_con_cotizacion
    from pol_marcada
    group by 1
  )
  select jsonb_build_object(
    'since', p_since,
    'hasta', p_hasta,
    'maduracion_dias', p_maduracion_dias,
    'emisiones_cargadas', (select count(*) from v_polizas),
    'periodo_emisiones', jsonb_build_object('desde', v_desde, 'hasta', v_hasta),
    'ventana_cotizaciones', jsonb_build_object('desde', v_ini, 'hasta', v_fin),
    -- Mientras la ventana de cotizaciones sea mas ancha que la de emisiones,
    -- el porcentaje es un suelo. El front lo dice con estas palabras.
    'parcial', true,
    'nota_parcial', format(
      'Porcentaje parcial: solo hay emisiones de %s a %s, asi que los cierres ' ||
      'anteriores o posteriores a ese rango no se ven. El numero solo puede subir ' ||
      'al cargar mas meses.', to_char(v_desde, 'DD/MM/YYYY'), to_char(v_hasta, 'DD/MM/YYYY')),
    'corredores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'clave',                a.clave,
        'cod_intermediario',    a.cod_intermediario,
        'nombre',               coalesce(i.nombre, a.asesor_muestra),
        'mapeado',              (a.cod_intermediario is not null),
        'alias_n',              a.alias_n,
        'cotizaciones',         a.cotizaciones,
        'clientes',             a.clientes,
        'cotiz_en_ventana',     a.cotiz_en_ventana,
        'clientes_en_ventana',  a.clientes_en_ventana,
        'cotiz_en_curso',       a.cotiz_en_curso,
        'cotiz_cerradas',       a.cotiz_cerradas,
        'clientes_cerrados',    a.clientes_cerrados,
        'cotiz_anuladas',       a.cotiz_anuladas,
        'cerradas_otro',        a.cerradas_otro,
        'polizas_emitidas',     coalesce(p.polizas_emitidas, 0),
        'polizas_vigentes',     coalesce(p.polizas_vigentes, 0),
        'polizas_anuladas',     coalesce(p.polizas_anuladas, 0),
        'polizas_con_cotizacion',  coalesce(p.polizas_con_cotizacion, 0),
        'polizas_sin_cotizacion',  coalesce(p.polizas_emitidas, 0) - coalesce(p.polizas_con_cotizacion, 0),
        -- null (no 0) cuando no hay base en ventana: el front lo muestra como
        -- "—" en vez de un 0% que parece mal desempeno y es falta de datos.
        'efec_cotizaciones',    case when a.cotiz_en_ventana > 0
                                     then round(100.0 * a.cotiz_cerradas / a.cotiz_en_ventana, 1) end,
        'efec_clientes',        case when a.clientes_en_ventana > 0
                                     then round(100.0 * a.clientes_cerrados / a.clientes_en_ventana, 1) end,
        'ultima',               a.ultima
      ) order by a.cotizaciones desc, a.clave)
      from agr a
      left join intermediarios i on i.cod_intermediario = a.cod_intermediario
      left join pol p on p.cod_intermediario = a.cod_intermediario
    ), '[]'::jsonb),
    'totales', (
      select jsonb_build_object(
        'corredores',          count(*),
        'sin_mapear',          count(*) filter (where cod_intermediario is null),
        'cotizaciones',        coalesce(sum(cotizaciones), 0),
        'cotiz_en_ventana',    coalesce(sum(cotiz_en_ventana), 0),
        'cotiz_cerradas',      coalesce(sum(cotiz_cerradas), 0),
        'cotiz_en_curso',      coalesce(sum(cotiz_en_curso), 0),
        'clientes_en_ventana', coalesce(sum(clientes_en_ventana), 0),
        'clientes_cerrados',   coalesce(sum(clientes_cerrados), 0),
        'cerradas_otro',       coalesce(sum(cerradas_otro), 0),
        'efec_cotizaciones',   case when coalesce(sum(cotiz_en_ventana), 0) > 0
                                    then round(100.0 * sum(cotiz_cerradas) / sum(cotiz_en_ventana), 1) end,
        'efec_clientes',       case when coalesce(sum(clientes_en_ventana), 0) > 0
                                    then round(100.0 * sum(clientes_cerrados) / sum(clientes_en_ventana), 1) end
      ) from agr
    ),
    'emisiones', (
      select jsonb_build_object(
        'polizas',            count(*),
        'vigentes',           count(*) filter (where estatus = 'Vigente'),
        'anuladas',           count(*) filter (where estatus = 'Anulada'),
        'con_cotizacion',     coalesce((select sum(polizas_con_cotizacion) from pol), 0),
        'sin_cotizacion',     count(*) - coalesce((select sum(polizas_con_cotizacion) from pol), 0),
        'pct_con_cotizacion', case when count(*) > 0 then round(
              100.0 * coalesce((select sum(polizas_con_cotizacion) from pol), 0) / count(*), 1) end
      ) from v_polizas
    )
  ) into result;

  return result;
end;
$fn$;


drop function if exists zoho_emisiones_analitica(timestamptz, int);

create or replace function zoho_emisiones_analitica(
  p_since timestamptz default null,
  p_maduracion_dias int default 60,
  p_hasta timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result jsonb;
  v_desde date;
  v_hasta date;
begin
  select min(fecha_suscripcion), max(fecha_suscripcion) into v_desde, v_hasta
  from polizas_emitidas
  where (p_since is null or fecha_suscripcion >= p_since::date)
    and (p_hasta is null or fecha_suscripcion < p_hasta::date);

  if v_desde is null then
    return jsonb_build_object(
      'sin_datos', true,
      'mensaje', 'No hay emisiones cargadas en este periodo. Sube el Reporte de Emision.'
    );
  end if;

  with rec as (
    -- Grano recibo, ya filtrado por periodo.
    select * from polizas_emitidas
    where (p_since is null or fecha_suscripcion >= p_since::date)
      and (p_hasta is null or fecha_suscripcion < p_hasta::date)
  ),
  pol as (
    -- Grano poliza. Los campos de poliza son constantes entre sus recibos
    -- (verificado sobre el archivo real), asi que min() actua de "cualquiera".
    select nu_poliza,
           min(estatus) as estatus,
           min(cod_intermediario) as cod_intermediario,
           min(nombre_intermediario) as nombre_intermediario,
           min(fecha_suscripcion) as fecha_suscripcion,
           min(suma_asegurada) as suma_asegurada,
           min(prima_anual) as prima_anual,
           min(plan_pago) as plan_pago,
           min(canal_negocio) as canal_negocio,
           min(cant_beneficiarios) as cant_beneficiarios,
           min(ci_tomador_digitos) as ci_tomador_digitos,
           min(ci_asegurado_digitos) as ci_asegurado_digitos,
           sum(prima_recibo) as prima_recibos,
           sum(comision) as comision
    from rec
    group by nu_poliza
  ),
  -- Cedulas cotizadas en Zoho (lado B2B), para el cruce.
  ced_b2b as (
    select distinct cedula from mv_zoho_clasificacion
    where destino = 'b2b' and cedula is not null
  ),
  pol_cruce as (
    select p.*, (t.cedula is not null or a.cedula is not null) as tiene_cotizacion
    from pol p
    left join ced_b2b t on t.cedula = p.ci_tomador_digitos
    left join ced_b2b a on a.cedula = p.ci_asegurado_digitos
  ),
  -- Desfase cotizar -> emitir: primera cotizacion de esa cedula contra la
  -- fecha de suscripcion. Puede salir negativo (la poliza es anterior a la
  -- cotizacion: renovaciones, o se recotiza despues de emitir) y eso se
  -- reporta aparte en vez de esconderlo en el bucket de 0-7 dias.
  primera_cotiz as (
    select p.nu_poliza, p.fecha_suscripcion,
           min(m.created_time) as primera
    from pol p
    join mv_zoho_clasificacion m
      on m.destino = 'b2b' and m.cedula is not null
     and (m.cedula = p.ci_tomador_digitos or m.cedula = p.ci_asegurado_digitos)
    group by p.nu_poliza, p.fecha_suscripcion
  ),
  desfase as (
    select (fecha_suscripcion - primera::date) as dias from primera_cotiz
  )
  select jsonb_build_object(
    'sin_datos', false,
    'periodo', jsonb_build_object('desde', v_desde, 'hasta', v_hasta),

    -- ── Cifras de cabecera ─────────────────────────────────────────────
    'totales', (
      select jsonb_build_object(
        'polizas',        count(*),
        'recibos',        (select count(*) from rec),
        'vigentes',       count(*) filter (where estatus = 'Vigente'),
        'anuladas',       count(*) filter (where estatus = 'Anulada'),
        'tasa_anulacion', case when count(*) > 0
                               then round(100.0 * count(*) filter (where estatus = 'Anulada') / count(*), 1) end,
        'clientes',       count(distinct coalesce(ci_tomador_digitos, ci_asegurado_digitos)),
        -- Todo el dinero sale de prima_recibo (ver la nota de cabecera).
        'prima_facturada', round(coalesce(sum(prima_recibos), 0)::numeric, 2),
        'prima_vigente',   round(coalesce(sum(prima_recibos) filter (where estatus = 'Vigente'), 0)::numeric, 2),
        'comision',       round(coalesce(sum(comision), 0)::numeric, 2),
        'suma_asegurada', coalesce(sum(suma_asegurada), 0),
        -- Facturado medio por poliza vigente. Depende de la mezcla de planes
        -- de pago del periodo, asi que sirve de magnitud, no de tarifa.
        'ticket_medio',   case when count(*) filter (where estatus = 'Vigente') > 0
                               then round((coalesce(sum(prima_recibos) filter (where estatus = 'Vigente'), 0))::numeric
                                    / count(*) filter (where estatus = 'Vigente'), 2) end
      ) from pol
    ),

    -- ── Cartera: donde esta el dinero ──────────────────────────────────
    'cartera', coalesce((
      select jsonb_agg(jsonb_build_object(
        'estatus',  estatus_recibo,
        'recibos',  n,
        'prima',    prima,
        'comision', comision
      ) order by prima desc)
      from (
        select coalesce(nullif(estatus_recibo, ''), 'sin estatus') as estatus_recibo,
               count(*) as n,
               round(coalesce(sum(prima_recibo), 0)::numeric, 2) as prima,
               round(coalesce(sum(comision), 0)::numeric, 2) as comision
        from rec group by 1
      ) s
    ), '[]'::jsonb),

    -- ── Anulaciones: solo lo que el dato permite afirmar ───────────────
    'anulaciones', (
      select jsonb_build_object(
        'polizas',  count(*) filter (where estatus = 'Anulada'),
        'prima',    round(coalesce(sum(prima_recibos) filter (where estatus = 'Anulada'), 0)::numeric, 2),
        'comision', round(coalesce(sum(comision) filter (where estatus = 'Anulada'), 0)::numeric, 2),
        -- Quien las concentra. Se piden 3 emitidas minimo: con 1 poliza
        -- anulada de 1 emitida la "tasa" es 100% y no dice nada.
        'por_corredor', coalesce((
          select jsonb_agg(x order by (x->>'anuladas')::int desc, x->>'nombre')
          from (
            select jsonb_build_object(
              'nombre',   coalesce(min(nombre_intermediario), 'sin intermediario'),
              'emitidas', count(*),
              'anuladas', count(*) filter (where estatus = 'Anulada'),
              'tasa',     round(100.0 * count(*) filter (where estatus = 'Anulada') / count(*), 1)
            ) as x
            from pol
            group by cod_intermediario
            having count(*) >= 3 and count(*) filter (where estatus = 'Anulada') > 0
            order by count(*) filter (where estatus = 'Anulada') desc
            limit 10
          ) s
        ), '[]'::jsonb),
        'por_plan_pago', coalesce((
          select jsonb_agg(jsonb_build_object('label', plan_pago, 'emitidas', n, 'anuladas', anul, 'tasa', tasa)
                 order by n desc)
          from (
            select coalesce(nullif(plan_pago, ''), 'sin plan') as plan_pago, count(*) as n,
                   count(*) filter (where estatus = 'Anulada') as anul,
                   round(100.0 * count(*) filter (where estatus = 'Anulada') / count(*), 1) as tasa
            from pol group by 1
          ) s
        ), '[]'::jsonb),
        'nota', 'El CSV no trae fecha ni motivo real de anulacion (un unico ' ||
                'valor para todas), asi que no se puede decir cuando ni por que se cayeron.'
      ) from pol
    ),

    -- ── Producto: que se vende y como se paga ──────────────────────────
    'producto', jsonb_build_object(
      'por_suma', coalesce((
        select jsonb_agg(jsonb_build_object(
          'suma', suma_asegurada, 'polizas', n, 'prima_media', prima_media, 'anuladas', anul
        ) order by suma_asegurada)
        from (
          select suma_asegurada, count(*) as n,
                 round(avg(prima_recibos)::numeric, 2) as prima_media,
                 count(*) filter (where estatus = 'Anulada') as anul
          from pol where suma_asegurada is not null group by 1
        ) s
      ), '[]'::jsonb),
      -- Aqui va la prima TOTAL facturada bajo cada plan, no una media: la
      -- media entre planes no se puede comparar (ver nota de cabecera).
      'por_plan_pago', coalesce((
        select jsonb_agg(jsonb_build_object('label', plan_pago, 'polizas', n, 'prima', prima)
               order by n desc)
        from (
          select coalesce(nullif(plan_pago, ''), 'sin plan') as plan_pago, count(*) as n,
                 round(coalesce(sum(prima_recibos), 0)::numeric, 2) as prima
          from pol group by 1
        ) s
      ), '[]'::jsonb),
      'por_beneficiarios', coalesce((
        select jsonb_agg(jsonb_build_object('label', label, 'polizas', n) order by orden)
        from (
          select coalesce(cant_beneficiarios, 0) as orden,
                 coalesce(cant_beneficiarios, 0)::text as label,
                 count(*) as n
          from pol group by 1, 2
        ) s
      ), '[]'::jsonb),
      'nota_prima', 'La prima que se muestra es la FACTURADA en el periodo, no ' ||
                    'una tarifa anual: una poliza mensual lleva facturado 1-2 meses ' ||
                    'y una anual el ano entero, asi que no se comparan entre planes ' ||
                    'de pago.'
    ),

    -- ── Evolucion diaria de la suscripcion ─────────────────────────────
    'diario', coalesce((
      select jsonb_agg(jsonb_build_object('dia', dia, 'polizas', n, 'prima', prima) order by dia)
      from (
        select fecha_suscripcion as dia, count(*) as n,
               round(coalesce(sum(prima_recibos), 0)::numeric, 2) as prima
        from pol where fecha_suscripcion is not null group by 1
      ) s
    ), '[]'::jsonb),

    -- ── Canal de negocio ───────────────────────────────────────────────
    'canal', coalesce((
      select jsonb_agg(jsonb_build_object('label', canal, 'polizas', n, 'prima', prima) order by n desc)
      from (
        select coalesce(nullif(canal_negocio, ''), 'sin canal') as canal, count(*) as n,
               round(coalesce(sum(prima_recibos), 0)::numeric, 2) as prima
        from pol group by 1
      ) s
    ), '[]'::jsonb),

    -- ── Concentracion: quien emite el volumen ──────────────────────────
    'top_corredores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nombre', nombre, 'polizas', n, 'prima', prima, 'comision', comision,
        'anuladas', anul, 'con_cotizacion', con_cotiz
      ) order by prima desc)
      from (
        select coalesce(min(nombre_intermediario), 'sin intermediario') as nombre,
               count(*) as n,
               round(coalesce(sum(prima_recibos), 0)::numeric, 2) as prima,
               round(coalesce(sum(comision), 0)::numeric, 2) as comision,
               count(*) filter (where estatus = 'Anulada') as anul,
               count(*) filter (where tiene_cotizacion) as con_cotiz
        from pol_cruce
        group by cod_intermediario
        order by sum(prima_recibos) desc nulls last
        limit 12
      ) s
    ), '[]'::jsonb),

    -- ── Cruce con lo cotizado (pestana Efectividad) ────────────────────
    'cruce', (
      select jsonb_build_object(
        'polizas',         count(*),
        'con_cotizacion',  count(*) filter (where tiene_cotizacion),
        'sin_cotizacion',  count(*) filter (where not tiene_cotizacion),
        'pct_con',         case when count(*) > 0
                                then round(100.0 * count(*) filter (where tiene_cotizacion) / count(*), 1) end
      ) from pol_cruce
    ),

    -- ── Desfase cotizar -> emitir ──────────────────────────────────────
    'desfase', (
      select jsonb_build_object(
        'n', count(*),
        'mediana', percentile_disc(0.5) within group (order by dias),
        'p25', percentile_disc(0.25) within group (order by dias),
        'p75', percentile_disc(0.75) within group (order by dias),
        'p90', percentile_disc(0.90) within group (order by dias),
        'maximo', max(dias),
        'buckets', jsonb_build_array(
          jsonb_build_object('label', 'antes de cotizar', 'n', count(*) filter (where dias < 0)),
          jsonb_build_object('label', '0-7 dias',   'n', count(*) filter (where dias between 0 and 7)),
          jsonb_build_object('label', '8-30 dias',  'n', count(*) filter (where dias between 8 and 30)),
          jsonb_build_object('label', '31-90 dias', 'n', count(*) filter (where dias between 31 and 90)),
          jsonb_build_object('label', '91+ dias',   'n', count(*) filter (where dias > 90))
        ),
        'nota', 'Dias entre la PRIMERA cotizacion de ese cliente en Zoho y la ' ||
                'suscripcion de la poliza. Los negativos son polizas anteriores a ' ||
                'la cotizacion (renovaciones, o se recotizo despues de emitir).'
      ) from desfase
    ),
    'maduracion_dias', p_maduracion_dias
  ) into result;

  return result;
end;
$fn$;


-- ---------------------------------------------------------------
-- zoho_embudo_resumen: lo que hasta ahora daban v_kpis / v_funnel /
-- v_channel / v_agent, pero acotado a un rango. Las vistas se quedan (las lee
-- el dashboard estático de `dashboard/`); esta función es la que usa
-- /pipeline, que sí filtra.
--
-- `nuevos_7d` / `nuevos_30d` se miden contra el FIN del rango, no contra
-- now(): dentro de una ventana cerrada, "los últimos 7 días" relativos a hoy
-- serían siempre cero y se leería como que no entró nada.
-- ---------------------------------------------------------------
create or replace function zoho_embudo_resumen(
  p_desde timestamptz default null,
  p_hasta timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with base as (
    select t.status, t.monto_prima, t.created_time, t.channel, t.assignee_name,
           ps.stage_order, ps.stage_group, ps.color
    from tickets t
    left join pipeline_stages ps on ps.status = t.status
    where coalesce(t.is_spam, false) = false
      and (p_desde is null or t.created_time >= p_desde)
      and (p_hasta is null or t.created_time <  p_hasta)
  )
  select jsonb_build_object(
    'desde', p_desde,
    'hasta', p_hasta,
    'kpis', (
      select jsonb_build_object(
        'total_tickets', count(*),
        'ganados',       count(*) filter (where b.stage_group = 'ganado'),
        'perdidos',      count(*) filter (where b.stage_group = 'perdido'),
        'nuevos_7d',     count(*) filter (where b.created_time >= coalesce(p_hasta, now()) - interval '7 days'),
        'nuevos_30d',    count(*) filter (where b.created_time >= coalesce(p_hasta, now()) - interval '30 days')
      )
      from base b
    ),
    'funnel', coalesce((
      select jsonb_agg(jsonb_build_object(
               'status', f.status, 'stage_order', f.stage_order,
               'stage_group', f.stage_group, 'color', f.color,
               'tickets', f.tickets, 'total_prima', f.total_prima
             ) order by f.stage_order, f.status)
      from (
        select coalesce(b.status, '(sin etapa)')      as status,
               coalesce(b.stage_order, 999)           as stage_order,
               coalesce(b.stage_group, 'abierto')     as stage_group,
               coalesce(b.color, '#94a3b8')           as color,
               count(*)                               as tickets,
               coalesce(sum(b.monto_prima), 0)        as total_prima
        from base b
        group by 1, 2, 3, 4
      ) f
    ), '[]'::jsonb),
    'channel', coalesce((
      select jsonb_agg(jsonb_build_object('channel', c.channel, 'tickets', c.tickets)
                       order by c.tickets desc, c.channel)
      from (
        select b.channel, count(*) as tickets
        from base b where b.channel is not null
        group by 1
      ) c
    ), '[]'::jsonb),
    'agent', coalesce((
      select jsonb_agg(jsonb_build_object('agente', a.agente, 'tickets', a.tickets)
                       order by a.tickets desc, a.agente)
      from (
        select coalesce(b.assignee_name, 'Sin asignar') as agente, count(*) as tickets
        from base b
        group by 1
        order by 2 desc
        limit 12
      ) a
    ), '[]'::jsonb)
  )
$fn$;


-- ---------------------------------------------------------------
-- Permisos: estas seis son `security definer` y por defecto Postgres las deja
-- ejecutables por PUBLIC, del que hereda `anon`. Se cierran acá y el barrido
-- completo (las 18 que estaban abiertas) va en la 0082.
-- ---------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'zoho_pipeline_overview(timestamptz, timestamptz)',
    'zoho_corredor_detalle(text, timestamptz, timestamptz)',
    'zoho_pipeline_analitica(timestamptz, timestamptz)',
    'zoho_corredores_efectividad(timestamptz, int, timestamptz)',
    'zoho_emisiones_analitica(timestamptz, int, timestamptz)',
    'zoho_embudo_resumen(timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end$$;
