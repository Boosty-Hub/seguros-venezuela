-- =============================================================
-- 0065_zoho_cliente_cedula_y_titular.sql
-- Corrige la identidad de CLIENTE en la vista B2B: cédula + titular, no cédula
-- sola.
--
-- Por qué: 0064 agrupaba los clientes solo por la cédula del asunto. Medido
-- contra los datos reales, muchos corredores rellenan ese campo con una cédula
-- de mentira para sacar la cotización rápido, y todas caen en el mismo saco:
--
--     cédula 12345678  -> 241 cotizaciones de 153 titulares DISTINTOS
--     cédula 124578963 -> 298 cotizaciones de 122 titulares distintos
--     cédula 11111111  -> 170 cotizaciones de 109 titulares distintos
--
-- Es decir: 177 "clientes" que en realidad eran cientos de personas fusionadas,
-- arrastrando 2.691 cotizaciones — el 23% del B2B. La vista mostraba "un
-- cliente con 241 cotizaciones" donde había 153 personas sin relación.
--
-- La corrección es sumar el titular a la llave. Comprobado que respeta los dos
-- casos que motivaron el diseño original:
--   - ANDREA: misma cédula, mismo titular, edades 15/45/53/57/62 -> sigue
--     siendo UN cliente (grupo familiar). El titular no los separa.
--   - YESENIA: 7 cédulas distintas con titular "DIRECTO" -> siguen siendo 7
--     personas. La cédula ya las separaba.
-- Efecto: 6.215 -> 8.213 clientes B2B.
--
-- Lo que NO arregla (y no tiene arreglo desde acá): cotizaciones cargadas con
-- titular basura — "XXXX", "BBBBBBB", "ASASAS". Ahí no hay identidad que
-- recuperar; se corrige llenando bien el formulario en Zoho.
-- =============================================================

-- Llave de cliente. Sin cédula no se puede afirmar que dos tickets sean la
-- misma persona: cada uno queda como su propio cliente en vez de fusionarlos
-- mal.
create or replace function zoho_cliente_key(subject text, titular text, ticket_id text)
returns text
language sql
immutable
as $$
  select coalesce(
    zoho_cedula(subject) || '|' || coalesce(zoho_norm(titular), ''),
    'sc:' || coalesce(ticket_id, '')
  );
$$;

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
    select
      t.*,
      zoho_destino(t.asesor) as destino,
      zoho_norm(t.asesor) as asesor_norm,
      zoho_cedula(t.subject) as cedula,
      zoho_cliente_key(t.subject, t.titular, t.id::text) as cliente_key
    from tickets t
    where t.is_spam is false
      and (p_since is null or t.created_time >= p_since)
  ),
  totales as (
    select
      destino,
      count(*) as tickets,
      count(*) filter (where kommo_lead_id is not null) as en_kommo,
      count(distinct cliente_key) as clientes
    from base
    group by destino
  ),
  -- Un corredor = un asesor normalizado.
  corredores as (
    select
      asesor_norm,
      min(asesor) as asesor_muestra,
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
    select
      t.*,
      zoho_cedula(t.subject) as cedula,
      zoho_cliente_key(t.subject, t.titular, t.id::text) as cliente_key
    from tickets t
    where t.is_spam is false
      and zoho_destino(t.asesor) = 'b2b'
      and zoho_norm(t.asesor) = zoho_norm(p_asesor)
      and (p_since is null or t.created_time >= p_since)
  ),
  cotis as (
    select
      cliente_key,
      cedula,
      jsonb_agg(jsonb_build_object(
        'id', id,
        'ticket_number', ticket_number,
        'subject', subject,
        'plan', plan_hcm,
        'edad', edad,
        'prima', monto_prima,
        'moneda', moneda,
        'status', status,
        'status_type', status_type,
        'creado', created_time,
        'web_url', web_url,
        'en_kommo', (kommo_lead_id is not null)
      ) order by created_time desc) as cotizaciones,
      count(*) as n_cotizaciones,
      max(created_time) as ultima,
      -- Etiqueta legible: el titular más reciente que no sea basura.
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
        'cedula', cedula,
        'titular', titular,
        'email', email,
        'telefono', telefono,
        'n_cotizaciones', n_cotizaciones,
        'ultima', ultima,
        'cotizaciones', cotizaciones
      ) order by n_cotizaciones desc, ultima desc)
      from cotis
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

grant execute on function zoho_cliente_key(text, text, text) to authenticated, service_role;
grant execute on function zoho_pipeline_overview(timestamptz) to authenticated, service_role;
grant execute on function zoho_corredor_detalle(text, timestamptz) to authenticated, service_role;
