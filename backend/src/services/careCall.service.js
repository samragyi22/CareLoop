import crypto from 'crypto';
import twilio from 'twilio';
import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { findPatientRecordById } from '../repositories/patient.repository.js';
import { findApprovalById } from '../repositories/approval.repository.js';
import {
  createVoiceCall,
  hasActiveOrRecentCallWith,
  maskPhoneNumber,
  listLiveCallsWith,
  updateVoiceCallStatus
} from '../repositories/voiceCall.repository.js';
import { normalizeE164Phone } from '../repositories/callbackConsent.repository.js';
import { insertTaskEvents } from '../repositories/taskEvent.repository.js';
import { getCarePlansForPatientRecord } from './patientCarePlan.service.js';
import {
  createUltravoxCallSession,
  cancelUltravoxCallSession,
  isUltravoxConfigured,
  carePlanCallGreeting,
  healthCheckCallGreeting
} from './ultravox.service.js';
import { CarePlanError } from './carePlan.service.js';
import { rememberCall, rememberCarePlans } from './callContextCache.js';
import { isSyntheticPhone } from '../utils/synthetic.js';

/**
 * PlanPilot care calls: the clinic phones the patient (Twilio + Ultravox) about their care plan,
 * usually to get their yes/no on an option waiting for them. The voice agent then uses the
 * care-plan tools (get_my_care_plan, respond_to_care_option, report_care_problem) on the call.
 * Synthetic patients and mock mode always get a simulated call; nothing real rings.
 */

const SYSTEM_ACTOR = { type: 'system', id: null, name: 'PlanPilot phone outreach' };

function redact(message) {
  let text = String(message || '');
  for (const secret of [env.TWILIO_AUTH_TOKEN, env.TWILIO_ACCOUNT_SID, env.ULTRAVOX_API_KEY]) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

/**
 * Corrects calls the database still shows as live by asking Twilio for their real status. Twilio's
 * "call ended" webhook can be missed (for example if the public tunnel was down when the call
 * ended), which would otherwise block new calls to this number for up to 30 minutes.
 */
async function syncLiveCallStatuses(phone) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return;
  const live = await listLiveCallsWith(phone);
  if (live.length === 0) return;
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  for (const call of live) {
    try {
      const real = await client.calls(call.callSid).fetch();
      if (!['queued', 'initiated', 'ringing', 'in-progress'].includes(real.status)) {
        await updateVoiceCallStatus(call.callSid, real.status, { durationSeconds: Number(real.duration) || 0 });
      }
    } catch (err) {
      // A call Twilio does not know about cannot be live
      if (err.status === 404) await updateVoiceCallStatus(call.callSid, 'failed', { errorNote: 'Not found at Twilio' });
    }
  }
}

/**
 * The assistant's tools reach this server through PUBLIC_URL (the ngrok tunnel). If the tunnel is
 * down the phone would still ring, but the assistant could not check symptoms or book anything,
 * so stop before dialling and say what to fix.
 */
