-- =============================================================
-- 0083_emisiones_periodos.sql
-- Qué hay cargado de emisiones, mes a mes.
--
-- POR QUÉ. Hasta ahora el módulo de emisiones era ciego al calendario: se
-- cargaba el CSV de un mes y el panel mostraba "460 vigentes / 79 anuladas"
-- sin decir de cuándo. Con un solo mes cargado (agosto) se sobreentendía; en
-- cuanto entre septiembre, los números se suman y nadie sabe qué está mirando.
-- Esta función dice qué meses hay y con cuánto, y es lo que alimenta el
-- selector de periodo del panel.
--
-- El grano es la PÓLIZA, no el recibo: `v_polizas` ya colapsa los recibos de
-- una misma póliza (trampa 27 — el CSV viene a grano recibo y contar filas
-- infla el resultado un 21%).
--
-- La fecha es `fecha_suscripcion`, que es cuando se suscribió la póliza, no
-- cuando se subió el archivo. Es lo que pidió el operador y es lo correcto:
-- un CSV de septiembre puede traer pólizas suscritas en agosto.
--
-- `prima` sale de `prima_recibos` (la suma de lo facturado), NUNCA de
-- `prima_anual`, que no es una prima anual sino lo facturado de esa póliza y
-- no se puede comparar entre planes de pago (trampa 29).
--
-- IDEMPOTENTE.
-- =============================================================

create or replace function emisiones_periodos()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(s.x order by s.mes desc), '[]'::jsonb)
  from (
    select
      to_char(date_trunc('month', p.fecha_suscripcion), 'YYYY-MM') as mes,
      jsonb_build_object(
        'mes',      to_char(date_trunc('month', p.fecha_suscripcion), 'YYYY-MM'),
        -- Fechas inclusivas, en el mismo formato `YYYY-MM-DD` que usa el
        -- filtro de la URL (?desde&hasta), para que el selector solo tenga
        -- que copiarlas.
        'desde',    to_char(date_trunc('month', p.fecha_suscripcion), 'YYYY-MM-DD'),
        'hasta',    to_char((date_trunc('month', p.fecha_suscripcion) + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD'),
        'polizas',  count(*),
        'vigentes', count(*) filter (where p.estatus = 'Vigente'),
        'anuladas', count(*) filter (where p.estatus = 'Anulada'),
        'recibos',  coalesce(sum(p.recibos), 0),
        'prima',    round(coalesce(sum(p.prima_recibos), 0)::numeric, 2)
      ) as x
    from v_polizas p
    where p.fecha_suscripcion is not null
    group by date_trunc('month', p.fecha_suscripcion)
  ) s;
$fn$;

-- Cerrada a `anon` como todo lo demás desde la 0082: es `security definer` y
-- Postgres la abriría a PUBLIC por defecto.
revoke all on function emisiones_periodos() from public, anon;
grant execute on function emisiones_periodos() to authenticated, service_role;
