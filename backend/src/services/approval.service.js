import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { assessEmergencyRisk } from '../config/emergency.js';
import { findCareTaskById, findCareTasksByIds, listCareTasksByPlan, updateCareTaskLogistics } from '../repositories/careTask.repository.js';
import { findPatientRecordById } from '../repositories/patient.repository.js';
import { findFacilityByCode } from '../repositories/serviceDirectory.repository.js';
import { findProposalById, markProposalSelected } from '../repositories/replanProposal.repository.js';
import { listOpenBarriersByTask, resolveBarrier } from '../repositories/barrier.repository.js';
import { insertTaskEvents } from '../repositories/taskEvent.repository.js';
import { insertEvidence, listEvidenceByTask } from '../repositories/evidence.repository.js';
import {
  insertApproval,
  findApprovalById,
  findOpenApprovalForTask,
  updateApprovalStatus
} from '../repositories/approval.repository.js';
import { createBooking, cancelBooking } from './booking.service.js';
import {
  CarePlanError,
  runInTransaction,
  toStoredActor,
  applyTransitionInSession,
  completeWhenEvidenceSatisfiedInSession,
  loadActiveTask
} from './carePlan.service.js';
import { slotsForFacility } from './feasibility.service.js';
import { autoCallForApproval } from './careCall.service.js';
import { TASK_STATUS, TASK_STATUS_LABELS, EVIDENCE_TYPES, validateTransition } from './taskStateMachine.js';
import { distanceKm, MODALITY_LABELS, BARRIER_CODES, documentLabel } from './feasibilityRules.js';
import { formatClinicTime } from '../utils/time.js';
import { withRetries } from '../utils/retry.js';
import { maybeFail, consumeFault } from '../utils/faults.js';

/**
 * PlanPilot approvals: the only way a proposed alternative (or a slot at the planned facility) is
 * acted on. A chosen option waits for every approval it needs (clinician first when a clinical
 * judgement is involved, then the patient), and only then is it carried out: the slot is booked
 * through the normal booking engine, the task's logistics are updated, and the booking engine's
 * confirmation is recorded as evidence. Nothing is booked before every approval is in.
 */

const SYSTEM_ACTOR = { type: 'system', id: null, name: 'PlanPilot booking engine' };
const SAFETY_ACTOR = { type: 'system', id: null, name: 'PlanPilot safety screen' };
const EXECUTION_ATTEMPTS = 3;
const STALE_EXECUTION_MS = 2 * 60 * 1000;
const OPEN_TASK_STATUSES = new Set([
  TASK_STATUS.SUGGESTED,
  TASK_STATUS.BLOCKED,
  TASK_STATUS.AWAITING_PATIENT,
  TASK_STATUS.AWAITING_APPROVAL
]);
// Booking-engine refusals meaning the chosen slot can no longer be booked; retrying won't help
const SLOT_GONE_CODES = new Set([
  'SLOT_CONFLICT',
  'OUTSIDE_AVAILABILITY',
  'PAST_SLOT_NOT_ALLOWED',
  'PROVIDER_INACTIVE',
  'PROVIDER_NOT_FOUND',
  'IDEMPOTENCY_INACTIVE'
]);

export const APPROVAL_STATUS_LABELS = {
  pending_clinician: 'Waiting for clinician approval',
  pending_patient: 'Waiting for patient confirmation',
  approved: 'Approved, about to be carried out',
  executing: 'Being carried out',
  executed: 'Done',
  rejected: 'Rejected by clinician',
  declined: 'Declined by patient',
  failed: 'Could not be carried out',
  cancelled: 'Withdrawn'
};

function finalStatusFor(kind) {
  if (kind === 'escalate') return TASK_STATUS.ESCALATED;
  if (kind === 'contact_caregiver') return TASK_STATUS.AWAITING_PATIENT;
  return TASK_STATUS.REQUESTED;
}

function cleanText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * One-line description of an option, used in the audit log, the review queue, and the patient view.
 */
export function describeAction(action, timeZone = env.DEFAULT_TIMEZONE) {
  const facility = action.facility;
  switch (action.kind) {
    case 'facility_change':
    case 'modality_change':
    case 'time_change':
    case 'book_planned': {
      if (action.slot) {
        const how = facility?.modality && facility.modality !== 'in_person' ? ` (${MODALITY_LABELS[facility.modality]})` : '';
        return `${facility?.name || 'Planned clinic'}${how}: ${action.slot.providerName}, ${formatClinicTime(action.slot.startAt, timeZone)}`;
      }
      const opening = action.times?.[0] ? `, from ${formatClinicTime(action.times[0].startAt, timeZone)}` : '';
      return `${facility?.name || 'Another facility'} (${MODALITY_LABELS[facility?.modality] || 'in-person visit'}${opening})`;
    }
    case 'request_document':
      return `Request a copy of the ${documentLabel(action.document)}`;
    case 'follow_up_confirmation':
      return 'Follow up with the facility to confirm the request';
    case 'contact_caregiver':
      return `Reach the patient through ${action.caregiverName}`;
    case 'escalate':
      return 'Escalate to a clinician';
    default:
      return action.kind;
  }
}

