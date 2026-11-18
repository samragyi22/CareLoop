import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { getDb } from '../config/db.js';
import { findPatientRecordsByPhone, createPatientRecord } from '../repositories/patient.repository.js';
import { listFacilities } from '../repositories/serviceDirectory.repository.js';
import { findProviders } from '../repositories/provider.repository.js';
import {
  insertSymptomCheck,
  saveSymptomCheckForCall,
  findSymptomCheckById,
  findSymptomCheckByCallSid,
  updateSymptomCheck,
  listSymptomChecks,
  listUnreviewedAlerts
} from '../repositories/symptomCheck.repository.js';
import { createBooking } from './booking.service.js';
import { assessSymptoms, CARE_LEVELS } from './triageRules.js';
import { CarePlanError } from './carePlan.service.js';
import { isSyntheticPhone } from '../utils/synthetic.js';
import { formatClinicTime } from '../utils/time.js';
import { SOURCES, PROTOCOL_VERSION } from '../config/triageProtocol.js';

/**
 * Phone health checks: runs the symptom-check protocol on what a caller reported, records the
 * result, adds unknown callers as patient records, finds real slots with the clinic's own doctors,
 * and books the appointment the caller agreed to.
 */

const HOUR_MS = 60 * 60 * 1000;
// How soon the appointment should be, by care level
const BOOKING_WINDOW_HOURS = { urgent: 48, doctor_visit: 7 * 24 };
const FALLBACK_WINDOW_HOURS = 14 * 24;
// Never offer a slot that starts too soon for the caller to get there
const MIN_LEAD_MS = 2 * HOUR_MS;
const PRIMARY_CLINIC = 'CARELOOP-DISTRICT';

/**
 * The patient record for this caller (created on the first health call for an unknown number).
 */
async function patientForCaller(phone, callerName) {
  if (!phone) return null;
  const records = await findPatientRecordsByPhone(phone);
  if (records.length === 1) return records[0];
  if (records.length > 1) {
    const first = String(callerName || '').trim().split(/\s+/)[0]?.toLowerCase();
    return records.find(r => r.name.toLowerCase().split(/\s+/)[0] === first) || records[0];
  }
  return createPatientRecord({
    name: String(callerName || '').trim() || 'Phone caller',
    phone,
    preferredLanguage: 'hi',
    isSynthetic: isSyntheticPhone(phone)
  });
}

// The clinic's own doctors by specialty (from the service directory), remembered for a few minutes
// so a phone call never waits on looking them up again
const DOCTOR_CACHE_MS = 5 * 60 * 1000;
let doctorCache = { at: 0, bySpecialty: null };

async function clinicDoctorsBySpecialty() {
  if (doctorCache.bySpecialty && Date.now() - doctorCache.at < DOCTOR_CACHE_MS) return doctorCache.bySpecialty;

  const clinics = (await listFacilities({ category: 'clinic' }))
    .filter(f => (f.modality || 'in_person') === 'in_person')
    .sort((a, b) => Number(b.code === PRIMARY_CLINIC) - Number(a.code === PRIMARY_CLINIC));
  const ids = [...new Set(clinics.flatMap(c => (c.providerIds || []).map(String)))];
  const providers = ids.length
    ? await getDb().collection('providers').find({ _id: { $in: ids.map(id => new ObjectId(id)) }, isActive: true }).toArray()
    : [];

  const bySpecialty = new Map();
  for (const clinic of clinics) {
    for (const id of clinic.providerIds || []) {
      const provider = providers.find(p => String(p._id) === String(id));
      if (!provider) continue;
      const list = bySpecialty.get(provider.specialty) || [];
      if (!list.some(d => String(d.provider._id) === String(provider._id))) list.push({ provider, clinic });
      bySpecialty.set(provider.specialty, list);
    }
  }
  doctorCache = { at: Date.now(), bySpecialty };
  return bySpecialty;
}

/**
 * Loads the doctor list ahead of time (at server start) so the first health call is as fast as the rest.
 */
export async function warmHealthCheckCache() {
  try {
    await clinicDoctorsBySpecialty();
  } catch (err) {
    console.warn(`[Health Check] Could not preload the doctor list: ${err.message}`);
  }
}

/**
 * Earliest open slots for the specialty with the clinic's own doctors (district clinic first),
 * within the window the care level calls for (falling back to two weeks). Fetches every doctor's
 * schedule and bookings in two parallel queries, so it stays fast even on a distant database.
 * Slots are built exactly as the booking engine does: fixed-length from each window's start,
 * in the future, and not overlapping a confirmed booking.
 */
