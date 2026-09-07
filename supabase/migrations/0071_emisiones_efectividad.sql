-- =============================================================
-- 0071_emisiones_efectividad.sql
-- Cruce entre lo que se COTIZA (Zoho Desk -> tickets) y lo que se EMITE
-- (sistema central de polizas, que entrega un CSV mensual). El objetivo es la
-- efectividad de cada corredor: de lo que cotizo, cuanto cerro.
--
-- Grano del CSV: es el RECIBO, no la poliza. El archivo de agosto trae 655
-- filas que son 539 polizas — una poliza puede tener varios recibos (cuotas)
-- del MISMO asegurado. Medido sobre ese archivo: los campos de poliza
-- (estatus, fecha_suscripcion, cod_intermediario, cedulas, suma, prima_anual)
-- son identicos entre los recibos de una misma poliza; solo varian
-- prima_recibo, estatus_recibo y fecha_emision_recibo. Por eso se guarda a
-- grano recibo (PK = recibo, que es unico) y se cuenta a grano poliza.
-- Contar filas en vez de polizas infla el resultado un 21%.
--
-- Decisiones de negocio (del operador, 06-09-2026):
--   * Una poliza ANULADA no cuenta como cierre exitoso, pero se muestra
--     aparte. En agosto: 460 vigentes / 79 anuladas, sin polizas mixtas.
--   * La emision se acredita al INTERMEDIARIO DEL SISTEMA CENTRAL, no al
--     asesor que escribio el ticket en Zoho. Cuando difieren (51 de 210 casos
--     medidos) suele ser persona vs. empresa: CSV "MARSH VENEZUELA CA
--     SOCIEDAD DE CORRETAJE" vs. Zoho "MANUEL LOBATON".
--   * Las cotizaciones recientes NO se pueden juzgar todavia: el desfase
--     cotizacion->emision medido es mediana 12 dias, p75 24, p90 57, max 166.
--     Por eso todo se parte en "maduras" (mas de p_maduracion_dias, default
--     60) e "inmaduras", y el ranking solo usa las maduras.
--
-- El match de CLIENTE es por CEDULA, la unica clave fiable:
--   * En Zoho se extrae del asunto con zoho_cedula() y sale en el 99,8% de
--     los tickets B2B.
--   * En el CSV hay dos cedulas por poliza y NO son la misma persona en
--     muchos casos (tomador = quien paga, asegurado = quien esta cubierto).
--     Hay que cruzar por las dos: por tomador machean 176 polizas, por
--     asegurado 198, por cualquiera de las dos 225. Quedarse con una sola
--     pierde entre el 12% y el 22% de los cruces.
--
-- El match de CORREDOR necesita tabla de alias porque el campo Asesor de Zoho
-- es texto libre: un mismo corredor aparece hasta de 12 formas ("BARECA",
-- "BARECA SC", "BARECA SOCIEDAD DE CORETAJE" con typo, ...). Por nombre exacto
-- solo machean 58 de 174 intermediarios. El CSV aporta lo que faltaba: el
-- Cod_Intermediario canonico (174 codigos, 1:1 con su nombre).
-- =============================================================

-- pg_trgm ya estaba instalada en este proyecto; el auto-mapeo de alias la usa
-- para proponer candidatos por similitud.
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------
-- Registro canonico de intermediarios (lo dicta el sistema central)
-- ---------------------------------------------------------------
create table if not exists intermediarios (
  cod_intermediario text primary key,
  nombre            text not null,
  -- Se guarda normalizado en columna propia (no generated) a proposito: una
  -- generated column ataria la tabla a la definicion de zoho_norm() y habria
  -- que reconstruirla cada vez que esa funcion cambie.
  nombre_norm       text not null,
  visto_primero     timestamptz not null default now(),
  visto_ultimo      timestamptz not null default now()
);

create index if not exists intermediarios_nombre_norm on intermediarios (nombre_norm);
create index if not exists intermediarios_nombre_trgm on intermediarios using gin (nombre_norm gin_trgm_ops);

-- ---------------------------------------------------------------
-- Auditoria de cargas (quien subio que archivo y que cambio)
-- ---------------------------------------------------------------
create table if not exists emision_cargas (
  id                    bigserial primary key,
  archivo               text,
  filas_archivo         integer not null default 0,
  recibos_nuevos        integer not null default 0,
  recibos_actualizados  integer not null default 0,
  polizas               integer not null default 0,
  intermediarios_nuevos integer not null default 0,
  periodo_desde         date,
  periodo_hasta         date,
  subido_por            text,
  creado_en             timestamptz not null default now()
);

create index if not exists emision_cargas_creado on emision_cargas (creado_en desc);