function facilitySummary(facility, patient) {
  return {
    code: facility.code,
    name: facility.name,
    category: facility.category,
    modality: facility.modality || 'in_person',
    distanceKm: (facility.modality || 'in_person') === 'in_person' ? distanceKm(patient?.location, facility.location) : 0,
    isSimulated: Boolean(facility.isSimulated)
  };
}

function taskEvent(task, actor, fields) {
  return {
    taskId: new ObjectId(task._id),
    planId: new ObjectId(task.planId),
    from: task.status,
    to: task.status,
    actor: toStoredActor(actor),
    at: new Date(),
    ...fields
  };
}

function waitingReason(requires, action) {
  if (requires.clinician) return `Waiting for clinician approval: ${action.approvalReason || 'this changes how care is delivered.'}`;
  if (requires.patient) return 'Waiting for the patient to confirm.';
  return 'No approval needed.';
}

/**
 * Chooses one alternative from a replan proposal and sends it for the approvals it needs.
 * Options that need no approval (e.g. requesting a missing document) are carried out immediately.
 */
export async function chooseAlternative({ taskId, proposalId, alternativeId, slotStartAt = null, actor }) {
  if (!['clinician', 'agent'].includes(actor?.type)) {
    throw new CarePlanError('Only a clinician or the PlanPilot agent can choose an option.', 'ACTOR_NOT_ALLOWED', 403);
  }

  const task = await loadActiveTask(taskId);
  const proposal = await findProposalById(proposalId);
  if (!proposal || proposal.taskId !== task._id) {
    throw new CarePlanError('Proposal not found for this task.', 'PROPOSAL_NOT_FOUND', 404);
  }
  if (proposal.status !== 'proposed') {
    throw new CarePlanError('These options were replaced by a newer check. Reload to see the current options.', 'PROPOSAL_NOT_OPEN', 409);
  }

  const alternative = proposal.alternatives.find(a => a.id === alternativeId);
  if (!alternative) throw new CarePlanError('That option is not part of this proposal.', 'ALTERNATIVE_NOT_FOUND', 404);

  let slot = null;
  if (alternative.timesAre === 'bookable_slots') {
    slot = slotStartAt
      ? alternative.times.find(t => new Date(t.startAt).getTime() === new Date(slotStartAt).getTime())
      : alternative.times[0];
    if (!slot) throw new CarePlanError('That time is not one of the offered slots.', 'SLOT_NOT_OFFERED', 400);
  }

  const action = {
    kind: alternative.kind,
    alternativeId: alternative.id,
    facility: alternative.facility || null,
    slot,
    times: alternative.timesAre === 'opening_hours' ? alternative.times : [],
    document: alternative.document || null,
    caregiverName: alternative.caregiverName || null,
    rationale: alternative.rationale,
    approvalReason: alternative.approvalReason || null,
    resolves: alternative.resolves || []
  };
  // Escalating hands the task to a clinician; it doesn't need anyone's approval to do that
  const requires = alternative.kind === 'escalate'
    ? { clinician: false, patient: false }
    : { clinician: Boolean(alternative.requiresClinicianApproval), patient: Boolean(alternative.requiresPatientConfirmation) };

  return openApproval({ task, action, requires, source: 'replan', proposalId: proposal._id, actor });
}

/**
 * Proposes booking a slot at the facility the clinician planned (no change of place or time).
 * Needs only the patient's confirmation. Defaults to the earliest slot before the deadline.
 */
export async function proposePlannedBooking({ taskId, slotStartAt = null, actor }) {
  if (!['clinician', 'agent'].includes(actor?.type)) {
    throw new CarePlanError('Only a clinician or the PlanPilot agent can propose a booking.', 'ACTOR_NOT_ALLOWED', 403);
  }

  const task = await loadActiveTask(taskId);
  const requirement = task.serviceRequirement || {};
  if (task.type !== 'appointment_booking' || requirement.category !== 'clinic' || !requirement.facilityCode) {
    throw new CarePlanError('Only appointment-booking tasks with a planned clinic can be booked this way.', 'NOT_BOOKABLE', 400);
  }

  const [facility, patient] = await Promise.all([findFacilityByCode(requirement.facilityCode), findPatientRecordById(task.patientId)]);
  if (!facility) throw new CarePlanError('The planned facility is not in the directory.', 'FACILITY_NOT_FOUND', 404);

  const { slotsBeforeDue } = await slotsForFacility(facility, requirement, { now: new Date(), dueAt: new Date(task.dueAt) });
  const slot = slotStartAt
    ? slotsBeforeDue.find(s => new Date(s.startAt).getTime() === new Date(slotStartAt).getTime())
    : slotsBeforeDue[0];
  if (!slot) {
    throw new CarePlanError(slotStartAt ? 'That slot is no longer available.' : 'No open slots before the deadline at the planned facility.', 'NO_SLOT', 409);
  }

  const action = {
    kind: 'book_planned',
    alternativeId: null,
    facility: facilitySummary(facility, patient),
    slot,
    times: [],
    document: null,
    caregiverName: null,
    rationale: `Earliest open slot at the planned ${facility.name} before the deadline.`,
    approvalReason: null,
    resolves: []
  };
  return openApproval({ task, action, requires: { clinician: false, patient: true }, source: 'planned', proposalId: null, actor });
}

