-- =============================================================
-- 0062_marcar_perdido_tool.sql
-- Nueva tool interna `marcar_perdido`: el agente descarta un lead que no es
-- una oportunidad de venta (busca empleo, spam, lead errado, otro país, etc.)
-- moviéndolo a la etapa "cliente Perdido" CON su razón de pérdida.
--
-- ¿Por qué una tool aparte y no `mover_etapa`? Porque mover_etapa solo cambia
-- la etapa; en Kommo la razón de pérdida es otro campo (`loss_reason_id`) y sin
-- ella el equipo pierde la trazabilidad de POR QUÉ se descartó. Las 11 razones
-- ya están creadas en el CRM por el operador — esta tool las referencia POR
-- NOMBRE (igual que el resto del módulo CRM identifica etapas y campos), así
-- que si cambian los IDs en Kommo no hay que tocar código.
--
-- La etapa 143 ("cliente Perdido") es un status GLOBAL de Kommo: existe en los
-- 4 pipelines, así que basta con fijar status_id sin tocar pipeline_id — el
-- lead queda perdido dentro del embudo donde ya estaba.
--
-- Gate: reusa `crm_can_move_stage` (es un movimiento de etapa), bajo el master
-- `crm_actions_enabled` — no agrega interruptor nuevo al dashboard.
--
-- Además cierra un hueco encontrado auditando: 143 NO estaba en
-- ignored_stage_ids, así que el agente seguía respondiéndole a leads ya
-- perdidos. Sin esto, el agente descartaría un lead y le seguiría contestando.
--
-- IDEMPOTENTE: ON CONFLICT DO NOTHING + array append condicionado.
-- =============================================================

-- 1) La tool. Los valores del enum son EXACTAMENTE los nombres de las razones
--    de pérdida configuradas en Kommo (se resuelven por nombre en runtime).
insert into agent_tools (name, description, tool_type, enabled, http_method, url_template, input_schema)
values
  (
    'marcar_perdido',
    'Descarta un lead que NO es una oportunidad de venta de seguros, moviéndolo a la etapa "cliente Perdido" del CRM con la razón correspondiente. Acción interna del sistema. Úsala POR INICIATIVA PROPIA cuando la conversación deja claro que el lead no va a comprar por alguna de las razones listadas en "motivo" — típicamente: pide trabajo, es spam/publicidad de terceros, se equivocó de empresa, o escribe desde otro país. Primero responde al lead lo que corresponda (ej. si busca empleo, dale el correo de RRHH; si se equivocó, aclárale con amabilidad) y en ESE MISMO turno llama esta tool. NO la uses si el lead sí podría comprar (aunque esté dudando o pidiendo tiempo), ni para reclamos de clientes ya asegurados — esos van a un asesor humano, no a perdido. Un solo uso por conversación. Puede estar desactivada por el operador; si lo está, la tool te lo dirá — no la reintentes ni menciones al lead que existe. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"motivo":{"type":"string","enum":["Busca empleo","Spam","Lead errado","Lead de otro País","No respondió más","Presupuesto insuficiente","Asegurado con la competencia","Enfermedades preexistente","No asegurable","Persona fallecida","Está embarazada"],"description":"Razón EXACTA por la que se descarta el lead:\n- Busca empleo: pide trabajo, envía currículum o pregunta por vacantes.\n- Spam: publicidad de terceros, cadenas, promoción de otros negocios.\n- Lead errado: se equivocó de empresa o el mensaje no tiene nada que ver con seguros.\n- Lead de otro País: escribe desde fuera de Venezuela y no es asegurable acá.\n- No respondió más: dejó la conversación sin responder tras varios intentos.\n- Presupuesto insuficiente: dijo explícitamente que no le alcanza.\n- Asegurado con la competencia: ya tiene póliza con otra aseguradora y no va a cambiar.\n- Enfermedades preexistente: tiene una condición que lo hace no elegible.\n- No asegurable: no cumple los requisitos de admisibilidad.\n- Persona fallecida: consultan por alguien que falleció.\n- Está embarazada: embarazo en curso, no elegible para el plan que pide."}},"required":["motivo"]}'::jsonb
  )
on conflict (name) do nothing;

-- 2) El agente NO debe seguir respondiendo a un lead que ya está perdido.
--    143 = "cliente Perdido" (status global de Kommo, igual que 142 = Ganado,
--    que ya estaba en la lista).
update kommo_publish_config
set ignored_stage_ids = array_append(ignored_stage_ids, 143::bigint)
where is_active = true
  and not (143 = any(ignored_stage_ids));
