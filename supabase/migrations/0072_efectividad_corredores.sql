-- =============================================================
-- 0072_efectividad_corredores.sql
-- Segunda mitad de la 0071 (que trae las tablas): el mapeo del texto libre de
-- Zoho al codigo canonico del intermediario, y la funcion de efectividad que
-- alimenta la pestana "B2C / B2B por corredor" de /pipeline.
-- =============================================================

-- La mv de clasificacion no tenia indice por cedula (0067 solo indexo id,
-- destino, asesor_norm y created_time) y el cruce contra las polizas la
-- recorria entera. Va aca y no en la 0067 para no reconstruir la vista.
-- OJO: si algun dia se vuelve a hacer `drop materialized view ... cascade`,
-- este indice se va con ella y hay que volver a crearlo.
create index if not exists mv_zoho_clasificacion_cedula
  on mv_zoho_clasificacion (cedula) where cedula is not null;

-- ---------------------------------------------------------------
-- Tokens distintivos de un nombre de corredor.
--
-- Sin quitar las palabras genericas, el parecido por palabras compartidas da
-- falsos positivos graves: "CORRETAJE DE SEGUROS ALFA CA" y "CORRETAJE DE
-- SEGUROS BETA CA" comparten 2 de 3 palabras largas (0,67) y se mapearian al
-- mismo corredor siendo empresas distintas. Quitando el vocabulario del ramo,
-- a ALFA le queda {ALFA} y a BETA {BETA}: cero en comun, no machean.
-- Se exige longitud >= 4 para no colgarse de iniciales ni de "DE"/"CA".
-- ---------------------------------------------------------------
create or replace function zoho_tokens_distintivos(txt text)
returns text[]
language sql
immutable
set search_path = public
as $fn$
  select coalesce(array_agg(distinct t), '{}'::text[])
  from unnest(
    regexp_split_to_array(
      regexp_replace(public.zoho_norm(coalesce(txt, '')), '[^A-Z0-9 ]', ' ', 'g'),
      '\s+')
  ) as t
  where length(t) >= 4
    and t not in (
      'CORRETAJE', 'CORREDURIA', 'CORREDORES', 'SEGUROS', 'SOCIEDAD', 'ASOCIADOS',
      'COMPANIA', 'SERVICIOS', 'INTERMEDIARIOS', 'INTERMEDIARIO', 'INVERSIONES',
      'SUCURSAL', 'AGENCIA', 'CORP', 'GROUP'
    );
$fn$;

-- Parecido entre dos nombres: cuantos tokens distintivos comparten sobre los
-- del nombre mas corto. Asi "BARECA" contra "BARECA SOCIEDAD DE CORRETAJE C A"
-- da 1,0 (el corto esta contenido en el largo) y "ZAID CAPOTE" contra "ZAID
-- MARCEL CAPOTE ROJAS" tambien. Cero tokens en comun => 0, nunca se mapea.
create or replace function zoho_score_corredor(a text, b text)
returns numeric
language sql
immutable
set search_path = public
as $fn$
  with t as (
    select public.zoho_tokens_distintivos(a) as ta,
           public.zoho_tokens_distintivos(b) as tb
  ),
  c as (
    select cardinality(ta) as na, cardinality(tb) as nb,
           (select count(*) from unnest(ta) x where x = any(tb)) as comunes
    from t
  )
  select case
    when na = 0 or nb = 0 or comunes = 0 then 0
    else round(comunes::numeric / least(na, nb), 3)
  end
  from c;
$fn$;

