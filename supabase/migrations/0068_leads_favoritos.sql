-- =============================================================
-- 0068_leads_favoritos.sql
-- Marcar conversaciones como favoritas desde /inbox, para poder volver a
-- ellas y filtrarlas.
--
-- La marca es del EQUIPO, no de cada usuario: es una columna en `leads`, igual
-- que `transferred_to_human_at`. En este dashboard el inbox es compartido —
-- lo que un operador marca como importante lo tienen que ver los demás. Si
-- alguna vez se quiere por usuario, hay que pasarlo a una tabla aparte
-- (lead_id, user_id).
--
-- Se guarda la FECHA en vez de un booleano, por consistencia con el resto de
-- la tabla y porque permite ordenar por "marcado más recientemente".
-- NULL = no es favorita.
-- =============================================================

alter table leads add column if not exists favorited_at timestamptz;
alter table leads add column if not exists favorited_by uuid;

-- Índice parcial: solo las favoritas, que son unas pocas de miles.
create index if not exists leads_favoritos on leads (favorited_at desc)
  where favorited_at is not null;

comment on column leads.favorited_at is
  'Cuándo se marcó la conversación como favorita desde /inbox. NULL = no lo es. Marca compartida por todo el equipo.';
