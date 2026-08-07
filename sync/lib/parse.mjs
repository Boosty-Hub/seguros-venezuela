// Conversion de un ticket de Zoho Desk a una fila de la tabla `tickets`.

/**
 * Parsea numeros en formato venezolano/europeo: "2.682,00" -> 2682.00
 * Devuelve null si el valor no es un numero limpio.
 */
export function parseVzNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '--') return null;
  // Solo aceptamos formatos numericos: miles con '.', decimal con ','
  if (!/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(s) && !/^-?\d+(,\d+)?$/.test(s)) return null;
  const norm = s.replace(/\./g, '').replace(',', '.');
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

function fullName(obj) {
  if (!obj) return null;
  const n = [obj.firstName, obj.lastName].filter(Boolean).join(' ').trim();
  return n || null;
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Construye la fila para Supabase a partir de un ticket de Zoho.
 * `t` puede venir del endpoint de lista (sin customFields) o de detalle (con
 * customFields). Cuando no hay customFields se preservan los ya existentes
 * (no se sobreescriben con null) — eso lo maneja el upsert por columnas.
 */
export function ticketToRow(t) {
  const cf = t.customFields || null;

  const row = {
    id: String(t.id),
    ticket_number: t.ticketNumber ?? null,
    subject: t.subject ?? null,
    status: t.status ?? null,
    status_type: t.statusType ?? null,
    channel: t.channel ?? null,
    priority: t.priority ?? null,
    category: t.category ?? null,
    sub_category: t.subCategory ?? null,
    department_id: t.departmentId ?? null,

    contact_id: t.contactId ?? null,
    contact_name: fullName(t.contact) ?? null,
    email: t.email ?? (t.contact && t.contact.email) ?? null,
    phone: t.phone ?? (t.contact && t.contact.phone) ?? null,

    assignee_id: t.assigneeId ?? null,
    assignee_name: fullName(t.assignee) ?? null,
    team_id: t.teamId ?? null,

    created_time: t.createdTime ?? null,
    // el endpoint de LISTA no trae modifiedTime -> fallback a createdTime
    // para mantener un watermark valido en el sync incremental.
    modified_time: t.modifiedTime ?? t.createdTime ?? null,
    closed_time: t.closedTime ?? null,
    due_date: t.dueDate ?? null,
    customer_response_time: t.customerResponseTime ?? null,

    thread_count: toInt(t.threadCount),
    comment_count: toInt(t.commentCount),
    is_spam: !!t.isSpam,
    is_overdue: !!t.isOverDue,
    web_url: t.webUrl ?? null,

    raw: t,
    synced_at: new Date().toISOString(),
  };

  // Campos de negocio solo si vienen customFields (llamada de detalle)
  if (cf) {
    row.custom_fields = cf;
    row.ramo = cf['Ramo'] ?? null;
    row.plan_hcm = cf['Plan HCM'] ?? null;
    row.asesor = cf['Asesor'] ?? null;
    row.titular = cf['Nombre y apellido del Titular'] ?? cf['Nombre del Beneficiario'] ?? null;
    row.tipo_documento = cf['Tipo de documento'] ?? null;
    row.edad = toInt(cf['Edad']);
    row.moneda = cf['Moneda de Pago'] ?? null;
    row.monto_prima =
      parseVzNumber(cf['Monto Prima - Anual']) ??
      parseVzNumber(cf['Monto Prima']) ??
      null;
  }

  return row;
}
