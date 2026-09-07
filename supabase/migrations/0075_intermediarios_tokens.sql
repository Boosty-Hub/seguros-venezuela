-- =============================================================
-- 0075_intermediarios_tokens.sql
-- Rendimiento del panel "Revisar corredores".
--
-- zoho_alias_pendientes() tardaba 1,77 s en devolver 25 filas, que en una
-- ventana modal se ve como un spinner que no acaba. La culpa no era el volumen
-- (174 intermediarios) sino recalcular con regex los tokens de TODOS ellos por
-- cada nombre evaluado — y tres veces por candidato, porque
-- zoho_tokens_distintivos(i.nombre_norm) aparecia tres veces en la misma
-- expresion y Postgres no la memoiza.
--
-- Los tokens de un intermediario solo cambian cuando cambia su nombre, o sea
-- en la carga mensual. Se guardan en columna y el scoring pasa a ser un
-- solapamiento de arrays sin una sola llamada a regex.
-- =============================================================

alter table intermediarios add column if not exists nombre_tokens text[];

-- Backfill de lo ya cargado.
update intermediarios
set nombre_tokens = public.zoho_tokens_distintivos(nombre_norm)
where nombre_tokens is null;

alter table intermediarios alter column nombre_tokens set default '{}'::text[];

-- GIN para que el prefiltro `&&` use indice en vez de recorrer la tabla.
create index if not exists intermediarios_tokens_gin on intermediarios using gin (nombre_tokens);

-- ---------------------------------------------------------------
-- El upsert de la carga mantiene la columna al dia.
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
    select trim(x->>'cod') as cod, trim(x->>'nombre') as nombre
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
    insert into intermediarios (cod_intermediario, nombre, nombre_norm, nombre_tokens, visto_ultimo)
    select cod, nombre, public.zoho_norm(nombre),
           public.zoho_tokens_distintivos(public.zoho_norm(nombre)), now()
    from limpia
    on conflict (cod_intermediario) do update
      set nombre        = excluded.nombre,
          nombre_norm   = excluded.nombre_norm,
          nombre_tokens = excluded.nombre_tokens,
          visto_ultimo  = now()
    returning 1
  )
  select count(*) from escrito into n;

  return coalesce(n, 0);
end;
$fn$;

grant execute on function emisiones_upsert_intermediarios(jsonb) to service_role;

-- ---------------------------------------------------------------
-- Candidatos, ahora sin regex por fila.
--
-- Dos pasadas unidas: la de tokens (con prefiltro `&&`, que descarta de golpe
-- los que no comparten ninguna palabra) y la de trigram para los typos. Sin el
-- prefiltro esto seguia siendo un recorrido completo por cada nombre.
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
  por_token as (
    select i.cod_intermediario, i.nombre,
           round(
             (select count(*) from unnest(t.tp) x where x = any(i.nombre_tokens))::numeric
             / least(cardinality(t.tp), cardinality(i.nombre_tokens)), 3) as score
    from intermediarios i, t
    where cardinality(t.tp) > 0
      and coalesce(cardinality(i.nombre_tokens), 0) > 0
      and i.nombre_tokens && t.tp
  ),
  por_trigram as (
    select i.cod_intermediario, i.nombre,
           round(similarity(p_asesor_norm, i.nombre_norm)::numeric, 3) as score
    from intermediarios i
    where similarity(p_asesor_norm, i.nombre_norm) >= 0.3
  ),
  unido as (
    select cod_intermediario, nombre, max(score) as score
    from (select * from por_token union all select * from por_trigram) u
    where score > 0
    group by cod_intermediario, nombre
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'cod', cod_intermediario, 'nombre', nombre, 'score', score
         ) order by score desc, nombre), '[]'::jsonb)
  from (select * from unido order by score desc, nombre limit p_limite) s;
$fn$;

grant execute on function zoho_alias_candidatos(text, int) to authenticated, service_role;

-- ---------------------------------------------------------------
-- El auto-mapeo tambien usa la columna en vez de recalcular.
-- ---------------------------------------------------------------
create or replace function zoho_mapear_corredores(p_umbral numeric default 0.6)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  nuevos int := 0;
  ambiguos int := 0;
  sin_candidato int := 0;
  pendientes_n int := 0;
begin
  create temp table _pend on commit drop as
  select distinct m.asesor_norm,
         public.zoho_tokens_distintivos(m.asesor_norm) as t
  from mv_zoho_clasificacion m
  where m.destino = 'b2b'
    and m.asesor_norm is not null
    and not exists (select 1 from corredor_alias a where a.asesor_norm = m.asesor_norm);

  select count(*) from _pend into pendientes_n;

  -- Pasada 1: palabras distintivas en comun (prefiltro por solapamiento).
  create temp table _puntuado on commit drop as
  select p.asesor_norm, i.cod_intermediario,
         round(
           (select count(*) from unnest(p.t) x where x = any(i.nombre_tokens))::numeric
           / least(cardinality(p.t), cardinality(i.nombre_tokens)), 3) as score
  from _pend p
  join intermediarios i on i.nombre_tokens && p.t
  where cardinality(p.t) > 0 and coalesce(cardinality(i.nombre_tokens), 0) > 0;

  -- Pasada 2: trigram, solo para los que la pasada 1 dejo sin ningun candidato
  -- (nombres donde hasta la palabra distintiva viene mal escrita).
  insert into _puntuado (asesor_norm, cod_intermediario, score)
  select p.asesor_norm, i.cod_intermediario, similarity(p.asesor_norm, i.nombre_norm)::numeric
  from _pend p
  join intermediarios i on similarity(p.asesor_norm, i.nombre_norm) >= 0.75
  where not exists (select 1 from _puntuado q where q.asesor_norm = p.asesor_norm);

  with mejor as (
    select asesor_norm, max(score) as score
    from _puntuado
    where score >= p_umbral
    group by asesor_norm
  ),
  ganador as (
    select m.asesor_norm, m.score,
           (select count(distinct q.cod_intermediario) from _puntuado q
             where q.asesor_norm = m.asesor_norm and q.score = m.score) as empates,
           (select min(q.cod_intermediario) from _puntuado q
             where q.asesor_norm = m.asesor_norm and q.score = m.score) as cod
    from mejor m
  ),
  insertados as (
    insert into corredor_alias (asesor_norm, cod_intermediario, origen, similitud)
    select asesor_norm, cod, 'auto', score from ganador where empates = 1
    on conflict (asesor_norm) do nothing
    returning 1
  )
  select
    (select count(*) from insertados),
    (select count(*) from ganador where empates > 1),
    pendientes_n - (select count(*) from mejor)
  into nuevos, ambiguos, sin_candidato;

  return jsonb_build_object(
    'alias_nuevos', nuevos,
    'ambiguos', ambiguos,
    'sin_candidato', sin_candidato,
    'pendientes', pendientes_n,
    'umbral', p_umbral
  );
end;
$fn$;

grant execute on function zoho_mapear_corredores(numeric) to service_role;
