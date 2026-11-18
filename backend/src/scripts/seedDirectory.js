import { findProviders } from '../repositories/provider.repository.js';
import { upsertFacility } from '../repositories/serviceDirectory.repository.js';
import { isDirectRun, runSeeds } from './seedRunner.js';

/**
 * SIMULATED service directory for the demo district.
 * Locations are on a synthetic map in kilometres (x = east, y = north of the district town).
 * Clinic facilities list the seeded doctors whose calendars they use.
 */
const MON_TO_SAT = [1, 2, 3, 4, 5, 6];
const MON_TO_FRI = [1, 2, 3, 4, 5];

export const DEMO_FACILITIES = [
  {
    code: 'CARELOOP-DISTRICT',
    name: 'CareLoop District Clinic (Simulated)',
    category: 'clinic',
    modality: 'in_person',
    specialties: ['General Practice', 'Cardiology', 'Orthopedics'],
    location: { label: 'District town', x: 0, y: 0 },
    hours: { days: MON_TO_SAT, open: '09:00', close: '17:00' },
    requiredDocuments: [],
    providerNames: ['Dr. Ananya Sharma', 'Dr. Rajesh Iyer', 'Dr. Meera Nair']
  },
  {
    code: 'PHC-SUNDARPUR',
    name: 'Sundarpur Primary Health Centre (Simulated)',
    category: 'clinic',
    modality: 'in_person',
    specialties: ['General Practice'],
    location: { label: 'Sundarpur', x: 13, y: 5 },
    hours: { days: MON_TO_SAT, open: '09:00', close: '14:00' },
    requiredDocuments: ['aadhaar'],
    providerNames: ['Dr. Farhan Qureshi']
  },
  {
    code: 'PHC-KESHAVGANJ',
    name: 'Keshavganj Primary Health Centre (Simulated)',
    category: 'clinic',
    modality: 'in_person',
    specialties: ['General Practice'],
    location: { label: 'Keshavganj', x: -6, y: -8 },
    hours: { days: MON_TO_SAT, open: '10:00', close: '13:00' },
    requiredDocuments: ['aadhaar'],
    providerNames: ['Dr. Pooja Verma']
  },
  {
    code: 'TELE-GP',
    name: 'CareLoop Teleconsultation (Simulated)',
    category: 'clinic',
    modality: 'teleconsult',
    specialties: ['General Practice'],
    location: null,
    hours: { days: MON_TO_SAT, open: '09:00', close: '17:00' },
    requiredDocuments: [],
    providerNames: ['Dr. Ananya Sharma']
  },
  {
    code: 'LAB-DISTRICT',
    name: 'District Diagnostics Lab (Simulated)',
    category: 'lab',
    modality: 'in_person',
    tests: ['lipid_profile', 'hba1c', 'cbc'],
    location: { label: 'District town', x: 0.5, y: -0.5 },
    hours: { days: MON_TO_SAT, open: '07:00', close: '13:00' },
    requiredDocuments: [],
    providerNames: []
  },
  {
    code: 'LAB-SUNDARPUR',
    name: 'Sundarpur Sample Collection Centre (Simulated)',
    category: 'lab',
    modality: 'in_person',
    tests: ['lipid_profile', 'cbc'],
    location: { label: 'Sundarpur', x: 15, y: 7.5 },
    hours: { days: MON_TO_FRI, open: '08:00', close: '11:00' },
    requiredDocuments: ['aadhaar'],
    providerNames: []
  },
  {
    code: 'HOME-COLLECTION',
    name: 'Home Sample Collection Service (Simulated)',
    category: 'lab',
    modality: 'home_visit',
    tests: ['lipid_profile', 'hba1c'],
    location: null,
    hours: { days: [2, 4, 6], open: '07:00', close: '10:00' },
    bookAheadDays: 1,
    requiredDocuments: ['aadhaar'],
    providerNames: []
  }
];

/**
 * Creates the simulated directory. Expects an open DB connection and seeded providers. Safe to re-run.
 */
export async function seedDirectory() {
  const providers = await findProviders();
  const idsByName = new Map(providers.map(p => [p.name, p._id]));

  for (const { providerNames, ...facility } of DEMO_FACILITIES) {
    const providerIds = providerNames.map(name => idsByName.get(name)).filter(Boolean);
    const { created } = await upsertFacility({ ...facility, providerIds });
    console.log(`[Seed] ${created ? 'Created' : 'Directory already has'} ${facility.name}.`);
  }
}

if (isDirectRun(import.meta.url)) {
  runSeeds('Service Directory', [seedDirectory]);
}