async function assertToolsReachable() {
  const base = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/health`, {
      headers: { 'ngrok-skip-browser-warning': '1' },
      signal: AbortSignal.timeout(6000)
    });
    const body = await res.json();
    if (res.ok && body.status === 'ok') return;
  } catch (_) {
    // Reported below
  }
  throw new CarePlanError(
    `The phone assistant cannot reach CareLoop at ${base || 'PUBLIC_URL'}. Make sure ngrok is running, then try again.`,
    'TUNNEL_OFFLINE',
    503
  );
}

async function logOnTask(taskId, planId, reason) {
  if (!taskId || !planId) return;
  await insertTaskEvents([{
    taskId: new ObjectId(taskId),
    planId: new ObjectId(planId),
    kind: 'patient_called',
    from: null,
    to: null,
    actor: { type: SYSTEM_ACTOR.type, id: null, name: SYSTEM_ACTOR.name },
    reason,
    at: new Date()
  }]).catch(() => {});
}

/**
 * Places one care call to the patient. With approvalId, the call is about that waiting option;
 * otherwise about the first option waiting for them (or a general check-in).
 *
 * @param {boolean} args.skipIfBusy  automation: quietly skip (instead of erroring) when the patient
 *   is already on a call or was called in the last few minutes
 */
export async function placeCarePlanCall({ patientId, approvalId = null, skipIfBusy = false }) {
  const patient = await findPatientRecordById(patientId);
  if (!patient) throw new CarePlanError('Patient not found.', 'PATIENT_NOT_FOUND', 404);

  const phone = normalizeE164Phone(patient.phone);
  if (!phone) throw new CarePlanError(`${patient.name} has no valid phone number to call.`, 'NO_PHONE', 400);
  await syncLiveCallStatuses(phone);

  if (await hasActiveOrRecentCallWith(phone)) {
    if (skipIfBusy) return { skipped: true, reason: 'Patient is on a call or was just called.' };
    throw new CarePlanError(`${patient.name} is on a call with the clinic or was called a moment ago. Try again in a few minutes.`, 'CALL_IN_PROGRESS', 409);
  }

  const care = await getCarePlansForPatientRecord(patient);
  rememberCarePlans(patient, care);
  const waiting = care.plans.flatMap(plan => plan.tasks.map(task => ({ plan, task })))
    .filter(({ task }) => task.pendingConfirmation)
    .find(({ task }) => !approvalId || task.pendingConfirmation.approvalId === String(approvalId)) || null;

  const pendingOption = waiting ? {
    taskTitle: waiting.task.title,
    description: waiting.task.pendingConfirmation.description,
    why: waiting.task.pendingConfirmation.why
  } : null;
  const context = {
    patientId: patient._id,
    approvalId: waiting?.task.pendingConfirmation.approvalId || null,
    planId: waiting?.plan._id || care.plans[0]?._id || null,
    taskId: waiting?.task._id || null
  };
  const about = pendingOption ? ` to confirm: ${pendingOption.description}` : ' about their care plan';

  // Synthetic patients and mock mode: record a simulated call, never dial
  if (env.VOICE_MOCK_MODE || patient.isSynthetic || isSyntheticPhone(phone)) {
    const callSid = `CA-MOCK-CARE-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    await createVoiceCall({
      callSid,
      from: env.TWILIO_PHONE_NUMBER || 'CareLoop Clinic',
      to: phone,
      direction: 'outbound',
      status: 'completed',
      callIntent: 'planpilot_care',
      errorNote: 'Simulated call (synthetic patient or mock mode)',
      isMock: true,
      planpilot: context
    });
    await logOnTask(context.taskId, context.planId, `Simulated phone call to ${patient.name}${about}.`);
    return { callSid, status: 'completed', isMock: true, patient: patient.name, about: pendingOption?.description || null };
  }

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
    throw new CarePlanError('Twilio is not configured, so PlanPilot cannot place calls.', 'TWILIO_UNCONFIGURED', 503);
  }
  if (!isUltravoxConfigured()) {
    throw new CarePlanError('Ultravox is not configured, so PlanPilot cannot place calls.', 'ULTRAVOX_UNCONFIGURED', 503);
  }
  await assertToolsReachable();

  const clinicName = env.CLINIC_FACILITY_NAME || 'CareLoop Clinic';
  const agentSessionId = `AGENT-CARE-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  let session;
  try {
    session = await createUltravoxCallSession({
      callSid: agentSessionId,
      isOutbound: true,
      carePlanCallData: { patientName: patient.name, preferredLanguage: patient.preferredLanguage, pendingOption, clinicName },
      initialGreeting: carePlanCallGreeting({ patientName: patient.name, preferredLanguage: patient.preferredLanguage, clinicName: 'CareLoop' })
    });
  } catch (err) {
    await logOnTask(context.taskId, context.planId, `Could not start the phone call to ${patient.name}: ${redact(err.message)}`);
    throw new CarePlanError(`Could not start the voice session: ${redact(err.message)}`, err.code || 'ULTRAVOX_SESSION_FAILED', err.statusCode || 502);
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.connect().stream({ url: session.joinUrl });
  const statusCallback = env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/+$/, '')}/api/voice/status` : undefined;

  let call;
  try {
    call = await twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN).calls.create({
      to: phone,
      from: env.TWILIO_PHONE_NUMBER,
      twiml: twiml.toString(),
      statusCallback,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });
  } catch (err) {
    await cancelUltravoxCallSession(session.callId).catch(() => {});
    const hint = err.code === 21219 ? ' (Twilio trial accounts can only call verified numbers)' : '';
    await logOnTask(context.taskId, context.planId, `Could not call ${patient.name}: ${redact(err.message)}${hint}`);
    throw new CarePlanError(`Twilio could not place the call: ${redact(err.message)}${hint}`, 'TWILIO_CALL_FAILED', 502);
  }

  const record = {
    callSid: call.sid,
    agentSessionId,
    from: env.TWILIO_PHONE_NUMBER,
    to: phone,
    direction: 'outbound',
    status: call.status || 'queued',
    callIntent: 'planpilot_care',
    ultravoxCallId: session.callId,
    joinUrl: session.joinUrl,
    isMock: false,
    planpilot: context
  };
  await createVoiceCall(record);
  rememberCall(agentSessionId, record);
  await logOnTask(context.taskId, context.planId, `PlanPilot is calling ${patient.name} (${maskPhoneNumber(phone)})${about}.`);
  console.log(`[PlanPilot Call] Calling ${maskPhoneNumber(phone)}${about} (${call.sid})`);

  return { callSid: call.sid, status: call.status || 'queued', isMock: false, patient: patient.name, about: pendingOption?.description || null };
}

