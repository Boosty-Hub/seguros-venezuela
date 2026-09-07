-- =============================================================
-- 0074_alias_corredores_manual.sql
-- Revision manual de los alias de corredor (PENDIENTE 8).
--
-- El auto-mapeo de la 0072 resuelve la mayoria pero deja dos huecos que solo
-- una persona puede cerrar:
--   * AMBIGUOS: dos intermediarios empatan con el mismo parecido. No elige a
--     ciegas a proposito (mismo criterio que matchStagesByName, trampa 9).
--   * SIN CANDIDATO: el nombre de Zoho no se parece a ninguno de los
--     intermediarios conocidos. Con un solo mes cargado son 875 de 1.163 —
--     casi todos corredores que simplemente no emitieron ese mes.
--
-- Estas funciones alimentan el panel "Revisar corredores" de /pipeline. Las
-- escrituras las hace la ruta con service_role sobre corredor_alias; aca solo
-- va la LECTURA, que es la que necesita la logica de puntuacion.
-- =============================================================

-- ---------------------------------------------------------------
-- Candidatos para un nombre de Zoho, ordenados por parecido.
--
-- Devuelve tambien los flojos (por debajo del umbral del auto-mapeo) porque el
-- panel los muestra como sugerencia: el humano decide con el nombre delante.
-- Sin `limit` esto seria un cross join contra los 174 intermediarios por cada
-- nombre; con el prefiltro de solapamiento de arrays sale barato.
-- ---------------------------------------------------------------
create or replace function zoho_alias_candidatos(p_asesor_norm text, p_limite int default 6)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with t as (
    select public.zoho_tokens_distintivos(p_asesor_norm) as tp
  ),
  puntuado as (
    select i.cod_intermediario, i.nombre,
           greatest(
             case when cardinality(t.tp) > 0 and cardinality(public.zoho_tokens_distintivos(i.nombre_norm)) > 0
                  then round(
                    (select count(*) from unnest(t.tp) x
                      where x = any(public.zoho_tokens_distintivos(i.nombre_norm)))::numeric
                    / least(cardinality(t.tp), cardinality(public.zoho_tokens_distintivos(i.nombre_norm))), 3)
                  else 0 end,
             round(similarity(p_asesor_norm, i.nombre_norm)::numeric, 3)
           ) as score
    from intermediarios i, t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'cod', cod_intermediario, 'nombre', nombre, 'score', score
         ) order by score desc, nombre), '[]'::jsonb)
  from (select * from puntuado where score > 0 order by score desc, nombre limit p_limite) s;
$fn$;

grant execute on function zoho_alias_candidatos(text, int) to authenticated, service_role;

-- ---------------------------------------------------------------
-- Nombres de Zoho SIN alias (o rechazados), con sus candidatos.
--
-- Ordenados por volumen de cotizaciones: mapear el que trae 500 cotizaciones
-- mueve la aguja, mapear el que trae 1 no. Asi la revision manual empieza por
-- donde importa en vez de por orden alfabetico.
-- ---------------------------------------------------------------
create or replace function zoho_alias_pendientes(
  p_busqueda text default null,
  p_limite int default 25,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result jsonb;
begin
  with base as (
    select m.asesor_norm,
           min(m.asesor_original) as asesor_muestra,
           count(*) as cotizaciones,
           count(distinct m.cliente_key) as clientes,
           max(m.created_time) as ultima,
           (select a.origen from corredor_alias a where a.asesor_norm = m.asesor_norm) as origen
    from mv_zoho_clasificacion m
    where m.destino = 'b2b'
      and m.asesor_norm is not null
      and (p_busqueda is null or p_busqueda = '' or m.asesor_norm ilike '%' || p_busqueda || '%')
    group by m.asesor_norm
  ),
  -- Pendiente = sin alias, o con uno marcado 'rechazado' (que el operador ya
  -- descarto pero sigue sin corredor real asignado).
  pend as (
    select * from base where origen is null or origen = 'rechazado'
  ),
  pagina as (
    select * from pend order by cotizaciones desc, asesor_norm limit p_limite offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from pend),
    'filas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'asesor_norm',   p.asesor_norm,
        'asesor_muestra', p.asesor_muestra,
        'cotizaciones',  p.cotizaciones,
        'clientes',      p.clientes,
        'ultima',        p.ultima,
        'rechazado',     (p.origen = 'rechazado'),
        'candidatos',    public.zoho_alias_candidatos(p.asesor_norm, 5)
      ) order by p.cotizaciones desc, p.asesor_norm)
      from pagina p
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$fn$;

grant execute on function zoho_alias_pendientes(text, int, int) to authenticated, service_role;

-- ---------------------------------------------------------------
-- Alias ya asignados, para poder auditarlos y corregirlos.
--
-- Los 'auto' son los que conviene revisar: un mapeo automatico equivocado es
-- peor que ninguno, porque le acredita a un corredor las polizas de otro.
-- ---------------------------------------------------------------
create or replace function zoho_alias_asignados(
  p_busqueda text default null,
  p_solo_auto boolean default false,
  p_limite int default 50,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result jsonb;
begin
  with vol as (
    select asesor_norm, count(*) as cotizaciones
    from mv_zoho_clasificacion
    where destino = 'b2b' and asesor_norm is not null
    group by asesor_norm
  ),
  base as (
    select a.asesor_norm, a.cod_intermediario, a.origen, a.similitud,
           i.nombre as nombre_canonico,
           coalesce(v.cotizaciones, 0) as cotizaciones
    from corredor_alias a
    join intermediarios i on i.cod_intermediario = a.cod_intermediario
    left join vol v on v.asesor_norm = a.asesor_norm
    where a.origen <> 'rechazado'
      and (not p_solo_auto or a.origen = 'auto')
      and (p_busqueda is null or p_busqueda = ''
           or a.asesor_norm ilike '%' || p_busqueda || '%'
           or i.nombre ilike '%' || p_busqueda || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'filas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'asesor_norm',     b.asesor_norm,
        'cod_intermediario', b.cod_intermediario,
        'nombre_canonico', b.nombre_canonico,
        'origen',          b.origen,
        'similitud',       b.similitud,
        'cotizaciones',    b.cotizaciones
      ) order by b.cotizaciones desc, b.asesor_norm)
      from (select * from base order by cotizaciones desc, asesor_norm limit p_limite offset p_offset) b
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$fn$;

grant execute on function zoho_alias_asignados(text, boolean, int, int) to authenticated, service_role;

-- ---------------------------------------------------------------
-- Buscador de intermediarios, para asignar uno que no salga sugerido.
-- ---------------------------------------------------------------
create or replace function zoho_intermediarios_buscar(p_busqueda text default null, p_limite int default 20)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'cod', cod_intermediario, 'nombre', nombre) order by nombre), '[]'::jsonb)
  from (
    select cod_intermediario, nombre
    from intermediarios
    where p_busqueda is null or p_busqueda = '' or nombre ilike '%' || p_busqueda || '%'
    order by nombre
    limit p_limite
  ) s;
$fn$;

grant execute on function zoho_intermediarios_buscar(text, int) to authenticated, service_role;
