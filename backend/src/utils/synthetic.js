/**
 * Synthetic-data guards. Demo and test patients must never cause a real phone call.
 *
 * +1 555 is not an assigned North American area code, so numbers in that range cannot
 * reach a real person. Seed data uses them for every synthetic patient.
 */
const FICTIONAL_PHONE_PREFIX = /^\+1555\d{7}$/;

export function isSyntheticPhone(phone) {
  return typeof phone === 'string' && FICTIONAL_PHONE_PREFIX.test(phone.trim());
}

/**
 * True when an appointment belongs to a synthetic patient, either by explicit flag or fictional phone.
 */
export function isSyntheticAppointment(appointment) {
  if (!appointment) return false;
  return Boolean(appointment.patient?.isSynthetic) || isSyntheticPhone(appointment.patient?.phone);
}
