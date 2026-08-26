-- =============================================================
-- 0057_image_send_tool.sql
-- Nueva tool interna `enviar_imagen`: el agente envía una imagen de
-- paso a paso cuando el cliente pregunta por un trámite específico de
-- SEGVEN (registro en línea, reporte de pagos, CIMECI, carta aval, etc.).
--
-- A diferencia de mover_etapa/actualizar_lead/actualizar_contacto (que
-- solo actúan si el operador lo indica explícitamente en su voz), esta
-- tool se dispara POR INICIATIVA PROPIA del agente en cuanto detecta el
-- tema — el "cuándo" vive en la descripción del input_schema, no en la
-- voz del operador (ver excepción en buildCrmActionsBlock).
--
-- Mecanismo: como el resto del módulo CRM, escribe una URL en un campo
-- custom del lead (`image_field_id`) y dispara el salesbot que la
-- entrega por el canal (`image_salesbot_id`). Gate propio
-- `crm_can_send_image`, bajo el master `crm_actions_enabled` — default
-- OFF hasta que el operador lo active desde /agent?tab=acciones.
--
-- También deja sembrados los IDs de Kommo ya provistos por el operador
-- para el flujo de publicación normal (campo/salesbot de mensajes) y el
-- salesbot de comentarios — solo si el config aún no tiene valor (no
-- pisa lo que el operador haya configurado después vía dashboard).
--
-- IDEMPOTENTE: add column if not exists + ON CONFLICT DO NOTHING + update
-- solo donde el valor está en null.
-- =============================================================

-- 1) Columnas nuevas para el campo/salesbot de imágenes + su gate.
alter table kommo_publish_config
  add column if not exists image_field_id bigint;
alter table kommo_publish_config
  add column if not exists image_salesbot_id bigint;
alter table kommo_publish_config
  add column if not exists crm_can_send_image boolean not null default false;

-- 2) Siembra de los IDs de Kommo entregados por el operador (solo si están
--    vacíos — no pisa configuración existente).
update kommo_publish_config
set
  response_custom_field_id = coalesce(response_custom_field_id, 861770),
  salesbot_id = coalesce(salesbot_id, 35982),
  image_field_id = coalesce(image_field_id, 861772),
  image_salesbot_id = coalesce(image_salesbot_id, 35984),
  comment_salesbot_id = coalesce(comment_salesbot_id, 35986)
where is_active = true;

-- 3) La tool interna. Mismo patrón que mover_etapa/actualizar_lead (system,
--    enabled, sin http) — el enum de temas y su descripción son la ÚNICA
--    fuente de verdad de qué imagen corresponde a cada pregunta del cliente.
insert into agent_tools (name, description, tool_type, enabled, http_method, url_template, input_schema)
values
  (
    'enviar_imagen',
    'Envía al lead una imagen con el paso a paso de un trámite específico de SEGVEN, según el tema exacto por el que pregunta. Acción interna del sistema: escribe la URL de la imagen en el campo de imágenes del lead y dispara el salesbot que la entrega por el canal (WhatsApp/Instagram). A diferencia de otras acciones del CRM, INVÓCALA POR INICIATIVA PROPIA (sin esperar instrucción del operador) en cuanto detectes que el cliente pregunta por uno de los temas listados en "tema" — un solo envío por trámite preguntado, no repitas si ya la enviaste en el mismo intercambio. Si el tema no calza claramente con ninguno de los valores válidos, NO la uses. Puede estar desactivada por el operador; si lo está, la tool te lo dirá — no la reintentes ni menciones al lead que existe. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"tema":{"type":"string","enum":["registro_segven_linea","reporte_pagos_linea","servicios_especializados","claves_emergencia","amp_amd","activacion_cimeci","atencion_medica_digital","atencion_cliente_general","carta_aval_reembolso"],"description":"Tema EXACTO por el que pregunta el cliente. Usa uno de estos valores:\n- registro_segven_linea: cómo registrarse en SEGVEN en Línea.\n- reporte_pagos_linea: cómo ver el reporte de pagos en línea.\n- servicios_especializados: servicios especializados.\n- claves_emergencia: solicitud de claves de emergencia.\n- amp_amd: solicitud de AMP y AMD.\n- activacion_cimeci: activación del servicio CIMECI.\n- atencion_medica_digital: atención médica digital.\n- atencion_cliente_general: atención al cliente en general — reembolso, anulación de póliza, carta aval, RCV, notificación de pago, descargar cuadro de póliza o emergencias, preguntado de forma genérica (menú con varias opciones).\n- carta_aval_reembolso: pregunta ESPECÍFICA por cómo tramitar una carta aval o un reembolso, paso a paso."}},"required":["tema"]}'::jsonb
  )
on conflict (name) do nothing;
