import { env } from '../config/env.js';
import { normalizeE164Phone } from '../repositories/callbackConsent.repository.js';
import { findPatientRecordsByPhone, findPatientRecordById } from '../repositories/patient.repository.js';
import { findApprovalById } from '../repositories/approval.repository.js';
import { getCarePlansForPatientRecord } from './patientCarePlan.service.js';
import { respondAsPatient } from './approval.service.js';
import { reportProblemAsPatient } from './patientActions.service.js';
import { runAgentForPlan } from './orchestrator.service.js';
import { formatClinicTime } from '../utils/time.js';
import { callForSession, recentCarePlans, carePlansFor, forgetCarePlans } from './callContextCache.js';

/**
 * PlanPilot tools for the phone agent (Ultravox): patients hear their care plan, answer waiting
 * options, and report problems by phone. The caller is identified by the call's phone number (or,
 * for PlanPilot's own outbound calls, by the patient the call was placed for). Every action goes
 * through the same guarded services as the clinician screens.
 */

function phoneActor(patient) {
  return { type: 'patient', id: patient.userId || null, name: `${patient.name} (by phone)` };
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

async function identifyCaller(callSid, patientName = null) {
  const call = await callForSession(callSid);
  if (!call) {
    return { error: { status: 'failed', message: 'This call could not be identified. Offer appointment help or ask them to contact clinic staff.' } };
  }
  if (call.planpilot?.patientId) {
    const patient = recentCarePlans(call.planpilot.patientId)?.patient || await findPatientRecordById(call.planpilot.patientId);
    if (patient) return { patient, call };
  }

  const phone = normalizeE164Phone(call.direction === 'outbound' ? call.to : call.from);
  const records = phone ? await findPatientRecordsByPhone(phone) : [];
  if (records.length === 0) {
    return { error: { status: 'not_found', message: 'No care plan is linked to this phone number. Offer appointment help instead, or ask them to contact clinic staff.' } };
  }
  if (records.length === 1) return { patient: records[0], call };

  if (patientName) {
    const first = String(patientName).trim().split(/\s+/)[0].toLowerCase();
    const match = records.find(r => r.name.toLowerCase().split(/\s+/)[0] === first);
    if (match) return { patient: match, call };
  }
  return {
    error: {
      status: 'needs_identification',
      message: `More than one patient uses this phone. Ask who they are calling about (${records.map(r => r.name.split(' ')[0]).join(' or ')}), then call get_my_care_plan again with patientName.`
    }
  };
}

function waitingOption(task) {
  if (!task.pendingConfirmation) return null;
  return {
    approvalId: task.pendingConfirmation.approvalId,
    forStep: task.title,
    option: task.pendingConfirmation.description,
    why: task.pendingConfirmation.why,
    doctorAlreadyApproved: task.pendingConfirmation.approvedByDoctor
  };
}

/**
 * The first option waiting for this patient's answer in the plan, after PlanPilot re-planned.
 */
async function findNewOption(patient, planId) {
  const care = await getCarePlansForPatientRecord(patient);
  const plan = care.plans.find(p => p._id === planId);
  if (!plan) return { option: null, waitingForDoctor: false };
  const task = plan.tasks.find(t => t.pendingConfirmation);
  const waitingForDoctor = plan.tasks.some(t => t.status === 'awaiting_approval');
  return { option: task ? waitingOption(task) : null, waitingForDoctor };
}

/**
 * Re-plans immediately (rules engine, fast) so a new option can be offered while the patient is
 * still on the line. Returns a short spoken summary for the agent.
 */
async function replanForCaller(patient, planId) {
  forgetCarePlans(patient._id);
  try {
    await runAgentForPlan({ planId, trigger: 'phone_call', rulesOnly: true });
  } catch (err) {
    if (err.code !== 'AGENT_BUSY') console.warn(`[PlanPilot Voice] Replanning failed: ${err.message}`);
    return { newOption: null, say: 'The clinic will look for another option and call back.' };
  }
  const { option, waitingForDoctor } = await findNewOption(patient, planId);
  if (option) {
    return {
      newOption: option,
      say: `PlanPilot found another option: ${option.option}. Read it back and ask if it works (then use respond_to_care_option with approvalId ${option.approvalId}).`
    };
  }
  if (waitingForDoctor) {
    return { newOption: null, say: 'The next option needs the doctor\'s approval first. Tell the patient the clinic will call back once the doctor has decided.' };
  }
  return { newOption: null, say: 'Tell the patient the clinic team will look into it and get back to them.' };
}

/**
 * get_my_care_plan
 */
export async function handleGetMyCarePlan({ callSid, patientName } = {}) {
  const { patient, error } = await identifyCaller(callSid, patientName);
  if (error) return error;

  const care = await carePlansFor(patient);
  const active = care.plans.filter(p => p.status === 'active');
  if (active.length === 0) {
    return { status: 'success', action: 'care_plan_read', patientFirstName: patient.name.split(' ')[0], message: 'This patient has no active care plan.' };
  }

  return {
    status: 'success',
    action: 'care_plan_read',
    patientFirstName: patient.name.split(' ')[0],
    plans: active.map(plan => ({
      title: plan.title,
      fromDoctor: plan.approvedBy,
      progress: `${plan.progress.done} of ${plan.progress.total} steps done`,
      openSteps: plan.tasks.filter(t => !t.done).map(t => ({
        taskId: t._id,
        step: t.title,
        status: t.statusLabel,
        whatHappensNext: t.nextStep,
        needsThePatient: t.needsYou,
        problems: t.problems.map(p => p.detail),
        waitingOption: waitingOption(t)
      })),
      doneSteps: plan.tasks.filter(t => t.done).map(t => t.title)
    })),
    guidance: 'Mention waiting options first. Speak only about steps that need the patient, in simple words.'
  };
}

/**
 * respond_to_care_option
 */
export async function handleRespondToCareOption({ callSid, approvalId, decision, confirmed, note } = {}) {
  const { patient, error } = await identifyCaller(callSid);
  if (error) return error;

  const approval = approvalId ? await findApprovalById(approvalId) : null;
  if (!approval || approval.patientId !== patient._id) {
    return { status: 'not_found', message: 'That option was not found for this patient. Call get_my_care_plan to get the current options.' };
  }
  if (decision === 'confirm' && toBoolean(confirmed) !== true) {
    return { status: 'needs_confirmation', message: 'Read the option back and wait for an explicit yes, then call again with confirmed true.' };
  }
  if (approval.status !== 'pending_patient') {
    return { status: 'not_pending', message: 'This option is no longer waiting for the patient. Call get_my_care_plan for the current situation.' };
  }

  const result = await respondAsPatient({
    approvalId,
    decision,
    note: typeof note === 'string' ? note : '',
    actor: phoneActor(patient),
    patientRecordId: patient._id
  });
  forgetCarePlans(patient._id);

  if (result.emergency) {
    return { status: 'emergency', message: `Possible emergency. Say immediately: dial ${result.emergency.emergencyNumber}. ${result.emergency.instructions}` };
  }

  if (decision === 'decline') {
    const next = await replanForCaller(patient, approval.planId);
    return { status: 'success', action: 'care_option_declined', message: `Recorded that it does not work. ${next.say}`, newOption: next.newOption };
  }

  if (result.failure) {
    const next = await replanForCaller(patient, approval.planId);
    return {
      status: 'slot_taken',
      action: 'care_option_failed',
      message: `That time was just taken by someone else, so nothing was booked. ${next.say}`,
      newOption: next.newOption
    };
  }

  const booking = result.booking;
  return {
    status: 'success',
    action: 'care_option_confirmed',
    bookingReference: booking?.bookingReference || null,
    message: booking
      ? `Confirmed and booked: ${formatClinicTime(booking.startAt, env.DEFAULT_TIMEZONE)} with ${booking.providerName}${booking.facilityName ? ` at ${booking.facilityName}` : ''}. Booking reference ${booking.bookingReference}. Tell the patient these details.`
      : `Confirmed: ${approval.description}. Tell the patient what happens next.`
  };
}

/**
 * report_care_problem
 */
export async function handleReportCareProblem({ callSid, taskId, problem, detail, maxTravelKm, hasOwnTransport } = {}) {
  const { patient, error } = await identifyCaller(callSid);
  if (error) return error;

  const result = await reportProblemAsPatient({
    patient,
    taskId,
    problem,
    detail,
    maxTravelKm: maxTravelKm === undefined || maxTravelKm === null || maxTravelKm === '' ? undefined : Number(maxTravelKm),
    hasOwnTransport: toBoolean(hasOwnTransport),
    actor: phoneActor(patient)
  });
  forgetCarePlans(patient._id);

  if (result.emergency) {
    return { status: 'emergency', message: `Possible emergency. Say immediately: dial ${result.emergency.emergencyNumber}. ${result.emergency.instructions}` };
  }
  if (result.sentToDoctor) {
    return { status: 'success', action: 'care_problem_escalated', message: 'This needs the doctor. Tell the patient their doctor will review it and the clinic will contact them. Do not give any medical advice.' };
  }

  const next = await replanForCaller(patient, result.task.planId);
  return { status: 'success', action: 'care_problem_reported', message: `Problem recorded. ${next.say}`, newOption: next.newOption };
}
