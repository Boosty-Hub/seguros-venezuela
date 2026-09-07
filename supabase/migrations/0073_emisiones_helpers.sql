-- =============================================================
-- 0073_emisiones_helpers.sql
-- Dos ayudantes que necesita /api/pipeline/emisiones (la carga del CSV).
-- =============================================================

-- ---------------------------------------------------------------
-- De una lista de cedulas, cuales existen en los tickets de Zoho.
--
-- Sirve para el PREVIEW: antes de escribir nada, decir cuantas polizas del
-- archivo van a cruzar con una cotizacion. Se hace en la base porque el
-- alternativo era traer las 8.535 cedulas de Zoho al servidor web para
-- intersectarlas en memoria, y PostgREST corta en 1000 filas sin avisar
-- (trampa 5) — habria dado un resultado silenciosamente incompleto.
-- ---------------------------------------------------------------
create or replace function zoho_cedulas_conocidas(p_cedulas text[])
returns text[]
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(array_agg(distinct m.cedula), '{}'::text[])
  from mv_zoho_clasificacion m
  where m.cedula is not null
    and m.cedula = any(p_cedulas);
$fn$;

grant execute on function zoho_cedulas_conocidas(text[]) to authenticated, service_role;

-- ---------------------------------------------------------------
-- Upsert de intermediarios calculando nombre_norm EN LA BASE.
--
-- No se calcula en TypeScript a proposito: nombre_norm solo existe para
-- compararse contra zoho_norm(asesor), y si las dos normalizaciones no son
-- exactamente la misma funcion el mapeo de alias falla en los casos raros
-- (zoho_norm hace translate de un set fijo de acentos; un NFD en JS quita
-- todos los diacriticos, que no es lo mismo). Una sola definicion, en un solo
-- lugar.
--
-- p_rows: [{"cod": "31002", "nombre": "RUIZ CANO Y ASOCIADOS ..."}, ...]
-- ---------------------------------------------------------------
create or replace function emisiones_upsert_intermediarios(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  with entrada as (
    select
      trim(x->>'cod')    as cod,
      trim(x->>'nombre') as nombre
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as x
  ),
  limpia as (
    -- Un mismo codigo repetido en la entrada rompe el ON CONFLICT ("cannot
    -- affect row a second time"), asi que se colapsa antes de escribir.
    select cod, min(nombre) as nombre
    from entrada
    where cod is not null and cod <> '' and nombre is not null and nombre <> ''
    group by cod
  ),
  escrito as (
    insert into intermediarios (cod_intermediario, nombre, nombre_norm, visto_ultimo)
    select cod, nombre, public.zoho_norm(nombre), now()
    from limpia
    on conflict (cod_intermediario) do update
      set nombre      = excluded.nombre,
          nombre_norm = excluded.nombre_norm,
          visto_ultimo = now()
    returning 1
  )
  select count(*) from escrito into n;

  return coalesce(n, 0);
end;
$fn$;

grant execute on function emisiones_upsert_intermediarios(jsonb) to service_role;