async function openApproval({ task, action, requires, source, proposalId, actor }) {
  if (task.status === TASK_STATUS.ESCALATED) {
    throw new CarePlanError('This task is escalated. A clinician must resolve the escalation first.', 'TASK_ESCALATED', 409);
  }
  if (task.status === TASK_STATUS.COMPLETED) {
    throw new CarePlanError('Task is already completed.', 'TASK_CLOSED', 409);
  }

  // Refuse now rather than after a booking exists: the task must be able to move on afterwards
  if (finalStatusFor(action.kind) === TASK_STATUS.REQUESTED) {
    const unfinished = (await findCareTasksByIds(task.dependsOn)).filter(dep => dep.status !== TASK_STATUS.COMPLETED);
    if (unfinished.length) {
      throw new CarePlanError(`Finish these first: ${unfinished.map(dep => dep.title).join(', ')}.`, 'DEPENDENCIES_INCOMPLETE', 422);
    }
  }

  const description = describeAction(action);
  const target = requires.clinician ? TASK_STATUS.AWAITING_APPROVAL : requires.patient ? TASK_STATUS.AWAITING_PATIENT : null;
  const initialStatus = requires.clinician ? 'pending_clinician' : requires.patient ? 'pending_patient' : 'approved';
  const approvalId = new ObjectId();

  let approval;
  try {
    approval = await runInTransaction(async (session) => {
      const current = await findCareTaskById(task._id, { session });
      if (await findOpenApprovalForTask(current._id, { session })) {
        throw new CarePlanError('Another option for this task is already waiting for approval.', 'APPROVAL_ALREADY_OPEN', 409);
      }

      const now = new Date();
      const inserted = await insertApproval({
        _id: approvalId,
        taskId: new ObjectId(current._id),
        planId: new ObjectId(current.planId),
        patientId: new ObjectId(current.patientId),
        source,
        proposalId: proposalId ? new ObjectId(proposalId) : null,
        action,
        description,
        requires,
        status: initialStatus,
        clinicianDecision: null,
        patientDecision: null,
        execution: null,
        requestedBy: toStoredActor(actor),
        createdAt: now,
        updatedAt: now
      }, { session });

      if (proposalId) {
        const selected = await markProposalSelected(proposalId, { alternativeId: action.alternativeId, approvalId }, { session });
        if (!selected) throw new CarePlanError('These options were replaced by a newer check. Reload to see the current options.', 'PROPOSAL_NOT_OPEN', 409);
      }

      await insertTaskEvents([taskEvent(current, actor, {
        kind: 'approval_requested',
        approvalId,
        reason: `Option chosen: ${description}. ${waitingReason(requires, action)}`
      })], { session });

      if (target && current.status !== target) {
        await applyTransitionInSession({ session, task: current, to: target, actor, reason: waitingReason(requires, action) });
      }
      return inserted;
    });
  } catch (err) {
    if (err.code === 11000) throw new CarePlanError('Another option for this task is already waiting for approval.', 'APPROVAL_ALREADY_OPEN', 409);
    throw err;
  }

  if (initialStatus === 'approved') {
    return executeApproval({ approvalId: approval._id, actor });
  }
  // The patient answers by phone: PlanPilot calls them to ask
  if (initialStatus === 'pending_patient') autoCallForApproval(approval._id);
  return { approval, executed: false };
}

/**
 * The clinician's decision on an option that changes how care is delivered (e.g. a teleconsult
 * instead of an in-person visit, or a date after the clinician's deadline).
 */
