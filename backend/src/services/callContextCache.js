import { findVoiceCallBySession } from '../repositories/voiceCall.repository.js';
import { getCarePlansForPatientRecord } from './patientCarePlan.service.js';

/**
 * Short-lived memory of what a live phone call needs: which call it is (who was called, for which
 * patient) and that patient's care plans. Filled when CareLoop places the call, so the assistant's
 * tools answer without waiting on a distant database while the caller listens to silence.
 * Only reads are served from here; every write still goes through the guarded services, which
 * re-check the database, so a slightly old copy can never cause a wrong booking or answer.
 */

const CALL_TTL_MS = 30 * 60 * 1000;
const CARE_PLAN_TTL_MS = 2 * 60 * 1000;

const calls = new Map(); // session id -> { at, call }
const carePlans = new Map(); // patient id -> { at, patient, care }

function fresh(entry, ttl) {
  return entry && Date.now() - entry.at < ttl ? entry : null;
}

function prune(map, ttl) {
  for (const [key, entry] of map) if (!fresh(entry, ttl)) map.delete(key);
}

/**
 * Remembers a call the moment it is placed (under its agent session id, which the tools receive).
 */
export function rememberCall(sessionId, call) {
  if (!sessionId || !call) return;
  prune(calls, CALL_TTL_MS);
  calls.set(sessionId, { at: Date.now(), call });
}

/**
 * The call for a tool's session id: from memory, or the database (then remembered).
 * Tools only read who the call is with and what it is for, which never change during a call.
 */
export async function callForSession(sessionId) {
  const cached = fresh(calls.get(sessionId), CALL_TTL_MS);
  if (cached) return cached.call;
  const call = await findVoiceCallBySession(sessionId);
  if (call) rememberCall(sessionId, call);
  return call;
}

export function rememberCarePlans(patient, care) {
  if (!patient?._id) return;
  prune(carePlans, CARE_PLAN_TTL_MS);
  carePlans.set(String(patient._id), { at: Date.now(), patient, care });
}

/**
 * A patient's record and care plans if loaded in the last two minutes (e.g. while placing the call).
 */
export function recentCarePlans(patientId) {
  return fresh(carePlans.get(String(patientId)), CARE_PLAN_TTL_MS);
}

export async function carePlansFor(patient) {
  const cached = recentCarePlans(patient._id);
  if (cached) return cached.care;
  const care = await getCarePlansForPatientRecord(patient);
  rememberCarePlans(patient, care);
  return care;
}

/**
 * Called after anything on the call changes the patient's plans, so the next read is fresh.
 */
export function forgetCarePlans(patientId) {
  carePlans.delete(String(patientId));
}