export async function findTriageSlots(specialty, careLevel, { limit = 3 } = {}) {
  let doctors = (await clinicDoctorsBySpecialty()).get(specialty) || [];
  if (doctors.length === 0) {
    doctors = (await findProviders({ specialty, isActive: true })).map(provider => ({ provider, clinic: null }));
  }
  if (doctors.length === 0) return [];

  const now = Date.now();
  const until = new Date(now + FALLBACK_WINDOW_HOURS * HOUR_MS);
  const ids = doctors.map(d => new ObjectId(String(d.provider._id)));
  const db = getDb();
  const [windows, booked] = await Promise.all([
    db.collection('availability').find({ providerId: { $in: ids }, status: 'active', endAt: { $gt: new Date(now) }, startAt: { $lt: until } }).toArray(),
    db.collection('appointments').find({ providerId: { $in: ids }, status: 'confirmed', startAt: { $lt: until }, endAt: { $gt: new Date(now) } }).toArray()
  ]);

  const slotMs = env.DEFAULT_SLOT_DURATION_MINUTES * 60 * 1000;
  const all = [];
  for (const win of windows) {
    const doctor = doctors.find(d => String(d.provider._id) === String(win.providerId));
    const busy = booked.filter(b => String(b.providerId) === String(win.providerId));
    for (let start = new Date(win.startAt).getTime(); start + slotMs <= new Date(win.endAt).getTime(); start += slotMs) {
      const end = start + slotMs;
      if (start < now + MIN_LEAD_MS || end > until.getTime()) continue;
      if (busy.some(b => new Date(b.startAt).getTime() < end && new Date(b.endAt).getTime() > start)) continue;
      all.push({
        providerId: String(doctor.provider._id),
        providerName: doctor.provider.name,
        specialty: doctor.provider.specialty,
        facilityName: doctor.clinic?.name || 'CareLoop clinic',
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        spoken: formatClinicTime(start, env.DEFAULT_TIMEZONE)
      });
    }
  }
  all.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  const windowEnd = now + (BOOKING_WINDOW_HOURS[careLevel] || FALLBACK_WINDOW_HOURS) * HOUR_MS;
  const preferred = all.filter(s => new Date(s.endAt).getTime() <= windowEnd);
  return (preferred.length ? preferred : all).slice(0, limit);
}

/**
 * Runs the protocol on what the caller reported and records the result.
 */
export async function runSymptomCheck({ phone = null, callerName = '', channel = 'phone', callSid = null, input }) {
  const decision = assessSymptoms(input);
  // The caller lookup and the slot search run at the same time. Doctor and urgent cases need a slot;
  // mild cases are offered one too ("book a doctor, or try the medicine first?")
  const [patient, slots] = await Promise.all([
    decision.careLevel === 'need_more_info' ? null : patientForCaller(phone, callerName),
    ['doctor_visit', 'urgent', 'self_care'].includes(decision.careLevel) && decision.specialty
      ? findTriageSlots(decision.specialty, decision.careLevel === 'self_care' ? 'doctor_visit' : decision.careLevel)
      : []
  ]);

  if (decision.careLevel === 'need_more_info') return { check: null, decision, slots };

  const now = new Date();
  const check = await saveSymptomCheckForCall({
    callSid,
    channel,
    phone,
    patientId: patient?._id || null,
    callerName: String(callerName || patient?.name || '').trim() || null,
    reported: {
      symptoms: String(input.symptoms || '').slice(0, 1000),
      mainSymptom: input.mainSymptom || null,
      durationDays: decision.durationDays,
      severity: decision.severity,
      happeningNow: decision.happeningNow,
      age: input.age ?? null,
      pregnant: input.pregnant ?? null,
      conditions: input.conditions || null,
      allergies: input.allergies || null
    },
    careLevel: decision.careLevel,
    careLevelLabel: CARE_LEVELS[decision.careLevel]?.label || decision.careLevel,
    reason: decision.reason,
    categories: decision.categories,
    redFlags: decision.redFlags,
    specialty: decision.specialty,
    advice: decision.advice,
    offeredSlots: slots,
    appointment: null,
    followUpOn: decision.followUpInDays ? new Date(now.getTime() + decision.followUpInDays * 24 * HOUR_MS) : null,
    protocolVersion: PROTOCOL_VERSION,
    isSynthetic: isSyntheticPhone(phone),
    reviewedAt: null,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now
  });
  return { check, decision, slots };
}

/**
 * Books the slot the caller agreed to: by its number in the offered list (1 = first), or by its
 * start time. The phone must match the one the check was recorded for.
 */
