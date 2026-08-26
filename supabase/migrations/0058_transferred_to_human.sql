-- =============================================================
-- 0058_transferred_to_human.sql
-- Etiqueta "transferido a humano": marca el lead cuando el agente ejecuta
-- mover_etapa hacia una etapa PAUSADA (kommo_publish_config.ignored_stage_ids)
-- — el momento en que, por diseño, un humano toma la conversación (ver
-- "cliente por atender" y "Apertura de códigos" de sesiones anteriores).
--
-- Marca HISTÓRICA (nunca se limpia automáticamente): sirve tanto para el tag
-- + filtro en /inbox como para la trazabilidad en /analitica (cuántos de los
-- transferidos terminan Ganados). Si se necesita "todavía en manos de un
-- humano" en vez de "fue transferido alguna vez", eso ya lo cubre la
-- pestaña Agente/Resto (basada en si la etapa actual está pausada).
-- =============================================================

alter table leads
  add column if not exists transferred_to_human_at timestamptz;
alter table leads
  add column if not exists transferred_to_human_stage text;

create index if not exists leads_transferred_to_human_idx
  on leads(transferred_to_human_at)
  where transferred_to_human_at is not null;
