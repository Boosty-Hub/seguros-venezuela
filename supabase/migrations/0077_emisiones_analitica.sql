-- =============================================================
-- 0077_emisiones_analitica.sql
-- Analitica de las polizas emitidas, para la pestana "Emisiones" del panel de
-- /pipeline. Companera de zoho_pipeline_analitica() (0066), que cubre las
-- cotizaciones.
--
-- DOS COSAS QUE EL CSV NO PERMITE MEDIR, y que por eso no estan aqui:
--
--   * "A cuantos dias se anulo la poliza". No hay fecha de anulacion. Se probo
--     usar fecha_emision_recibo del recibo anulado y no sirve: en las anuladas
--     va a 1,7 dias de media de la suscripcion (0 en la mayoria), o sea que
--     refleja cuando se emitio el recibo, no cuando se cayo la poliza.
--   * "Por que se anulo". Motivo_Anulacion trae un unico valor
--     ("Anulacion De Certificado") en las 79 anuladas de agosto: un grafico
--     por motivo seria una sola barra.
--
-- Si el sistema central puede exportar la fecha y el motivo real de anulacion,
-- las dos se vuelven calculables sin tocar nada mas que esta funcion.
--
-- OJO CON `Prima_Anual`: EL NOMBRE MIENTE. No es una prima anualizada, es lo
-- FACTURADO de esa poliza en el archivo. Comprobado de dos formas:
--   * A igual suma asegurada ($50.000) vale 130 en plan Mensual y 730 en
--     Anual. Si fuera anual serian parecidas.
--   * prima_anual / suma(prima_recibo de la poliza) = 1,000 EXACTO en todos
--     los grupos (por plan de pago y por numero de recibos).
-- O sea que es redundante con sum(prima_recibo) y no es comparable entre
-- planes de pago, porque una poliza mensual suscrita en agosto lleva
-- facturado 1-2 meses y una anual lleva el ano entero. Por eso aqui NO se
-- usa: todo el dinero sale de prima_recibo, que es verificable y se llama
-- como lo que es. Publicar "prima media por plan de pago" con este campo
-- daria una comparacion falsa (mensual 135 vs anual 1.018) que parece un
-- hallazgo de negocio y es un artefacto de la ventana de facturacion.
-- =============================================================

create or replace function zoho_emisiones_analitica(
  p_since timestamptz default null,
  p_maduracion_dias int default 60
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
  where p_since is null or fecha_suscripcion >= p_since::date;

  if v_desde is null then
    return jsonb_build_object(
      'sin_datos', true,
      'mensaje', 'No hay emisiones cargadas en este periodo. Sube el Reporte de Emision.'
    );
  end if;

  with rec as (
    -- Grano recibo, ya filtrado por periodo.
    select * from polizas_emitidas
    where p_since is null or fecha_suscripcion >= p_since::date
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

grant execute on function zoho_emisiones_analitica(timestamptz, int) to authenticated, service_role;
