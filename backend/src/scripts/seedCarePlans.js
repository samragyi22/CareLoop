import { env } from '../config/env.js';
import { findUserByEmail } from '../repositories/user.repository.js';
import {
  createPatientRecord,
  findPatientRecordByUserId,
  findPatientRecordsByName,
  updatePatientLogistics
} from '../repositories/patient.repository.js';
import { listCarePlans } from '../repositories/carePlan.repository.js';
import { createCarePlan } from '../services/carePlan.service.js';
import { DEMO_PATIENTS } from './seedPatientUsers.js';
import { isDirectRun, runSeeds } from './seedRunner.js';

// Logistical profiles for the synthetic patients, used by feasibility checks.
// Locations are on the simulated district map (see seedDirectory.js).
const PATIENT_PROFILES = {
  'patient@careloop.local': {
    preferredLanguage: 'hi',
    constraints: { hasOwnTransport: false, maxTravelKm: 5, documentsHeld: ['aadhaar'], caregiverName: 'Ravi (son)' },
    location: { label: 'Sundarpur village', x: 14, y: 6 }
  },
  'patient2@careloop.local': {
    preferredLanguage: 'en',
    constraints: { hasOwnTransport: true, maxTravelKm: 30, documentsHeld: ['aadhaar', 'discharge_summary'] },
    location: { label: 'District town outskirts', x: 3, y: 2 }
  }
};

// A patient who reaches the clinic only by phone and has no portal login
const PHONE_ONLY_PATIENT = {
  name: 'Lakshmi Bai',
  phone: '+15550100103',
  preferredLanguage: 'hi',
  constraints: { hasOwnTransport: false, maxTravelKm: 3, documentsHeld: [], caregiverName: 'Meena (daughter-in-law)' },
  location: { label: 'Keshavganj outskirts', x: -7, y: -9 }
};

const DEMO_PLAN_TEMPLATE = 'post-discharge-chest-pain';

/**
 * Creates patient records for the synthetic patients and one demo care plan.
 * Expects an open DB connection, the clinician seed, and the patient-login seed. Safe to re-run.
 */
export async function seedCarePlans() {
  const clinician = await findUserByEmail(env.SEED_CLINICIAN_EMAIL);
  if (!clinician) {
    console.warn('[Seed] Clinician account not found; run the clinician seed first. Skipping care plans.');
    return;
  }

  const records = [];
  for (const demo of DEMO_PATIENTS) {
    const user = await findUserByEmail(demo.email);
    if (!user) continue;

    const profile = PATIENT_PROFILES[demo.email] || {};
    let record = await findPatientRecordByUserId(user._id);
    if (!record) {
      record = await createPatientRecord({
        name: user.name,
        phone: user.phone,
        userId: user._id,
        preferredLanguage: profile.preferredLanguage,
        constraints: profile.constraints,
        location: profile.location,
        isSynthetic: true
      });
      console.log(`[Seed] Created patient record for ${record.name}.`);
    } else if (!record.location && profile.location) {
      // Records created before locations existed
      record = await updatePatientLogistics(record._id, { location: profile.location });
    }
    records.push(record);
  }

  const [existingPhoneOnly] = await findPatientRecordsByName(PHONE_ONLY_PATIENT.name);
  if (!existingPhoneOnly) {
    await createPatientRecord({ ...PHONE_ONLY_PATIENT, isSynthetic: true });
    console.log(`[Seed] Created phone-only patient record for ${PHONE_ONLY_PATIENT.name}.`);
  } else if (!existingPhoneOnly.location) {
    await updatePatientLogistics(existingPhoneOnly._id, { location: PHONE_ONLY_PATIENT.location });
  }

  const demoPatient = records[0];
  if (demoPatient && (await listCarePlans({ patientId: demoPatient._id })).length === 0) {
    const detail = await createCarePlan({
      patientId: demoPatient._id,
      templateId: DEMO_PLAN_TEMPLATE,
      actor: { type: 'clinician', id: clinician._id, name: clinician.name }
    });
    console.log(`[Seed] Created demo care plan "${detail.plan.title}" (${detail.tasks.length} tasks) for ${demoPatient.name}.`);
  }
}

if (isDirectRun(import.meta.url)) {
  runSeeds('Care Plans', [seedCarePlans]);
}
