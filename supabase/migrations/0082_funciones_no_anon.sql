-- =============================================================
-- 0082_funciones_no_anon.sql
-- FUGA DE DATOS: las funciones `security definer` eran ejecutables con la
-- clave `anon`. Es la trampa 33 un piso más arriba.
--
-- MEDIDO EN VIVO (10-09) antes de arreglarlo, con la clave anon del frontend
-- (pública por diseño) y sin ninguna sesión:
--
--   POST /rest/v1/rpc/zoho_pipeline_overview   → 200, 190 KB
--        1.196 corredores con nombre, número de clientes, cotizaciones y
--        fecha de última actividad, más los totales del negocio
--        (12.604 tickets B2B, 9.015 clientes).
--   POST /rest/v1/rpc/verticales_uso           → 200, 1,9 KB
--
--   18 de las 75 funciones de `public` eran `security definer` y estaban
--   abiertas a `anon`/`PUBLIC`.
--
-- POR QUÉ PASÓ. La 0079 cerró el mismo agujero en las VISTAS y quitó a `anon`
-- del default privilege de TABLAS — pero el default privilege de FUNCIONES es
-- otro objeto, y Postgres concede EXECUTE a `PUBLIC` en toda función nueva.
-- Como una `security definer` corre con los privilegios de su PROPIETARIO, la
-- RLS de las tablas base no la frena: da igual que `tickets` exija sesión.
-- El resultado es idéntico al de la 0079 y por el mismo motivo de fondo:
-- Supabase abre lo nuevo por defecto, y lo que no se cierra a mano queda
-- abierto.
--
-- QUÉ HACE. Dos capas, como la 0079:
--   1. Revoca EXECUTE de `PUBLIC` (que es de donde lo hereda `anon`) en TODAS
--      las funciones y procedimientos de `public`, y lo concede explícito a
--      `authenticated` y `service_role`, que son quienes las llaman de verdad
--      (el dashboard con sesión y las Edge Functions).
--   2. Cambia el DEFAULT PRIVILEGE para que las funciones futuras nazcan
--      cerradas a `PUBLIC` y abiertas a esos dos roles. Sin esto el arreglo
--      dura hasta la próxima migración.
--
-- NO rompe nada verificado antes de aplicar: ninguna página sin sesión
-- (`/login`, `/auth/*`, `/update-password`) llama a una RPC ni lee una tabla,
-- el dashboard estático de `dashboard/` ya exigía sesión (0079), los crones
-- corren como `postgres` y las Edge Functions usan `service_role`. Los
-- disparadores tampoco: el privilegio de una función de trigger se comprueba
-- al crear el trigger, no al dispararlo.
--
-- CÓMO COMPROBARLO (igual que la trampa 33, con la clave anon):
--   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
--     "$SUPABASE_URL/rest/v1/rpc/zoho_pipeline_overview" \
--     -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d '{}'
--   → tiene que dar 404 (PostgREST no expone lo que no puedes ejecutar).
--
-- IDEMPOTENTE.
-- =============================================================

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')   -- funciones y procedimientos
  loop
    -- `from public` es lo que importa: `anon` hereda de ahí. Revocarle solo a
    -- `anon` no quita nada, porque nunca tuvo un grant directo.
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end$$;

-- Que las funciones NUEVAS no repitan el problema.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