/**
 * Health check-in call: the clinic phones any person (they need not be a patient yet), asks whether
 * they have a health problem, and runs the symptom-check protocol on the call.
 */
export async function placeHealthCheckCall({ name = '', phone, preferredLanguage = 'hi' }) {
  const normalized = normalizeE164Phone(phone);
  if (!normalized) throw new CarePlanError('Enter a phone number with country code, e.g. +919876543210.', 'INVALID_PHONE', 400);
  await syncLiveCallStatuses(normalized);
  if (await hasActiveOrRecentCallWith(normalized, { recentMs: 0 })) {
    throw new CarePlanError('This number is on a call with the clinic right now. Try again in a moment.', 'CALL_IN_PROGRESS', 409);
  }
  const language = preferredLanguage === 'en' ? 'en' : 'hi';
  const context = { purpose: 'health_check', callerName: String(name || '').trim().slice(0, 80) || null };

  if (env.VOICE_MOCK_MODE || isSyntheticPhone(normalized)) {
    const callSid = `CA-MOCK-HEALTH-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    await createVoiceCall({
      callSid, from: env.TWILIO_PHONE_NUMBER || 'CareLoop Clinic', to: normalized, direction: 'outbound', status: 'completed',
      callIntent: 'health_check', errorNote: 'Simulated call (fictional number or mock mode)', isMock: true, planpilot: context
    });
    return { callSid, status: 'completed', isMock: true, person: context.callerName || normalized };
  }
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
    throw new CarePlanError('Twilio is not configured, so CareLoop cannot place calls.', 'TWILIO_UNCONFIGURED', 503);
  }
  if (!isUltravoxConfigured()) {
    throw new CarePlanError('Ultravox is not configured, so CareLoop cannot place calls.', 'ULTRAVOX_UNCONFIGURED', 503);
  }
  await assertToolsReachable();

  const agentSessionId = `AGENT-HEALTH-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  let session;
  try {
    session = await createUltravoxCallSession({
      callSid: agentSessionId,
      isOutbound: true,
      healthCheckCallData: { personName: context.callerName || '', preferredLanguage: language, clinicName: env.CLINIC_FACILITY_NAME || 'CareLoop Clinic' },
      initialGreeting: healthCheckCallGreeting({ personName: context.callerName || '', preferredLanguage: language })
    });
  } catch (err) {
    throw new CarePlanError(`Could not start the voice session: ${redact(err.message)}`, err.code || 'ULTRAVOX_SESSION_FAILED', err.statusCode || 502);
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.connect().stream({ url: session.joinUrl });
  let call;
  try {
    call = await twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN).calls.create({
      to: normalized,
      from: env.TWILIO_PHONE_NUMBER,
      twiml: twiml.toString(),
      statusCallback: env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/+$/, '')}/api/voice/status` : undefined,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });
  } catch (err) {
    await cancelUltravoxCallSession(session.callId).catch(() => {});
    const hint = err.code === 21219 ? ' (Twilio trial accounts can only call verified numbers)' : '';
    throw new CarePlanError(`Twilio could not place the call: ${redact(err.message)}${hint}`, 'TWILIO_CALL_FAILED', 502);
  }

  const record = {
    callSid: call.sid, agentSessionId, from: env.TWILIO_PHONE_NUMBER, to: normalized, direction: 'outbound',
    status: call.status || 'queued', callIntent: 'health_check', ultravoxCallId: session.callId, joinUrl: session.joinUrl,
    isMock: false, planpilot: context
  };
  await createVoiceCall(record);
  rememberCall(agentSessionId, record);
  console.log(`[Health Check Call] Calling ${maskPhoneNumber(normalized)} (${call.sid})`);
  return { callSid: call.sid, status: call.status || 'queued', isMock: false, person: context.callerName || maskPhoneNumber(normalized) };
}

/**
 * Automation hook: when an option starts waiting for the patient, call them to ask.
 * Fire-and-forget: a failed call is logged on the task and never breaks the approval itself.
 */
export function autoCallForApproval(approvalId) {
  if (!env.PLANPILOT_AUTO_CALL_PATIENTS || env.NODE_ENV === 'test') return;
  (async () => {
    const approval = await findApprovalById(approvalId);
    if (approval?.status !== 'pending_patient') return;
    await placeCarePlanCall({ patientId: approval.patientId, approvalId, skipIfBusy: true });
  })().catch(err => console.warn(`[PlanPilot Call] Automatic call not placed: ${err.message}`));
}