export async function decideAsClinician({ approvalId, decision, note = '', actor }) {
  if (actor?.type !== 'clinician') {
    throw new CarePlanError('Only a clinician can approve or reject this option.', 'ACTOR_NOT_ALLOWED', 403);
  }
  if (!['approve', 'reject'].includes(decision)) {
    throw new CarePlanError('Decision must be "approve" or "reject".', 'INVALID_DECISION', 400);
  }
  const cleanNote = cleanText(note);
  if (decision === 'reject' && cleanNote.length < 3) {
    throw new CarePlanError('Please say why the option is rejected.', 'REASON_REQUIRED', 400);
  }

  const approval = await findApprovalById(approvalId);
  if (!approval) throw new CarePlanError('Approval not found.', 'APPROVAL_NOT_FOUND', 404);
  if (approval.status !== 'pending_clinician') {
    throw new CarePlanError(`This option is no longer waiting for a clinician (${APPROVAL_STATUS_LABELS[approval.status]}).`, 'APPROVAL_NOT_PENDING', 409);
  }

  const result = await runInTransaction(async (session) => {
    const task = await findCareTaskById(approval.taskId, { session });
    const record = { decision: decision === 'approve' ? 'approved' : 'rejected', by: toStoredActor(actor), at: new Date(), note: cleanNote };
    const next = decision === 'reject' ? 'rejected' : approval.requires.patient ? 'pending_patient' : 'approved';

    const updated = await updateApprovalStatus(approval._id, {
      fromStatuses: ['pending_clinician'],
      to: next,
      set: { clinicianDecision: record }
    }, { session });
    if (!updated) throw new CarePlanError('Someone else just decided on this option. Reload.', 'CONCURRENT_UPDATE', 409);

    if (decision === 'reject') {
      await insertTaskEvents([taskEvent(task, actor, {
        kind: 'approval_rejected',
        approvalId: new ObjectId(approval._id),
        reason: `Clinician rejected: ${approval.description}. ${cleanNote}`
      })], { session });
      if (task.status === TASK_STATUS.AWAITING_APPROVAL) {
        await applyTransitionInSession({ session, task, to: TASK_STATUS.BLOCKED, actor, reason: `Option rejected by clinician: ${cleanNote}` });
      }
      return { approval: updated, execute: false };
    }

    await insertTaskEvents([taskEvent(task, actor, {
      kind: 'approval_granted',
      approvalId: new ObjectId(approval._id),
      reason: `Clinician approved: ${approval.description}.${cleanNote ? ` ${cleanNote}` : ''}`
    })], { session });
    if (next === 'pending_patient' && task.status === TASK_STATUS.AWAITING_APPROVAL) {
      await applyTransitionInSession({ session, task, to: TASK_STATUS.AWAITING_PATIENT, actor, reason: 'Clinician approved; waiting for the patient to confirm.' });
    }
    return { approval: updated, execute: next === 'approved' };
  });

  if (result.execute) return executeApproval({ approvalId: approval._id, actor });
  if (result.approval.status === 'pending_patient') autoCallForApproval(approval._id);
  return { approval: result.approval, executed: false };
}

/**
 * The patient's answer to an option, given in the portal (actor: patient) or recorded by clinic
 * staff after speaking to them (actor: clinician, note required). The agent can never answer for
 * the patient. Free text is screened for emergencies first.
 *
 * @param {string|null} args.patientRecordId  for portal answers: the patient record of the logged-in user
 */
