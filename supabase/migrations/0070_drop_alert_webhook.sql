-- =============================================================
-- 0070_drop_alert_webhook.sql
-- Las alertas viven SOLO en la Torre de Control (in-system): no hay
-- Slack/Discord configurado y no se va a configurar. Se quita
-- `alert_config` (webhook de salida) por completo — código, UI y tabla.
-- IDEMPOTENTE.
-- =============================================================

drop table if exists alert_config;
