-- =============================================================
-- 0064_zoho_pipeline_b2c_b2b.sql
-- Vista del pipeline de Zoho por DESTINO: lo que va al agente (B2C) vs lo que
-- va al embudo de corredores (B2B), con el detalle B2B agrupado por
-- Corredor → Cliente → cotizaciones.
--
-- Por qué existe: en Zoho entran dos cosas distintas mezcladas. Un cliente
-- final pidiendo una cotización (va al agente, B2C) y un corredor de seguros
-- tramitando a SUS clientes (va al embudo B2B). Para el negocio, lo segundo
-- se lee por intermediario: qué corredor manda cuánto y a quién.
--
-- Tres decisiones de modelado, cada una medida contra los datos reales:
--
-- 1. CLASIFICACIÓN: misma regla que la migración a Kommo (sync/lib/supa.mjs y
--    zoho-kommo-push). Se centraliza acá en `zoho_destino()` para que la vista
--    no pueda desincronizarse de lo que realmente se migra.
--
-- 2. IDENTIDAD DEL CORREDOR: el campo `asesor` es texto libre y trae el mismo
--    corredor escrito de varias formas — "Luis Avila Merino" / "LUIS AVILA
--    MERINO" / "Luis avila Merino" eran 3 filas distintas con 161 cotizaciones
--    repartidas. Se normaliza (mayúsculas, acentos, espacios): 659 variantes
--    crudas → 483 corredores reales.
--
-- 3. IDENTIDAD DEL CLIENTE: NO se usa `titular`, se usa la CÉDULA del asunto.
--    Comprobado con casos reales:
--      - asesor YESENIA: 7 cotizaciones con titular "DIRECTO" pero 7 cédulas
--        distintas → son 7 personas, agrupar por titular las fusionaba.
--      - asesor ANDREA: 7 cotizaciones con la MISMA cédula V-27107166 y edades
--        15/45/53/57/62/35/25 → es un grupo familiar, un solo cliente.
--    La cédula se extrae del asunto en el 100% de los tickets B2B.
--    El titular se conserva solo como etiqueta legible.
-- =============================================================

-- Normalizador de texto: mayúsculas, sin acentos, espacios colapsados.
create or replace function zoho_norm(txt text)
returns text
language sql
immutable
as $$
  select nullif(upper(trim(regexp_replace(
    translate(coalesce(txt,''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'),
    '\s+', ' ', 'g'))), '');
$$;

-- Cédula del asunto ("Cotización Salud Individual | C.I: V-27107166"),
-- devuelta solo con dígitos para que V-27.107.166 y V27107166 sean la misma.
create or replace function zoho_cedula(subject text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(
    coalesce(substring(coalesce(subject,'') from 'C\.?I\.?:?\s*([VvEeJjGg]?-?\s*[0-9\.]{5,})'), ''),
    '[^0-9]', '', 'g'), '');
$$;

-- Destino de un ticket según su campo Asesor. Misma regla que la migración.
create or replace function zoho_destino(asesor text)
returns text
language sql
immutable
as $$
  select case
    when coalesce(asesor,'') = '' then 'sin_atribucion'
    when asesor ilike '%no%tengo%'
      or asesor ilike '%sin%asesor%'
      or asesor ilike '%seguros%venezuela%'
      or asesor ilike '%directo%caracas%'
      or asesor ilike '%no%posee%' then 'b2c'
    else 'b2b'
  end;
$$;

-- ---------------------------------------------------------------
-- Resumen: totales por destino + ranking de corredores.
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
    select
      t.*,
      zoho_destino(t.asesor) as destino,
      zoho_norm(t.asesor) as asesor_norm,
      zoho_cedula(t.subject) as cedula
    from tickets t
    where t.is_spam is false
      and (p_since is null or t.created_time >= p_since)
  ),
  totales as (
    select
      destino,
      count(*) as tickets,
      count(*) filter (where kommo_lead_id is not null) as en_kommo,
      count(distinct coalesce(cedula, 'sc:' || id::text)) as clientes
    from base
    group by destino
  ),
  -- Un corredor = un asesor normalizado. Dentro, los clientes se cuentan por
  -- cédula (los que no la traen cuentan como cliente propio, no se fusionan).
  corredores as (
    select
      asesor_norm,
      min(asesor) as asesor_muestra,
      count(*) as cotizaciones,
      count(distinct coalesce(cedula, 'sc:' || id::text)) as clientes,
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

-- ---------------------------------------------------------------
-- Detalle de UN corredor: sus clientes y, dentro de cada uno, todas sus
-- cotizaciones. Se carga bajo demanda al desplegar el corredor — traer los
-- 483 con su detalle completo de una vez sería un payload enorme.
-- ---------------------------------------------------------------
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
      -- Sin cédula no se puede afirmar que dos tickets sean la misma persona:
      -- cada uno queda como su propio cliente en vez de fusionarlos mal.
      coalesce(zoho_cedula(t.subject), 'sc:' || t.id::text) as cliente_key
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