export async function respondAsPatient({ approvalId, decision, note = '', actor, patientRecordId = null }) {
  if (!['patient', 'clinician'].includes(actor?.type)) {
    throw new CarePlanError('Only the patient, or clinic staff recording what the patient said, can answer for the patient.', 'ACTOR_NOT_ALLOWED', 403);
  }
  if (!['confirm', 'decline'].includes(decision)) {
    throw new CarePlanError('Decision must be "confirm" or "decline".', 'INVALID_DECISION', 400);
  }
  const cleanNote = cleanText(note);
  const channel = actor.type === 'patient' ? 'portal' : 'staff_recorded';
  if (channel === 'staff_recorded' && cleanNote.length < 3) {
    throw new CarePlanError('Please note how the patient gave their answer (e.g. "confirmed by phone").', 'REASON_REQUIRED', 400);
  }

  const approval = await findApprovalById(approvalId);
  if (!approval || (actor.type === 'patient' && approval.patientId !== String(patientRecordId))) {
    throw new CarePlanError('Approval not found.', 'APPROVAL_NOT_FOUND', 404);
  }
  if (approval.status !== 'pending_patient') {
    throw new CarePlanError(`This option is not waiting for the patient (${APPROVAL_STATUS_LABELS[approval.status]}).`, 'APPROVAL_NOT_PENDING', 409);
  }

  const risk = cleanNote ? assessEmergencyRisk(cleanNote) : { isEmergency: false };
  if (risk.isEmergency) {
    await runInTransaction(async (session) => {
      const task = await findCareTaskById(approval.taskId, { session });
      await updateApprovalStatus(approval._id, {
        fromStatuses: ['pending_patient'],
        to: 'cancelled',
        set: { cancellation: { by: toStoredActor(SAFETY_ACTOR), at: new Date(), reason: 'Possible emergency in the patient\'s reply' } }
      }, { session });
      await insertTaskEvents([taskEvent(task, actor, {
        kind: 'approval_cancelled',
        approvalId: new ObjectId(approval._id),
        reason: 'Possible emergency described in the patient\'s reply; option withdrawn.'
      })], { session });
      await applyTransitionInSession({
        session,
        task,
        to: TASK_STATUS.ESCALATED,
        actor: SAFETY_ACTOR,
        reason: `Possible emergency described in the patient's reply. Escalated to a clinician immediately; advise calling ${risk.emergencyNumber}.`
      });
    });
    return {
      approval: await findApprovalById(approval._id),
      executed: false,
      emergency: { emergencyNumber: risk.emergencyNumber, instructions: risk.recommendation }
    };
  }

  const result = await runInTransaction(async (session) => {
    const task = await findCareTaskById(approval.taskId, { session });
    const record = { decision: decision === 'confirm' ? 'confirmed' : 'declined', by: toStoredActor(actor), at: new Date(), note: cleanNote, channel };
    const updated = await updateApprovalStatus(approval._id, {
      fromStatuses: ['pending_patient'],
      to: decision === 'confirm' ? 'approved' : 'declined',
      set: { patientDecision: record }
    }, { session });
    if (!updated) throw new CarePlanError('This option was just answered or withdrawn. Reload.', 'CONCURRENT_UPDATE', 409);

    const how = channel === 'portal' ? 'in the patient portal' : `recorded by ${actor.name || 'clinic staff'}: ${cleanNote}`;
    if (decision === 'decline') {
      await insertTaskEvents([taskEvent(task, actor, {
        kind: 'patient_declined',
        approvalId: new ObjectId(approval._id),
        reason: `Patient declined: ${approval.description} (${how}).`
      })], { session });
      if (task.status === TASK_STATUS.AWAITING_PATIENT) {
        await applyTransitionInSession({
          session,
          task,
          to: TASK_STATUS.BLOCKED,
          actor: SYSTEM_ACTOR,
          reason: `Patient declined the proposed option${cleanNote ? `: ${cleanNote}` : '.'}`
        });
      }
      return { approval: updated, execute: false };
    }

    await insertTaskEvents([taskEvent(task, actor, {
      kind: 'patient_confirmed',
      approvalId: new ObjectId(approval._id),
      reason: `Patient confirmed: ${approval.description} (${how}).`
    })], { session });
    return { approval: updated, execute: true };
  });

  if (result.execute) return executeApproval({ approvalId: approval._id, actor });
  return { approval: result.approval, executed: false };
}

/**
 * Withdraws an option that is still waiting (clinician only). The task goes back to Blocked so a
 * different option can be chosen.
 */
export async function cancelApproval({ approvalId, reason = '', actor }) {
  if (actor?.type !== 'clinician') {
    throw new CarePlanError('Only a clinician can withdraw an option.', 'ACTOR_NOT_ALLOWED', 403);
  }
  const cleanReason = cleanText(reason);
  if (cleanReason.length < 3) throw new CarePlanError('Please say why the option is withdrawn.', 'REASON_REQUIRED', 400);

  const approval = await findApprovalById(approvalId);
  if (!approval) throw new CarePlanError('Approval not found.', 'APPROVAL_NOT_FOUND', 404);
  if (!['pending_clinician', 'pending_patient', 'approved'].includes(approval.status)) {
    throw new CarePlanError(`This option can't be withdrawn (${APPROVAL_STATUS_LABELS[approval.status]}).`, 'APPROVAL_NOT_PENDING', 409);
  }

  return runInTransaction(async (session) => {
    const task = await findCareTaskById(approval.taskId, { session });
    const updated = await updateApprovalStatus(approval._id, {
      fromStatuses: ['pending_clinician', 'pending_patient', 'approved'],
      to: 'cancelled',
      set: { cancellation: { by: toStoredActor(actor), at: new Date(), reason: cleanReason } }
    }, { session });
    if (!updated) throw new CarePlanError('This option was just changed by someone else. Reload.', 'CONCURRENT_UPDATE', 409);

    await insertTaskEvents([taskEvent(task, actor, {
      kind: 'approval_cancelled',
      approvalId: new ObjectId(approval._id),
      reason: `Option withdrawn: ${approval.description}. ${cleanReason}`
    })], { session });
    if ([TASK_STATUS.AWAITING_PATIENT, TASK_STATUS.AWAITING_APPROVAL].includes(task.status)) {
      await applyTransitionInSession({ session, task, to: TASK_STATUS.BLOCKED, actor, reason: `Option withdrawn: ${cleanReason}` });
    }
    return { approval: updated, executed: false };
  });
}

/**
 * Carries out an option once every approval it needs is in. Safe to call twice: only one caller
 * can claim it, and bookings use the approval as their idempotency key, so a retry never books twice.
 *
 * Outcomes:
 *   - executed:   booked (if a slot) and the task moved on; booking evidence recorded by the system
 *   - slot taken: approval failed, task back to Blocked so a fresh check can offer other options
 *   - repeated technical failure: approval failed, task escalated to a person (never silent)
 */
