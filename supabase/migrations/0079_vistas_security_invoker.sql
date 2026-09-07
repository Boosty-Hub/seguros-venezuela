-- =============================================================
-- 0079_vistas_security_invoker.sql
-- FUGA DE DATOS: las vistas se saltaban la RLS y la clave `anon` las leia.
--
-- Encontrado auditando: `GET /rest/v1/v_polizas` con la clave **anon** (la que
-- va embebida en el frontend, publica por diseno) devolvia filas con cedulas,
-- nombres, telefonos y primas. Y no era solo esa: las 8 vistas con grant a
-- `anon` devolvian datos —`kommo_duplicados` incluida, cuya clave lleva
-- nombre + correo del cliente.
--
-- Dos causas que se suman:
--
--   1. En Postgres una vista se ejecuta por defecto con los privilegios de su
--      PROPIETARIO (`security_invoker = off`), asi que la RLS de las tablas
--      base NO se aplica: da igual que `tickets` o `polizas_emitidas` exijan
--      sesion autenticada, la vista las lee como postgres.
--   2. Supabase concede por defecto todos los privilegios sobre lo nuevo del
--      esquema `public` a `anon` y `authenticated`. Un `create view` sin
--      revoke explicito queda legible por `anon` sin que nadie lo pida.
--
-- El arreglo son las dos capas:
--   * `security_invoker = on` en TODAS las vistas: pasan a ejecutarse como
--      quien consulta, asi que la RLS de las tablas base decide. Es la capa
--      que de verdad protege.
--   * `revoke` de `anon` sobre las vistas: defensa en profundidad, para que
--      una vista futura a la que se le olvide el security_invoker tampoco
--      quede expuesta.
--
-- Se comprobo antes de aplicarlo que no rompe nada:
--   * Las tablas base (tickets, usage_events, meta_leads, sync_state,
--     sync_log, polizas_emitidas) TODAS tienen politica de lectura para
--     `authenticated`, asi que el dashboard sigue leyendo igual.
--   * `v_polizas` solo la consumen funciones `security definer`, que corren
--     como su propietario y no se ven afectadas.
--   * `kommo_duplicados` la lee `sync/lib/supa.mjs` con la service_role key.
--   * El dashboard estatico de `dashboard/` lee v_funnel/v_kpis/v_agent/
--     v_channel/v_daily_trend, que no tenian grant a anon: ya exigia sesion.
-- =============================================================

do $$
declare
  v record;
begin
  for v in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
    order by c.relname
  loop
    -- La vista pasa a ejecutarse con los permisos de quien consulta, de modo
    -- que la RLS de las tablas base por fin cuenta.
    execute format('alter view public.%I set (security_invoker = on)', v.relname);

    -- `anon` no tiene por que tocar ninguna vista: el dashboard entero exige
    -- sesion. Se revoca todo, no solo el select: los default privileges de
    -- Supabase tambien le habian dado INSERT/UPDATE/DELETE/TRUNCATE.
    execute format('revoke all on public.%I from anon', v.relname);

    -- Y se reafirma lo que si debe poder leer cada rol.
    execute format('grant select on public.%I to authenticated, service_role', v.relname);
  end loop;
end $$;

-- Que las vistas NUEVAS no repitan el problema: se quita a `anon` del default
-- privilege del esquema. Sin esto, el siguiente `create view` vuelve a nacer
-- legible por anon y el arreglo dura hasta la proxima migracion.
--
-- OJO: solo afecta a lo que cree el rol que ejecuta esto (postgres). Las
-- tablas siguen protegidas por su RLS; esto es la red de seguridad para las
-- vistas, que no tienen RLS propia.
alter default privileges in schema public revoke all on tables from anon;