-- ---------------------------------------------------------------
-- Auto-mapeo: propone alias para los asesores de Zoho que aun no tienen.
--
-- No toca los que ya estan mapeados a mano ni los marcados 'rechazado' — la
-- decision del operador manda y no se re-propone en cada carga. Solo escribe
-- cuando hay UN candidato ganador claro: si dos intermediarios empatan con el
-- mismo score, no elige a ciegas (mismo criterio que matchStagesByName con
-- las etapas de Kommo, trampa 9) y lo deja para revision manual.
--
-- RENDIMIENTO: la primera version hacia `pendientes cross join intermediarios`
-- llamando a zoho_score_corredor() en cada par — 1.163 x 174 = 202.000 pares,
-- cada uno con dos regexp_split, y se pasaba del statement timeout sin escribir
-- nada. Ahora los tokens se calculan UNA vez por lado (CTE materializada) y el
-- join se prefiltra con el operador de solapamiento de arrays `&&`, que
-- descarta de golpe los pares sin ninguna palabra en comun. La pasada de
-- trigram queda solo para los que no encontraron nada por token, y usa el
-- indice GIN de intermediarios.nombre_norm.
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

  create temp table _int on commit drop as
  select cod_intermediario, nombre_norm,
         public.zoho_tokens_distintivos(nombre_norm) as t
  from intermediarios;

  -- Pasada 1: palabras distintivas en comun.
  create temp table _puntuado on commit drop as
  select p.asesor_norm, i.cod_intermediario,
         round(
           (select count(*) from unnest(p.t) x where x = any(i.t))::numeric
           / least(cardinality(p.t), cardinality(i.t)), 3) as score
  from _pend p
  join _int i on p.t && i.t
  where cardinality(p.t) > 0 and cardinality(i.t) > 0;

  -- Pasada 2: trigram, solo para los que la pasada 1 dejo sin ningun candidato
  -- (nombres donde hasta la palabra distintiva viene mal escrita).
  insert into _puntuado (asesor_norm, cod_intermediario, score)
  select p.asesor_norm, i.cod_intermediario, similarity(p.asesor_norm, i.nombre_norm)::numeric
  from _pend p
  join _int i on similarity(p.asesor_norm, i.nombre_norm) >= 0.75
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

-- ---------------------------------------------------------------
-- Efectividad por corredor.
--
-- Denominador: las cotizaciones B2B de Zoho del corredor (via alias).
-- Numerador: las que acabaron en poliza VIGENTE del MISMO codigo de
-- intermediario — por decision del operador la emision se acredita al
-- intermediario del sistema central, no al asesor que escribio el ticket.
--
-- LA VENTANA ES LO DELICADO. La primera version marcaba "madura" toda
-- cotizacion de mas de 60 dias contra now(), y daba 0,2% de efectividad: un
-- numero que parecia desempeno catastrofico y era un error de medicion. Con
-- emisiones solo de agosto, las cotizaciones que produjeron esas emisiones son
-- de julio y agosto — o sea MENOS de 60 dias — asi que el filtro descartaba
-- justo la evidencia disponible: de las 342 cotizaciones que cruzaban con una
-- emision de agosto, solo 32 pasaban el corte.
--
-- La madurez tiene que anclarse a la VENTANA DE EMISIONES CARGADAS, no a hoy.
-- Con emisiones observadas en [D, H] solo se puede juzgar una cotizacion si su
-- emision plausible cae dentro de ese rango, es decir si nacio entre
-- D - p_maduracion_dias y H. Fuera de ahi:
--   * anterior a D - maduracion -> lo mas probable es que emitiera ANTES de la
--     ventana; contarla como fallo seria mentir (no hay dato, no es un no).
--   * posterior a H -> todavia no pudo aparecer en el archivo.
-- Reanclada asi, la misma base da 4,8% por cotizaciones y 4,3% por clientes.
--
-- Aun asi el porcentaje es un SUELO, no la cifra final: con un solo mes de
-- emisiones la ventana de cotizaciones (3 meses) es mas ancha que la de
-- emisiones (1 mes), asi que hay cierres reales que no se ven. Se marca como
-- parcial en la respuesta (`parcial`) y se estrecha solo cuando haya mas meses.
--
-- Por eso se devuelve tambien la medida INVERSA, que con un solo mes es la
-- fiable porque no depende de ninguna ventana: de las polizas emitidas en el
-- periodo cargado, cuantas venian de una cotizacion en Zoho
-- (polizas_con_cotizacion / polizas_emitidas). En agosto son 225 de 539.
--
-- Y tres columnas que no son la efectividad pero explican el numero:
--   cerradas_otro         el cliente SI emitio, pero con otro intermediario.
--   cotiz_anuladas        emitio con este corredor y la poliza se anulo.
--   polizas_sin_cotizacion polizas del corredor sin cotizacion previa en Zoho
--                         (vendio sin pasar por Zoho Desk). Es el 58% del
--                         archivo de agosto: sin esta columna el modulo
--                         parece perder datos cuando en realidad es el canal.
-- ---------------------------------------------------------------
create or replace function zoho_corredores_efectividad(
  p_since timestamptz default null,
  p_maduracion_dias int default 60
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

grant execute on function zoho_corredores_efectividad(timestamptz, int) to authenticated, service_role;
grant execute on function zoho_tokens_distintivos(text) to authenticated, service_role;
grant execute on function zoho_score_corredor(text, text) to authenticated, service_role;