export async function executeApproval({ approvalId, actor }) {
  const startedAt = new Date();
  const claimSet = { execution: { startedAt, by: toStoredActor(actor) } };
  let approval = await updateApprovalStatus(approvalId, { fromStatuses: ['approved'], to: 'executing', set: claimSet });
  if (!approval) {
    // Recover an execution that was interrupted (e.g. the server restarted mid-way)
    approval = await updateApprovalStatus(approvalId, {
      fromStatuses: ['executing'],
      to: 'executing',
      set: claimSet,
      extraFilter: { 'execution.startedAt': { $lt: new Date(startedAt.getTime() - STALE_EXECUTION_MS) } }
    });
  }
  if (!approval) {
    const current = await findApprovalById(approvalId);
    if (!current) throw new CarePlanError('Approval not found.', 'APPROVAL_NOT_FOUND', 404);
    if (current.status === 'executed') return { approval: current, executed: true, alreadyDone: true };
    throw new CarePlanError(`This option can't be carried out now (${APPROVAL_STATUS_LABELS[current.status]}).`, 'APPROVAL_NOT_READY', 409);
  }

  const task = await findCareTaskById(approval.taskId);
  if (!task || !OPEN_TASK_STATUSES.has(task.status)) {
    return failApproval({
      approval,
      actor,
      code: 'TASK_CHANGED',
      message: `The task changed while the option was waiting (now "${TASK_STATUS_LABELS[task?.status] || 'missing'}").`,
      outcome: 'cancelled'
    });
  }

  const action = approval.action;
  let appointment = null;
  if (action.slot) {
    const patient = await findPatientRecordById(task.patientId);
    if (consumeFault('slot_taken')) {
      // Demo failure: someone at the clinic desk books this exact slot a moment before PlanPilot does
      await createBooking({
        providerId: action.slot.providerId,
        startAt: action.slot.startAt,
        endAt: action.slot.endAt,
        patient: { name: 'Walk-in Patient (simulated)', phone: '+15550100199', isSynthetic: true }
      }).catch(() => {});
    }
    try {
      appointment = await withRetries(async () => {
        maybeFail('approval_execution');
        const { appointment: booked } = await createBooking({
          providerId: action.slot.providerId,
          startAt: action.slot.startAt,
          endAt: action.slot.endAt,
          patient: { name: patient.name, phone: patient.phone || '', isSynthetic: Boolean(patient.isSynthetic) },
          patientUserId: patient.userId,
          idempotencyKey: `planpilot-approval-${approval._id}`
        });
        return booked;
      }, {
        attempts: EXECUTION_ATTEMPTS,
        isRetryable: err => !SLOT_GONE_CODES.has(err.code) && !(err.statusCode >= 400 && err.statusCode < 500)
      });
    } catch (err) {
      if (SLOT_GONE_CODES.has(err.code)) {
        return failApproval({
          approval,
          actor,
          code: 'SLOT_TAKEN',
          message: `The chosen slot (${formatClinicTime(action.slot.startAt, env.DEFAULT_TIMEZONE)} with ${action.slot.providerName}) could no longer be booked: ${err.message}`,
          taskTo: TASK_STATUS.BLOCKED
        });
      }
      return failApproval({
        approval,
        actor,
        code: 'EXECUTION_ERROR',
        message: `Booking failed after ${err.attempts || EXECUTION_ATTEMPTS} attempts (${err.message}). A person needs to finish this.`,
        taskTo: TASK_STATUS.ESCALATED
      });
    }
  }

  try {
    return await withRetries(
      () => finalizeExecution({ approval, actor, appointment }),
      { attempts: EXECUTION_ATTEMPTS, isRetryable: err => err.name !== 'CarePlanError' }
    );
  } catch (err) {
    // Never leave a booking behind that no task knows about
    if (appointment) {
      await cancelBooking(appointment._id, {
        reason: 'PlanPilot could not attach this booking to the care-plan task',
        cancelledBy: 'system'
      }).catch(() => {});
    }
    return failApproval({
      approval,
      actor,
      code: err.code || 'EXECUTION_ERROR',
      message: `The option could not be applied to the task: ${err.message}`,
      taskTo: err.name === 'CarePlanError' ? null : TASK_STATUS.ESCALATED
    });
  }
}

