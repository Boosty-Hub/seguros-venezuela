-- =============================================================
-- 0067_zoho_clasificacion_materializada.sql
-- Precalcula la clasificación de cada ticket (destino, corredor, cliente) en
-- una vista materializada, para que /pipeline no la recalcule en cada carga.
--
-- Medido antes de este cambio:
--   zoho_pipeline_overview()  1.021 ms · 174 KB
--   una sola agregación       468 ms — Seq Scan sobre 14.427 filas
--                             recalculando los regex de cédula y las 5
--                             comparaciones `ilike` del asesor POR FILA.
--   10 llamadas concurrentes  5.874 ms en total: se serializan, porque cada
--                             una consume ~1s de CPU de la base.
-- Con /pipeline ahora como pestaña por defecto, ese costo lo paga cada visita.
--
-- Por qué materializada y NO columnas generadas: las reglas de clasificación
-- cambian (ya pasó — hubo que agregar "Directo Caracas" y "No Posee" al filtro
-- B2C). Una columna generada no se recalcula sola al cambiar la función y
-- quedaría mintiendo en silencio; una vista materializada se refresca y listo.
--
-- Frescura: se refresca junto al sync de Zoho (cada 5 min), que es justo cada
-- cuánto puede haber datos nuevos. No se pierde nada.
--
-- La vista guarda SOLO la clasificación. El detalle de cada cotización se lee
-- de `tickets` con un join, así que lo que se muestra ticket por ticket sigue
-- siendo el dato vivo.
-- =============================================================

-- Las funciones anidadas se califican con el esquema. Sin esto, al crear la
-- vista materializada fallaba con "function zoho_cedula(text) does not exist":
-- la definición de una vista se resuelve con el search_path de quien la crea,
-- que no siempre incluye `public`.
create or replace function zoho_cliente_key(subject text, titular text, ticket_id text)
returns text
language sql
immutable
as $$
  select coalesce(
    public.zoho_cedula(subject) || '|' || coalesce(public.zoho_norm(titular), ''),
    'sc:' || coalesce(ticket_id, '')
  );
$$;

drop materialized view if exists mv_zoho_clasificacion cascade;

create materialized view mv_zoho_clasificacion as
select
  t.id,
  public.zoho_destino(t.asesor)                                   as destino,
  public.zoho_norm(t.asesor)                                      as asesor_norm,
  t.asesor                                                 as asesor_original,
  public.zoho_cedula(t.subject)                                   as cedula,
  public.zoho_cliente_key(t.subject, t.titular, t.id::text)       as cliente_key,
  t.created_time,
  t.kommo_lead_id
from tickets t
where t.is_spam is false;

-- El índice único es obligatorio para poder refrescar CONCURRENTLY (sin él,
-- cada refresco bloquea las lecturas y la página se cuelga un segundo).
create unique index mv_zoho_clasificacion_id on mv_zoho_clasificacion (id);
create index mv_zoho_clasificacion_destino on mv_zoho_clasificacion (destino);
create index mv_zoho_clasificacion_asesor on mv_zoho_clasificacion (asesor_norm) where destino = 'b2b';
create index mv_zoho_clasificacion_creado on mv_zoho_clasificacion (created_time);

grant select on mv_zoho_clasificacion to authenticated, service_role;

-- Refresco. CONCURRENTLY para no bloquear lecturas; si la vista nunca se
-- pobló, CONCURRENTLY falla, así que la primera vez cae al refresco normal.
create or replace function zoho_refrescar_clasificacion()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently mv_zoho_clasificacion;
exception when others then
  refresh materialized view mv_zoho_clasificacion;
end;
$$;

grant execute on function zoho_refrescar_clasificacion() to service_role;

-- ---------------------------------------------------------------
-- Las tres funciones de /pipeline, ahora leyendo la vista.
-- ---------------------------------------------------------------

create or replace function zoho_pipeline_overview(p_since timestamptz default null)
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
    where p_since is null or created_time >= p_since
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

create or replace function zoho_corredor_detalle(p_asesor text, p_since timestamptz default null)
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
    where p_since is null or c.created_time >= p_since
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

grant execute on function zoho_pipeline_overview(timestamptz) to authenticated, service_role;
grant execute on function zoho_corredor_detalle(text, timestamptz) to authenticated, service_role;
grant execute on function zoho_pipeline_analitica(timestamptz) to authenticated, service_role;

-- Refresco periódico, alineado con el sync de Zoho (que corre cada 5 min).
select cron.unschedule('zoho-refrescar-clasificacion')
where exists (select 1 from cron.job where jobname = 'zoho-refrescar-clasificacion');

select cron.schedule(
  'zoho-refrescar-clasificacion',
  '3-59/5 * * * *',   -- un minuto despues del sync, para tomar lo recien traido
  $$select zoho_refrescar_clasificacion();$$
);