-- ---------------------------------------------------------------
-- Polizas emitidas, a grano RECIBO
-- ---------------------------------------------------------------
create table if not exists polizas_emitidas (
  recibo               text primary key,
  nu_poliza            text not null,
  estatus              text,      -- Vigente | Anulada (constante por poliza)
  estatus_recibo       text,      -- Cobrado | Pendiente Por Cobrar | Anulado
  motivo_anulacion     text,
  sucursal             text,
  ramo                 text,
  desc_ramo            text,
  producto             text,
  desc_producto        text,
  ci_tomador           text,
  ci_tomador_digitos   text,      -- solo digitos: es la clave de cruce
  nombre_tomador       text,
  ci_asegurado         text,
  ci_asegurado_digitos text,
  nombre_asegurado     text,
  correo_asegurado     text,
  telefono_asegurado   text,
  ciudad               text,
  canal_ventas         text,
  canal_negocio        text,
  cod_intermediario    text,
  nombre_intermediario text,
  nombre_supervisor    text,
  clasificacion        text,
  plan_poliza          text,
  suma_asegurada       numeric,
  cant_titulares       integer,
  cant_beneficiarios   integer,
  moneda               text,
  prima_anual          numeric,
  prima_recibo         numeric,
  comision             numeric,
  plan_pago            text,
  tipo_facturacion     text,
  fecha_suscripcion    date,
  fecha_desde          date,
  fecha_hasta          date,
  fecha_emision_recibo date,
  fecha_desde_recibo   date,
  fecha_hasta_recibo   date,
  usuario_emision      text,
  desc_usuario_emision text,
  carga_id             bigint references emision_cargas(id) on delete set null,
  actualizado_en       timestamptz not null default now()
);

create index if not exists polizas_emitidas_poliza  on polizas_emitidas (nu_poliza);
create index if not exists polizas_emitidas_ced_tom on polizas_emitidas (ci_tomador_digitos) where ci_tomador_digitos is not null;
create index if not exists polizas_emitidas_ced_ase on polizas_emitidas (ci_asegurado_digitos) where ci_asegurado_digitos is not null;
create index if not exists polizas_emitidas_cod     on polizas_emitidas (cod_intermediario);
create index if not exists polizas_emitidas_suscrip on polizas_emitidas (fecha_suscripcion);

-- ---------------------------------------------------------------
-- Alias: el texto libre de Zoho -> el codigo canonico
-- ---------------------------------------------------------------
create table if not exists corredor_alias (
  asesor_norm       text primary key,          -- lo que devuelve zoho_norm(asesor)
  cod_intermediario text not null references intermediarios(cod_intermediario) on delete cascade,
  origen            text not null default 'auto',
  similitud         numeric,
  creado_en         timestamptz not null default now()
);

create index if not exists corredor_alias_cod on corredor_alias (cod_intermediario);

-- 'rechazado' es un alias que el operador marco como NO equivalente. Se guarda
-- para que el auto-mapeo no lo vuelva a proponer en la siguiente carga.
alter table corredor_alias drop constraint if exists corredor_alias_origen_chk;
alter table corredor_alias add constraint corredor_alias_origen_chk
  check (origen in ('auto', 'manual', 'rechazado'));

-- ---------------------------------------------------------------
-- Una poliza = una fila (colapsa los recibos). Es el grano para contar.
-- Los campos de poliza son constantes entre recibos, asi que min() actua como
-- "cualquiera de ellos"; solo prima_recibos se suma de verdad.
-- ---------------------------------------------------------------
create or replace view v_polizas as
select
  nu_poliza,
  min(estatus)              as estatus,
  min(cod_intermediario)    as cod_intermediario,
  min(nombre_intermediario) as nombre_intermediario,
  min(ci_tomador_digitos)   as ci_tomador_digitos,
  min(ci_asegurado_digitos) as ci_asegurado_digitos,
  min(nombre_tomador)       as nombre_tomador,
  min(nombre_asegurado)     as nombre_asegurado,
  min(correo_asegurado)     as correo_asegurado,
  min(fecha_suscripcion)    as fecha_suscripcion,
  min(suma_asegurada)       as suma_asegurada,
  min(prima_anual)          as prima_anual,
  sum(prima_recibo)         as prima_recibos,
  count(*)                  as recibos
from polizas_emitidas
group by nu_poliza;

grant select on v_polizas to authenticated, service_role;
grant select on intermediarios, polizas_emitidas, corredor_alias, emision_cargas to authenticated, service_role;

-- RLS: son datos personales (cedulas, nombres, primas). Mismo criterio que
-- tickets — solo legibles con sesion autenticada. Las escrituras las hace la
-- ruta de carga con la service_role key.
alter table polizas_emitidas enable row level security;
alter table intermediarios   enable row level security;
alter table corredor_alias   enable row level security;
alter table emision_cargas   enable row level security;

do $pol$
begin
  if not exists (select 1 from pg_policies where tablename = 'polizas_emitidas' and policyname = 'polizas_emitidas_read') then
    create policy polizas_emitidas_read on polizas_emitidas for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'intermediarios' and policyname = 'intermediarios_read') then
    create policy intermediarios_read on intermediarios for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'corredor_alias' and policyname = 'corredor_alias_read') then
    create policy corredor_alias_read on corredor_alias for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'emision_cargas' and policyname = 'emision_cargas_read') then
    create policy emision_cargas_read on emision_cargas for select to authenticated using (true);
  end if;
end
$pol$;
