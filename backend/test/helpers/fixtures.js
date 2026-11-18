import { hashPassword } from '../../src/services/auth.service.js';
import { createUser } from '../../src/repositories/user.repository.js';
import { createProvider } from '../../src/repositories/provider.repository.js';
import { createAvailability } from '../../src/repositories/availability.repository.js';

export const CLINICIAN = { email: 'clinician@test.local', password: 'Clinician-Pass-1!', name: 'Dr. Test Clinician' };
export const PATIENT = { email: 'patient@test.local', password: 'Patient-Pass-1!', name: 'Sunita Devi', phone: '+15550100101' };

export async function createClinician() {
  return createUser({
    name: CLINICIAN.name,
    email: CLINICIAN.email,
    passwordHash: await hashPassword(CLINICIAN.password),
    role: 'clinician'
  });
}

export async function createPatientUser(overrides = {}) {
  const data = { ...PATIENT, ...overrides };
  return createUser({
    name: data.name,
    email: data.email,
    phone: data.phone,
    passwordHash: await hashPassword(data.password),
    role: 'patient',
    isSynthetic: true
  });
}

/**
 * Creates a provider with one availability window starting at the next whole hour tomorrow
 * and lasting `hours` hours. Returns the provider and the window bounds.
 */
export async function createProviderWithSchedule({ name = 'Dr. Ananya Sharma', specialty = 'General Practice', hours = 4 } = {}) {
  const provider = await createProvider({ name, specialty });
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
  await createAvailability({ providerId: provider._id, startAt: start.toISOString(), endAt: end.toISOString(), timezone: 'UTC' });
  return { provider, windowStart: start, windowEnd: end };
}

export function slotAt(windowStart, slotIndex, minutes = 30) {
  const startAt = new Date(windowStart.getTime() + slotIndex * minutes * 60 * 1000);
  const endAt = new Date(startAt.getTime() + minutes * 60 * 1000);
  return { startAt: startAt.toISOString(), endAt: endAt.toISOString() };
}

export async function loginClinician(client, credentials = CLINICIAN) {
  const res = await client.post('/api/auth/login', { email: credentials.email, password: credentials.password });
  if (res.status !== 200) throw new Error(`Clinician login failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res;
}

export async function loginPatient(client, credentials = PATIENT) {
  const res = await client.post('/api/auth/patient/login', { email: credentials.email, password: credentials.password });
  if (res.status !== 200) throw new Error(`Patient login failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res;
}
