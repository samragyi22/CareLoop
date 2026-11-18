import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { hashPassword } from '../services/auth.service.js';
import { findUserByEmail, createUser } from '../repositories/user.repository.js';
import { findProviders } from '../repositories/provider.repository.js';
import {
  insertAppointment,
  listAppointmentsByPatient,
  findOverlappingAppointment,
  generateBookingReference
} from '../repositories/appointment.repository.js';
import { localTimeOnDay } from '../utils/time.js';
import { isDirectRun, runSeeds } from './seedRunner.js';

// Synthetic demonstration patients. +1 555 numbers are fictional and can never be dialed for real.
export const DEMO_PATIENTS = [
  {
    name: 'Sunita Devi',
    email: 'patient@careloop.local',
    phone: '+15550100101',
    password: 'CareLoopPatient2026!'
  },
  {
    name: 'Ramesh Kumar',
    email: 'patient2@careloop.local',
    phone: '+15550100102',
    password: 'CareLoopPatient2026!'
  }
];

const APPOINTMENT_MINUTES = 30;

/**
 * Creates synthetic patient accounts, each with one upcoming and one past appointment.
 * Expects an open DB connection and seeded providers. Safe to re-run.
 */
export async function seedPatients() {
  const timeZone = env.DEFAULT_TIMEZONE;
  const providers = await findProviders({ isActive: true });
  const primaryProvider = providers.find(p => p.specialty === 'General Practice') || providers[0] || null;
  if (!primaryProvider) {
    console.warn('[Seed] No active providers found. Run the provider seed first; skipping sample appointments.');
  }

  for (let i = 0; i < DEMO_PATIENTS.length; i++) {
    const demo = DEMO_PATIENTS[i];
    let user = await findUserByEmail(demo.email);
    if (!user) {
      user = await createUser({
        name: demo.name,
        email: demo.email,
        phone: demo.phone,
        passwordHash: await hashPassword(demo.password),
        role: 'patient',
        isActive: true,
        isSynthetic: true
      });
      console.log(`[Seed] Created synthetic patient ${demo.name} (${demo.email}).`);
    } else {
      console.log(`[Seed] Patient already exists: ${user.name} (${demo.email}).`);
    }

    if (!primaryProvider) continue;

    const appointments = await listAppointmentsByPatient({ patientUserId: user._id, email: demo.email });
    const hasUpcoming = appointments.some(a => a.status === 'confirmed' && new Date(a.startAt) > new Date());
    if (hasUpcoming) continue;

    const providerObjectId = new ObjectId(primaryProvider._id);
    const patient = { name: user.name, email: demo.email, phone: demo.phone, isSynthetic: true };

    // Upcoming appointment two days out, inside the seeded 9:00-17:00 local schedule
    const upcomingStart = localTimeOnDay({ dayOffset: 2, hour: 10 + i * 2, timeZone });
    const upcomingEnd = new Date(upcomingStart.getTime() + APPOINTMENT_MINUTES * 60 * 1000);
    const conflict = await findOverlappingAppointment(providerObjectId, upcomingStart, upcomingEnd);
    if (conflict) {
      console.warn(`[Seed] Skipping upcoming appointment for ${demo.name}: slot already taken (${conflict.bookingReference}).`);
    } else {
      await insertAppointment({
        bookingReference: generateBookingReference(),
        providerId: providerObjectId,
        patientUserId: user._id,
        patient,
        startAt: upcomingStart,
        endAt: upcomingEnd,
        status: 'confirmed'
      });
    }

    // Past visit ten days ago (historical record for the portal's "past" tab)
    const pastStart = localTimeOnDay({ dayOffset: -10, hour: 14, timeZone });
    await insertAppointment({
      bookingReference: generateBookingReference(),
      providerId: providerObjectId,
      patientUserId: user._id,
      patient,
      startAt: pastStart,
      endAt: new Date(pastStart.getTime() + APPOINTMENT_MINUTES * 60 * 1000),
      status: 'completed'
    });

    console.log(`[Seed] Created sample appointments for ${demo.name}.`);
  }
}

if (isDirectRun(import.meta.url)) {
  runSeeds('Synthetic Patients', [seedPatients]);
}