export async function bookTriageAppointment({ checkId, phone, slotNumber, providerId, slotStartAt }) {
  const check = await findSymptomCheckById(checkId);
  if (!check || (check.phone && phone && check.phone !== phone)) {
    throw new CarePlanError('That symptom check was not found for this caller.', 'CHECK_NOT_FOUND', 404);
  }
  if (!['doctor_visit', 'urgent', 'self_care'].includes(check.careLevel)) {
    throw new CarePlanError('This symptom check does not need an appointment.', 'NO_APPOINTMENT_NEEDED', 400);
  }
  if (check.appointment) {
    const spoken = formatClinicTime(check.appointment.startAt, env.DEFAULT_TIMEZONE);
    return { check, appointment: { ...check.appointment, spoken }, alreadyBooked: true };
  }

  // The slot must be one offered on this call; the booking engine re-checks it is still free
  const offered = check.offeredSlots || [];
  const number = Number(slotNumber);
  const startMs = slotStartAt ? new Date(slotStartAt).getTime() : NaN;
  const sameTime = offered.filter(s => new Date(s.startAt).getTime() === startMs);
  const slot = (Number.isInteger(number) && number >= 1 ? offered[number - 1] : null)
    || sameTime.find(s => s.providerId === String(providerId)) || sameTime[0]
    || (!slotNumber && !slotStartAt ? offered[0] : null);
  if (!slot) {
    const err = new CarePlanError('That slot was not one offered on this call.', 'SLOT_NOT_OFFERED', 400);
    err.offered = offered;
    throw err;
  }
  // When the slot has gone, the fresh slots become this call's offer (so "slotNumber 1" is the new first one)
  const slotTaken = async () => {
    const err = new CarePlanError('That time is no longer free.', 'SLOT_TAKEN', 409);
    err.nextSlots = await findTriageSlots(check.specialty, check.careLevel === 'self_care' ? 'doctor_visit' : check.careLevel);
    await updateSymptomCheck(check._id, { offeredSlots: err.nextSlots });
    return err;
  };

  let appointment;
  try {
    ({ appointment } = await createBooking({
      providerId: slot.providerId,
      startAt: slot.startAt,
      endAt: slot.endAt,
      patient: { name: check.callerName || 'Phone caller', phone: check.phone || '', isSynthetic: Boolean(check.isSynthetic) },
      idempotencyKey: `health-check-${check._id}`
    }));
  } catch (err) {
    if (['SLOT_CONFLICT', 'OUTSIDE_AVAILABILITY', 'PAST_SLOT_NOT_ALLOWED'].includes(err.code)) throw await slotTaken();
    throw err;
  }

  const booked = {
    bookingReference: appointment.bookingReference,
    appointmentId: String(appointment._id),
    providerName: slot.providerName,
    specialty: slot.specialty,
    facilityName: slot.facilityName,
    startAt: new Date(appointment.startAt)
  };
  const updated = await updateSymptomCheck(check._id, { appointment: booked });
  return { check: updated, appointment: { ...booked, startAt: booked.startAt.toISOString(), spoken: slot.spoken } };
}

/**
 * A health call that ended before its check finished (the caller hung up early, or the assistant
 * could not reach its tools and promised a call back) is recorded as "call back", so the clinic
 * sees it in Health Calls and the review queue and follows up.
 */
export async function noteUnfinishedHealthCall(call) {
  const sessionId = call.agentSessionId || call.callSid;
  if (!sessionId || await findSymptomCheckByCallSid(sessionId)) return null;
  const phone = call.direction === 'outbound' ? call.to : call.from;
  const now = new Date();
  return insertSymptomCheck({
    callSid: sessionId,
    channel: call.direction === 'outbound' ? 'outbound_call' : 'inbound_call',
    phone,
    patientId: null,
    callerName: call.planpilot?.callerName || null,
    reported: null,
    careLevel: 'call_back',
    careLevelLabel: CARE_LEVELS.call_back.label,
    reason: 'The call ended before the health check finished. Please call them back.',
    categories: [],
    redFlags: [],
    specialty: null,
    advice: null,
    offeredSlots: [],
    appointment: null,
    followUpOn: null,
    protocolVersion: PROTOCOL_VERSION,
    isSynthetic: isSyntheticPhone(phone),
    reviewedAt: null,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now
  });
}

export async function listHealthChecks() {
  return listSymptomChecks({ limit: 100 });
}

export async function markHealthCheckReviewed(id, actor) {
  const check = await findSymptomCheckById(id);
  if (!check) throw new CarePlanError('Symptom check not found.', 'CHECK_NOT_FOUND', 404);
  return updateSymptomCheck(id, { reviewedAt: new Date(), reviewedBy: { type: actor.type, name: actor.name } });
}

export async function listHealthAlerts() {
  return listUnreviewedAlerts();
}

export function getProtocolInfo() {
  return { version: PROTOCOL_VERSION, sources: SOURCES, careLevels: CARE_LEVELS };
}
