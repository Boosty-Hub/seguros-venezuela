-- =============================================================================
-- 0051 — Contrato agent-side para el Boosty Hub
-- =============================================================================
-- El Boosty Hub monitorea cada agente vía su `agents-collector`, que con el
-- service_role (custodiado en Vault) llama a `hub_metrics()` y lee la tabla
-- `alerts` filtrando por `status=eq.open`. Este contrato faltaba instalarse:
--   1) `hub_metrics()` ya existía (0043_hub_metrics.sql) → OK.
--   2) `alerts` no tenía `status`  → el Hub recibía 400 y NO espejaba alertas.
--
-- Fuente canónica del RPC: projects-hub `supabase/agent-side/hub_metrics.sql`.
-- Mantener en sync (hub_metrics() ya vive acá desde 0043, cuerpo idéntico).
-- =============================================================================

-- ── Columna `status` en alerts (contrato que espera el collector) ────────────
-- Derivada de acknowledged_at: 'open' mientras no se reconozca, si no 'resolved'.
-- Generada/stored → siempre consistente, sin poder desincronizarse, y sin
-- cambiar cómo el agente inserta (nunca escribe `status`).
alter table public.alerts
  add column if not exists status text
  generated always as (case when acknowledged_at is null then 'open' else 'resolved' end) stored;

-- Índice parcial para el filtro del collector (status=eq.open).
create index if not exists alerts_open_idx on public.alerts (created_at desc) where acknowledged_at is null;
