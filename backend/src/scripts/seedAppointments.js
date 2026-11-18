import { env } from '../config/env.js';
import { findProviders, createProvider } from '../repositories/provider.repository.js';
import { findAvailabilityByProvider, createAvailability } from '../repositories/availability.repository.js';
import { localTimeOnDay } from '../utils/time.js';
import { isDirectRun, runSeeds } from './seedRunner.js';

// Synthetic demonstration providers (fictional names). `location` is the simulated facility they work at.
const DISTRICT_CLINIC = 'CareLoop District Clinic (Simulated)';
export const DEMO_PROVIDERS = [
  { name: 'Dr. Ananya Sharma', specialty: 'General Practice', location: DISTRICT_CLINIC },
  { name: 'Dr. Rajesh Iyer', specialty: 'Cardiology', location: DISTRICT_CLINIC },
  { name: 'Dr. Meera Nair', specialty: 'Orthopedics', location: DISTRICT_CLINIC },
  { name: 'Dr. Farhan Qureshi', specialty: 'General Practice', location: 'Sundarpur Primary Health Centre (Simulated)', hours: { start: 9, end: 14 } },
  { name: 'Dr. Pooja Verma', specialty: 'General Practice', location: 'Keshavganj Primary Health Centre (Simulated)', hours: { start: 10, end: 13 } }
];

const SCHEDULE_DAYS = 5;
const DEFAULT_HOURS = { start: 9, end: 17 };

/**
 * Creates demo providers and gives each a clinic-local daily schedule (9:00-17:00 unless the
 * provider has its own hours) for the next five days. Expects an open DB connection. Safe to re-run.
 */
export async function seedProvidersAndSchedules() {
  const timeZone = env.DEFAULT_TIMEZONE;
  const existingProviders = await findProviders();
  const providerMap = new Map(existingProviders.map(p => [p.name.toLowerCase(), p]));

  for (const demo of DEMO_PROVIDERS) {
    let provider = providerMap.get(demo.name.toLowerCase());
    if (!provider) {
      provider = await createProvider({ name: demo.name, specialty: demo.specialty, location: demo.location, isActive: true });
      console.log(`[Seed] Created provider ${demo.name} (${demo.specialty}).`);
    } else {
      console.log(`[Seed] Provider already exists: ${demo.name}.`);
    }

    const existingWindows = await findAvailabilityByProvider(provider._id, { startDate: new Date().toISOString() });
    if (existingWindows.length > 0) {
      console.log(`[Seed] ${demo.name} already has ${existingWindows.length} upcoming availability window(s).`);
      continue;
    }

    const hours = demo.hours || DEFAULT_HOURS;
    for (let dayOffset = 1; dayOffset <= SCHEDULE_DAYS; dayOffset++) {
      await createAvailability({
        providerId: provider._id,
        startAt: localTimeOnDay({ dayOffset, hour: hours.start, timeZone }).toISOString(),
        endAt: localTimeOnDay({ dayOffset, hour: hours.end, timeZone }).toISOString(),
        timezone: timeZone
      });
    }
    console.log(`[Seed] Added ${SCHEDULE_DAYS} daily windows (${hours.start}:00-${hours.end}:00 ${timeZone}) for ${demo.name}.`);
  }
}

if (isDirectRun(import.meta.url)) {
  runSeeds('Providers & Schedules', [seedProvidersAndSchedules]);
}
