import { env } from '../config/env.js';
import { hashPassword } from '../services/auth.service.js';
import { findUserByEmail, createUser } from '../repositories/user.repository.js';
import { isDirectRun, runSeeds } from './seedRunner.js';

/**
 * Creates the development clinician account if it does not exist. Expects an open DB connection.
 */
export async function seedClinician() {
  const email = (env.SEED_CLINICIAN_EMAIL || 'clinician@careloop.local').toLowerCase().trim();
  const name = env.SEED_CLINICIAN_NAME;
  const password = env.SEED_CLINICIAN_PASSWORD;

  const existing = await findUserByEmail(email);
  if (existing) {
    console.log(`[Seed] Clinician account "${email}" already exists (role: ${existing.role}). Not overwriting credentials.`);
    return existing;
  }

  const passwordHash = await hashPassword(password);
  const created = await createUser({
    name,
    email,
    passwordHash,
    role: 'clinician',
    isActive: true
  });

  console.log(`[Seed] Created clinician ${created.name} (${created.email}).`);
  return created;
}

if (isDirectRun(import.meta.url)) {
  runSeeds('Clinician', [seedClinician]);
}
