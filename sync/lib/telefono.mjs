// ============================================================================
// Normalizacion de telefonos venezolanos a formato internacional (+58...).
// Compartido por las dos fuentes: los tickets de Zoho traen "04241333536" y la
// hoja de Meta trae "p:+584241398741" / "p:0414-6222161" / "p:4144039098".
// ============================================================================

/**
 * Devuelve el telefono en formato +58XXXXXXXXXX cuando se puede reconocer.
 * Si el numero no encaja en ningun patron venezolano conocido (extranjeros,
 * datos truncados) devuelve los digitos limpios sin inventar el prefijo: es
 * mejor un dato crudo visible que uno falso bien formateado.
 */
export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/^p:/i, '').trim();
  if (!s) return null;

  const plus = s.startsWith('+');
  const d = s.replace(/\D/g, '');
  if (!d) return null;

  // Ya viene internacional y venezolano.
  if (d.startsWith('58') && d.length === 12) return `+${d}`;
  // Local con cero: 04141234567 (11) -> +584141234567
  if (d.startsWith('0') && d.length === 11) return `+58${d.slice(1)}`;
  // Sin cero ni prefijo: 4141234567 (10) -> +584141234567
  if (d.length === 10 && d.startsWith('4')) return `+58${d}`;
  // Fijos locales con cero: 02121234567 ya cubierto por el caso de 11 digitos.

  // Otro pais o dato irreconocible: se respeta tal cual.
  if (plus) return `+${d}`;
  if (d.startsWith('58') && d.length > 12) return `+${d}`;
  return d;
}

/** true si el valor ya esta en el formato venezolano canonico. */
export function esVenezolanoCanonico(tel) {
  return typeof tel === 'string' && /^\+58\d{10}$/.test(tel);
}

/** Ultimos 10 digitos: sirve para comparar entre formatos distintos. */
export function claveTelefono(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}
