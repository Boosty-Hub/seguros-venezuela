-- =============================================================
-- 0076_alias_tokens_raros.sql
-- Calidad del mapeo de corredores: exigir una palabra POCO COMUN compartida.
--
-- El problema, visto en el panel: "JOSE SAYEGH" salia emparejado al 50% con
-- "ALBERTO JOSE MEJIAS URRIBARRI" solo por compartir "JOSE". Medido sobre los
-- 174 intermediarios, "JOSE" aparece en 27 de ellos (15,5%); "GARCIA" en 11,
-- "LUIS" en 8, "GONZALEZ"/"RODRIGUEZ"/"MARTINEZ"/"HERNANDEZ" en 6-7. Compartir
-- una de esas no dice nada: son nombres de pila y apellidos frecuentisimos.
--
-- El riesgo no es cosmetico. Un candidato del 50% invita a un clic, y ligar el
-- alias equivocado acredita a un corredor las polizas de otro — peor que no
-- mapear nada, porque el numero resultante parece bueno y es falso.
--
-- Regla: para que dos nombres se consideren candidatos tienen que compartir al
-- menos UNA palabra poco comun (presente en 3 intermediarios o menos). El
-- score sigue contando todas las compartidas, asi que "ZAID CAPOTE" vs "ZAID
-- MARCEL CAPOTE ROJAS" sigue dando 1,0 (ZAID y CAPOTE son raras), pero "JOSE
-- SAYEGH" vs "ALBERTO JOSE MEJIAS" pasa a 0 y desaparece.
--
-- El umbral de "comun" se calcula sobre la tabla, no con una lista fija de
-- nombres: al cargar mas meses entran mas intermediarios y lo que es raro hoy
-- puede dejar de serlo. Una lista a mano se queda vieja en silencio.
-- =============================================================

-- Palabras demasiado frecuentes entre los intermediarios para identificar a
-- nadie. Se recalcula en cada llamada; son 174 filas, cuesta nada.
create or replace function zoho_tokens_comunes(p_min_apariciones int default 4)
returns text[]
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(array_agg(t), '{}'::text[])
  from (
    select t
    from intermediarios, unnest(nombre_tokens) as t
    group by t
    having count(*) >= p_min_apariciones
  ) s;
$fn$;

grant execute on function zoho_tokens_comunes(int) to authenticated, service_role;

-- ---------------------------------------------------------------
-- Candidatos, exigiendo una palabra rara compartida.
-- ---------------------------------------------------------------
create or replace function zoho_alias_candidatos(p_asesor_norm text, p_limite int default 6)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with t as (
    select public.zoho_tokens_distintivos(p_asesor_norm) as tp,
           public.zoho_tokens_comunes(4) as comunes
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
      -- Al menos una palabra compartida que NO sea de las frecuentes.
      and exists (
        select 1 from unnest(t.tp) x
        where x = any(i.nombre_tokens) and not (x = any(t.comunes))
      )
  ),
  por_trigram as (
    -- El trigram compara el nombre entero, asi que no sufre el problema de la
    -- palabra comun; se sube el corte a 0,45 para que solo rescate typos.
    select i.cod_intermediario, i.nombre,
           round(similarity(p_asesor_norm, i.nombre_norm)::numeric, 3) as score
    from intermediarios i
    where similarity(p_asesor_norm, i.nombre_norm) >= 0.45
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
-- El auto-mapeo, con la misma exigencia.
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
  v_comunes text[];
begin
  v_comunes := public.zoho_tokens_comunes(4);

  create temp table _pend on commit drop as
  select distinct m.asesor_norm,
         public.zoho_tokens_distintivos(m.asesor_norm) as t
  from mv_zoho_clasificacion m
  where m.destino = 'b2b'
    and m.asesor_norm is not null
    and not exists (select 1 from corredor_alias a where a.asesor_norm = m.asesor_norm);

  select count(*) from _pend into pendientes_n;

  -- Pasada 1: palabras compartidas, con al menos una poco comun.
  create temp table _puntuado on commit drop as
  select p.asesor_norm, i.cod_intermediario,
         round(
           (select count(*) from unnest(p.t) x where x = any(i.nombre_tokens))::numeric
           / least(cardinality(p.t), cardinality(i.nombre_tokens)), 3) as score
  from _pend p
  join intermediarios i on i.nombre_tokens && p.t
  where cardinality(p.t) > 0
    and coalesce(cardinality(i.nombre_tokens), 0) > 0
    and exists (
      select 1 from unnest(p.t) x
      where x = any(i.nombre_tokens) and not (x = any(v_comunes))
    );

  -- Pasada 2: trigram para los typos, solo si la pasada 1 no dio nada.
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