async function failApproval({ approval, actor, code, message, taskTo = null, outcome = 'failed' }) {
  return runInTransaction(async (session) => {
    const at = new Date();
    const updated = await updateApprovalStatus(approval._id, {
      fromStatuses: ['executing'],
      to: outcome,
      set: { execution: { ...approval.execution, at, outcome, code, error: message } }
    }, { session });

    const task = await findCareTaskById(approval.taskId, { session });
    if (!task) return { approval: updated, executed: false, failure: { code, message } };

    await insertTaskEvents([taskEvent(task, SYSTEM_ACTOR, {
      kind: outcome === 'cancelled' ? 'approval_cancelled' : 'approval_failed',
      approvalId: new ObjectId(approval._id),
      reason: `${approval.description}: ${message}`
    })], { session });

    if (taskTo && task.status !== taskTo) {
      // Prefer recording the system as the one moving the task; fall back to the person who triggered it
      const mover = [SYSTEM_ACTOR, actor].find(candidate => validateTransition(task, taskTo, { actorType: candidate.type }).ok);
      if (mover) await applyTransitionInSession({ session, task, to: taskTo, actor: mover, reason: message });
    }
    return { approval: updated, executed: false, failure: { code, message } };
  });
}

async function finalizeExecution({ approval, actor, appointment }) {
  const timeZone = env.DEFAULT_TIMEZONE;
  const action = approval.action;

  return runInTransaction(async (session) => {
    let task = await findCareTaskById(approval.taskId, { session });
    const oldFacilityCode = task.serviceRequirement?.facilityCode || null;
    const newFacility = action.facility;
    const facilityChanges = Boolean(newFacility && newFacility.code !== oldFacilityCode);

    let outcomeNote = '';
    if (appointment) {
      outcomeNote = ` Booked ${appointment.bookingReference}.`;
    } else if (action.kind === 'facility_change' && newFacility?.modality === 'home_visit') {
      outcomeNote = ' Home sample collection requested (simulated; no real service was contacted).';
    } else if (action.kind === 'facility_change') {
      outcomeNote = ' The patient can go during opening hours; no booking is needed.';
    } else if (['request_document', 'follow_up_confirmation', 'contact_caregiver'].includes(action.kind)) {
      outcomeNote = ' (Simulated: no message was actually sent.)';
    }
    await insertTaskEvents([taskEvent(task, actor, {
      kind: 'approval_executed',
      approvalId: new ObjectId(approval._id),
      reason: `Carried out: ${approval.description}.${outcomeNote}`
    })], { session });

    // 1. Move the task on through the state machine
    const finalStatus = finalStatusFor(action.kind);
    if (task.status !== finalStatus) {
      const reason = action.kind === 'escalate' ? action.rationale : `Approved option carried out: ${approval.description}.`;
      task = (await applyTransitionInSession({ session, task, to: finalStatus, actor, reason })).task;
    }

    // 2. Where and when the task now happens
    let booking = null;
    if (appointment) {
      booking = {
        appointmentId: String(appointment._id),
        bookingReference: appointment.bookingReference,
        providerId: String(action.slot.providerId),
        providerName: action.slot.providerName,
        startAt: new Date(appointment.startAt),
        endAt: new Date(appointment.endAt),
        facilityCode: newFacility?.code || oldFacilityCode,
        facilityName: newFacility?.name || null,
        modality: newFacility?.modality || 'in_person',
        isSimulatedFacility: Boolean(newFacility?.isSimulated)
      };
    }
    const logistics = {};
    if (facilityChanges) {
      logistics.serviceRequirement = { ...task.serviceRequirement, facilityCode: newFacility.code };
      if (!task.originalFacilityCode) logistics.originalFacilityCode = oldFacilityCode;
    }
    if (booking) logistics.booking = booking;
    // A later date only ever comes from a clinician-approved time change
    if (action.kind === 'time_change' && action.slot && new Date(action.slot.endAt) > new Date(task.dueAt)) {
      logistics.dueAt = new Date(action.slot.endAt);
      if (!task.originalDueAt) logistics.originalDueAt = new Date(task.dueAt);
    }
    if (Object.keys(logistics).length) {
      task = await updateCareTaskLogistics(task._id, logistics, { session });
      const parts = [];
      if (facilityChanges) parts.push(`now at ${newFacility.name}`);
      if (booking) parts.push(`booked for ${formatClinicTime(booking.startAt, timeZone)} with ${booking.providerName}`);
      if (logistics.dueAt) parts.push(`deadline moved to ${formatClinicTime(logistics.dueAt, timeZone)} (clinician approved)`);
      await insertTaskEvents([taskEvent(task, SYSTEM_ACTOR, {
        kind: 'logistics_updated',
        approvalId: new ObjectId(approval._id),
        reason: `Task ${parts.join('; ')}. The clinician's instruction is unchanged.`
      })], { session });
    }

    // 3. Barriers about the old facility no longer apply
    if (facilityChanges) {
      for (const barrier of await listOpenBarriersByTask(task._id, { session })) {
        if (!barrier.facilityCode || barrier.facilityCode !== oldFacilityCode) continue;
        await resolveBarrier(barrier._id, { resolution: `Replaced by ${newFacility.name} (approved option)`, resolvedBy: toStoredActor(SYSTEM_ACTOR) }, { session });
        await insertTaskEvents([taskEvent(task, SYSTEM_ACTOR, {
          kind: 'barrier_resolved',
          barrierId: new ObjectId(barrier._id),
          reason: `${BARRIER_CODES[barrier.code]?.label || barrier.code}: replaced by ${newFacility.name}`
        })], { session });
      }
    }

    // 4. Evidence comes from the booking engine itself, not from anyone's say-so
    if (appointment && task.requiredEvidence.includes('booking_confirmed')) {
      const already = (await listEvidenceByTask(task._id, { session })).some(e => e.type === 'booking_confirmed');
      if (!already) {
        const evidence = await insertEvidence({
          taskId: new ObjectId(task._id),
          planId: new ObjectId(task.planId),
          type: 'booking_confirmed',
          reference: appointment.bookingReference,
          verifiedReference: {
            bookingReference: appointment.bookingReference,
            appointmentId: String(appointment._id),
            startAt: new Date(appointment.startAt).toISOString()
          },
          note: 'Recorded automatically from the booking engine after every approval was given.',
          recordedBy: toStoredActor(SYSTEM_ACTOR),
          recordedAt: new Date()
        }, { session });
        await insertTaskEvents([taskEvent(task, SYSTEM_ACTOR, {
          kind: 'evidence_recorded',
          evidenceId: new ObjectId(evidence._id),
          reason: EVIDENCE_TYPES.booking_confirmed.label
        })], { session });
      }
    }

    // 5. Complete only if the evidence for this task type is now complete
    const completion = await completeWhenEvidenceSatisfiedInSession({
      session,
      task,
      actor: SYSTEM_ACTOR,
      reason: appointment
        ? `All required evidence recorded: booking ${appointment.bookingReference} confirmed by the booking engine.`
        : 'All required evidence recorded.'
    });
    if (completion) task = completion.task;

    // 6. Tasks that follow this booking (e.g. "attend the visit") now happen where it was booked
    if (booking) {
      const followers = (await listCareTasksByPlan(task.planId, { session })).filter(t =>
        t.dependsOn.includes(task._id) && t.type === 'follow_up_visit' && t.status !== TASK_STATUS.COMPLETED);
      for (const follower of followers) {
        const set = { booking };
        if (booking.facilityCode && follower.serviceRequirement?.facilityCode !== booking.facilityCode) {
          set.serviceRequirement = { ...follower.serviceRequirement, facilityCode: booking.facilityCode };
          if (!follower.originalFacilityCode) set.originalFacilityCode = follower.serviceRequirement?.facilityCode || null;
        }
        if (action.kind === 'time_change' && booking.endAt > new Date(follower.dueAt)) {
          set.dueAt = booking.endAt;
          if (!follower.originalDueAt) set.originalDueAt = new Date(follower.dueAt);
        }
        const updatedFollower = await updateCareTaskLogistics(follower._id, set, { session });
        await insertTaskEvents([taskEvent(updatedFollower, SYSTEM_ACTOR, {
          kind: 'logistics_updated',
          approvalId: new ObjectId(approval._id),
          reason: `Visit follows booking ${booking.bookingReference}: ${booking.facilityName || 'planned clinic'}, ${formatClinicTime(booking.startAt, timeZone)} with ${booking.providerName}.`
        })], { session });

        // Its barriers about the old facility no longer apply either (the status is left for the agent or a person)
        const oldFollowerFacility = follower.serviceRequirement?.facilityCode || null;
        if (!set.serviceRequirement || !oldFollowerFacility) continue;
        for (const barrier of await listOpenBarriersByTask(follower._id, { session })) {
          if (barrier.facilityCode !== oldFollowerFacility) continue;
          await resolveBarrier(barrier._id, { resolution: `Visit moved to ${booking.facilityName} with booking ${booking.bookingReference}`, resolvedBy: toStoredActor(SYSTEM_ACTOR) }, { session });
          await insertTaskEvents([taskEvent(updatedFollower, SYSTEM_ACTOR, {
            kind: 'barrier_resolved',
            barrierId: new ObjectId(barrier._id),
            reason: `${BARRIER_CODES[barrier.code]?.label || barrier.code}: visit moved to ${booking.facilityName}`
          })], { session });
        }
      }
    }

    const executed = await updateApprovalStatus(approval._id, {
      fromStatuses: ['executing'],
      to: 'executed',
      set: {
        execution: {
          ...approval.execution,
          at: new Date(),
          outcome: 'executed',
          bookingReference: appointment?.bookingReference || null,
          appointmentId: appointment ? String(appointment._id) : null
        }
      }
    }, { session });
    if (!executed) throw new CarePlanError('This option was changed while it was being carried out.', 'CONCURRENT_UPDATE', 409);

    return {
      approval: executed,
      executed: true,
      task,
      booking: booking ? { ...booking, startAt: booking.startAt.toISOString(), endAt: booking.endAt.toISOString() } : null,
      completed: Boolean(completion),
      planCompleted: Boolean(completion?.planCompleted)
    };
  });
}
