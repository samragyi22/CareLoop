import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { assessEmergencyRisk } from '../config/emergency.js';
import { assessClinicalContent } from '../config/clinicalScreen.js';
import { maybeFail } from '../utils/faults.js';
import { findCareTaskById, listCareTasksByPlan } from '../repositories/careTask.repository.js';
import { findCarePlanById } from '../repositories/carePlan.repository.js';
import { findPatientRecordById } from '../repositories/patient.repository.js';
import { findFacilityByCode, listFacilities } from '../repositories/serviceDirectory.repository.js';
import { findProviderById } from '../repositories/provider.repository.js';
import { listRecentOutboundCallsTo } from '../repositories/voiceCall.repository.js';
import {
  insertBarrier,
  listOpenBarriersByTask,
  refreshBarrier,
  resolveBarrier,
  findBarrierById
} from '../repositories/barrier.repository.js';
import { supersedeOpenProposals, insertProposal } from '../repositories/replanProposal.repository.js';
import { findOpenApprovalForTask, listApprovalsByTask } from '../repositories/approval.repository.js';
import { insertTaskEvents } from '../repositories/taskEvent.repository.js';
import { getAvailableSlots } from './slot.service.js';
import { assessTaskFeasibility, proposeAlternatives, facilityOffers, BARRIER_CODES } from './feasibilityRules.js';
import { validateTransition, TASK_STATUS } from './taskStateMachine.js';
import {
  CarePlanError,
  runInTransaction,
  toStoredActor,
  applyTransitionInSession,
  cancelOpenApprovalInSession,
  loadActiveTask
} from './carePlan.service.js';

/**
 * PlanPilot feasibility service: loads what the pure rules need, runs them, and records the
 * outcome (barriers, replan proposal, audit events, and a move to "blocked" when warranted)
 * in one transaction. It never books, cancels, or changes clinical instructions.
 */

const SYSTEM_ACTOR = { type: 'system', id: null, name: 'PlanPilot feasibility check' };
const DAY_MS = 24 * 60 * 60 * 1000;
const LATE_SLOT_WINDOW_DAYS = 14;
const RECENT_CALL_WINDOW_MS = 7 * DAY_MS;
// Once a task is in one of these, a new barrier doesn't change its status
const NO_AUTO_BLOCK_STATUSES = new Set([TASK_STATUS.BLOCKED, TASK_STATUS.ESCALATED, TASK_STATUS.COMPLETED]);
// Approved options that work around a barrier without removing it (the document is still missing
// while it is being requested). For this long after one is carried out, its barrier doesn't re-block the task.
const HANDLING_KINDS = new Set(['request_document', 'follow_up_confirmation', 'contact_caregiver']);
const HANDLED_FOR_MS = 72 * 60 * 60 * 1000;

function barrierLabel(code) {
  return BARRIER_CODES[code]?.label || code;
}

function eventBase(task, actor, at) {
  return {
    taskId: new ObjectId(task._id),
    planId: new ObjectId(task.planId),
    from: task.status,
    to: task.status,
    actor: toStoredActor(actor),
    at
  };
}

/**
 * Barrier codes an executed approval is currently working around for this task.
 */
async function codesBeingHandled(taskId, now) {
  const approvals = await listApprovalsByTask(taskId);
  return new Set(approvals
    .filter(a => a.status === 'executed' && HANDLING_KINDS.has(a.action?.kind)
      && now.getTime() - new Date(a.execution?.at).getTime() < HANDLED_FOR_MS)
    .flatMap(a => a.action.resolves || []));
}

/**
 * Open slots for the required specialty across the providers serving a clinic facility,
 * split into those that end by the due date and those within two weeks after it.
 */
export async function slotsForFacility(facility, requirement, { now, dueAt }) {
  if (facility.category !== 'clinic' || !requirement.specialty) {
    return { slotsBeforeDue: [], slotsAfterDue: [] };
  }

  const until = new Date(dueAt.getTime() + LATE_SLOT_WINDOW_DAYS * DAY_MS);
  const slots = [];
  for (const providerId of facility.providerIds) {
    const provider = await findProviderById(providerId);
    if (!provider?.isActive || provider.specialty !== requirement.specialty) continue;
    const available = await getAvailableSlots({ providerId, startDate: now.toISOString(), endDate: until.toISOString() });
    slots.push(...available.map(s => ({
      providerId: String(s.providerId),
      providerName: s.providerName,
      startAt: s.startAt,
      endAt: s.endAt
    })));
  }
  slots.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  return {
    slotsBeforeDue: slots.filter(s => new Date(s.endAt) <= dueAt),
    slotsAfterDue: slots.filter(s => new Date(s.endAt) > dueAt)
  };
}

/**
 * Checks one task, records barriers and alternatives, and blocks the task if it is newly infeasible.
 */
export async function runTaskFeasibilityCheck({ taskId, actor }) {
  const task = await loadActiveTask(taskId);
  maybeFail('directory');
  const patient = await findPatientRecordById(task.patientId);
  const requirement = task.serviceRequirement || {};
  const now = new Date();
  const dueAt = new Date(task.dueAt);
  const timeZone = env.DEFAULT_TIMEZONE;

  const plannedFacility = requirement.facilityCode ? await findFacilityByCode(requirement.facilityCode) : null;

  let candidates = [];
  if (requirement.category === 'clinic' || requirement.category === 'lab') {
    const facilities = await listFacilities({ category: requirement.category });
    const relevant = facilities.filter(f => facilityOffers(f, requirement) || f.code === plannedFacility?.code);
    candidates = await Promise.all(relevant.map(async facility => ({
      facility,
      ...(await slotsForFacility(facility, requirement, { now, dueAt }))
    })));
  }
  const plannedCandidate = candidates.find(c => c.facility.code === plannedFacility?.code);

  const recentCalls = patient?.phone
    ? await listRecentOutboundCallsTo(patient.phone, { since: new Date(now.getTime() - RECENT_CALL_WINDOW_MS) })
    : [];

  const assessment = assessTaskFeasibility({
    task,
    patient,
    facility: plannedFacility,
    slotsBeforeDue: plannedCandidate?.slotsBeforeDue || [],
    recentCalls,
    now,
    timeZone
  });

  // Barriers already being worked around, or an option already waiting for approval, are recorded
  // but don't re-block the task or produce a competing proposal
  const handled = await codesBeingHandled(task._id, now);
  const actionable = assessment.barriers.filter(b => !handled.has(b.code));
  const openApproval = await findOpenApprovalForTask(task._id);

  const replan = actionable.length > 0 && !openApproval
    ? proposeAlternatives({ task, patient, barriers: actionable, plannedFacility, candidates, now, timeZone })
    : null;

  return runInTransaction(async (session) => {
    const current = await findCareTaskById(task._id, { session });
    const at = new Date();
    const detectedCodes = new Set(assessment.barriers.map(b => b.code));
    const handledCodes = [...detectedCodes].filter(code => handled.has(code));
    let summary = assessment.barriers.length
      ? `Found: ${[...detectedCodes].map(barrierLabel).join(', ')}`
      : 'No barriers found';
    if (handledCodes.length) summary += ` (already being handled: ${handledCodes.map(barrierLabel).join(', ')})`;
    if (openApproval && assessment.barriers.length) summary += '. An option is already waiting for approval, so no new proposal was made';

    const events = [{ ...eventBase(current, actor, at), kind: 'feasibility_checked', reason: summary }];

    // Record new barriers; refresh ones still present; resolve rule-found ones that have gone away
    const openFromChecks = (await listOpenBarriersByTask(current._id, { session })).filter(b => b.source === 'feasibility_check');
    for (const barrier of assessment.barriers) {
      const existing = openFromChecks.find(b => b.code === barrier.code);
      if (existing) {
        await refreshBarrier(existing._id, { detail: barrier.detail }, { session });
        continue;
      }
      const inserted = await insertBarrier({
        taskId: new ObjectId(current._id),
        planId: new ObjectId(current.planId),
        patientId: new ObjectId(current.patientId),
        code: barrier.code,
        detail: barrier.detail,
        facilityCode: barrier.facilityCode || null,
        source: 'feasibility_check',
        reportedBy: toStoredActor(SYSTEM_ACTOR),
        emergencyFlag: false,
        detectedAt: at,
        lastSeenAt: at,
        resolvedAt: null,
        resolution: null,
        resolvedBy: null
      }, { session });
      events.push({
        ...eventBase(current, SYSTEM_ACTOR, at),
        kind: 'barrier_detected',
        barrierId: new ObjectId(inserted._id),
        reason: `${barrierLabel(barrier.code)}: ${barrier.detail}`
      });
    }
    for (const stale of openFromChecks.filter(b => !detectedCodes.has(b.code))) {
      await resolveBarrier(stale._id, { resolution: 'No longer detected on re-check', resolvedBy: toStoredActor(SYSTEM_ACTOR) }, { session });
      events.push({
        ...eventBase(current, SYSTEM_ACTOR, at),
        kind: 'barrier_resolved',
        barrierId: new ObjectId(stale._id),
        reason: `${barrierLabel(stale.code)}: no longer detected on re-check`
      });
    }
    await insertTaskEvents(events, { session });

    // A newly infeasible task becomes "blocked", through the same guarded path as any other change
    let transition = null;
    if (actionable.length > 0 && !openApproval && !NO_AUTO_BLOCK_STATUSES.has(current.status)) {
      if (validateTransition(current, TASK_STATUS.BLOCKED, { actorType: SYSTEM_ACTOR.type }).ok) {
        transition = await applyTransitionInSession({
          session,
          task: current,
          to: TASK_STATUS.BLOCKED,
          actor: SYSTEM_ACTOR,
          reason: `Feasibility check. ${summary}`
        });
      }
    }

    let proposal = null;
    if (!openApproval) await supersedeOpenProposals(current._id, { session });
    if (replan) {
      proposal = await insertProposal({
        taskId: new ObjectId(current._id),
        planId: new ObjectId(current.planId),
        status: 'proposed',
        barrierCodes: [...detectedCodes],
        recommendation: replan.recommendation,
        note: replan.note,
        alternatives: replan.alternatives,
        createdBy: toStoredActor(SYSTEM_ACTOR),
        slotsCheckedAt: at,
        createdAt: at,
        updatedAt: at
      }, { session });
      await insertTaskEvents([{
        ...eventBase(transition?.task || current, SYSTEM_ACTOR, new Date()),
        kind: 'replan_proposed',
        proposalId: new ObjectId(proposal._id),
        reason: replan.recommendation === 'escalate'
          ? replan.note
          : `${replan.alternatives.length} alternative(s) proposed; none applied yet`
      }], { session });
    }

    return {
      feasible: assessment.barriers.length === 0,
      barriers: assessment.barriers.map(b => ({ ...b, label: barrierLabel(b.code), beingHandled: handled.has(b.code) })),
      checks: assessment.checks,
      proposal,
      blocked: Boolean(transition),
      task: transition?.task || current
    };
  });
}

/**
 * Runs the feasibility check on every task in a plan that is not yet completed.
 */
export async function runPlanFeasibilityCheck({ planId, actor }) {
  const plan = await findCarePlanById(planId);
  if (!plan) throw new CarePlanError('Care plan not found.', 'PLAN_NOT_FOUND', 404);
  if (plan.status !== 'active') throw new CarePlanError('This care plan is no longer active.', 'PLAN_NOT_ACTIVE', 409);

  const tasks = (await listCareTasksByPlan(planId)).filter(t => t.status !== TASK_STATUS.COMPLETED);
  const results = [];
  for (const task of tasks) {
    const result = await runTaskFeasibilityCheck({ taskId: task._id, actor });
    results.push({
      taskId: task._id,
      title: task.title,
      feasible: result.feasible,
      barrierCodes: result.barriers.map(b => b.code),
      blocked: result.blocked,
      recommendation: result.proposal?.recommendation || null
    });
  }
  return { checked: results.length, infeasible: results.filter(r => !r.feasible).length, results };
}

/**
 * Records a barrier reported by a person (e.g. "patient says she cannot travel this week").
 * The text is screened for emergency red flags first: a possible emergency escalates the task to
 * a clinician immediately and returns the regional emergency guidance.
 */
export async function reportBarrier({ taskId, code, detail, actor }) {
  if (!BARRIER_CODES[code]) {
    throw new CarePlanError(`Unknown barrier code "${code}". Use one of: ${Object.keys(BARRIER_CODES).join(', ')}.`, 'UNKNOWN_BARRIER_CODE', 400);
  }
  const cleanDetail = typeof detail === 'string' ? detail.trim().slice(0, 500) : '';
  if (cleanDetail.length < 3) {
    throw new CarePlanError('Please describe the barrier.', 'DETAIL_REQUIRED', 400);
  }

  const task = await loadActiveTask(taskId);
  if (task.status === TASK_STATUS.COMPLETED) {
    throw new CarePlanError('Task is already completed.', 'TASK_CLOSED', 409);
  }

  const risk = assessEmergencyRisk(cleanDetail);
  const clinical = risk.isEmergency ? { isClinical: false, matched: [] } : assessClinicalContent(cleanDetail);
  // "Can't get there" and similar are about the planned facility, so a change of facility resolves them
  const facilityCode = BARRIER_CODES[code].scope === 'facility' ? task.serviceRequirement?.facilityCode || null : null;

  return runInTransaction(async (session) => {
    const current = await findCareTaskById(task._id, { session });
    const at = new Date();

    const barrier = await insertBarrier({
      taskId: new ObjectId(current._id),
      planId: new ObjectId(current.planId),
      patientId: new ObjectId(current.patientId),
      code,
      detail: cleanDetail,
      facilityCode,
      source: 'reported',
      reportedBy: toStoredActor(actor),
      emergencyFlag: risk.isEmergency,
      detectedAt: at,
      lastSeenAt: at,
      resolvedAt: null,
      resolution: null,
      resolvedBy: null
    }, { session });

    await insertTaskEvents([{
      ...eventBase(current, actor, at),
      kind: 'barrier_detected',
      barrierId: new ObjectId(barrier._id),
      reason: `${barrierLabel(code)}: ${cleanDetail}`
    }], { session });

    let transition = null;
    const mustEscalate = (risk.isEmergency || clinical.isClinical) && current.status !== TASK_STATUS.ESCALATED;
    const willChangeStatus = mustEscalate
      || (!NO_AUTO_BLOCK_STATUSES.has(current.status) && validateTransition(current, TASK_STATUS.BLOCKED, { actorType: actor.type }).ok);
    if (willChangeStatus) {
      await cancelOpenApprovalInSession({ session, task: current, actor, reason: `New barrier reported: ${barrierLabel(code)}.` });
    }
    if (risk.isEmergency && current.status !== TASK_STATUS.ESCALATED) {
      transition = await applyTransitionInSession({
        session,
        task: current,
        to: TASK_STATUS.ESCALATED,
        actor: { type: 'system', id: null, name: 'PlanPilot safety screen' },
        reason: `Possible emergency described in a barrier report. Escalated to a clinician immediately; advise calling ${risk.emergencyNumber}.`
      });
    } else if (clinical.isClinical && current.status !== TASK_STATUS.ESCALATED) {
      transition = await applyTransitionInSession({
        session,
        task: current,
        to: TASK_STATUS.ESCALATED,
        actor: { type: 'system', id: null, name: 'PlanPilot safety screen' },
        reason: `The report mentions medicines or treatment ("${clinical.matched.slice(0, 3).join('", "')}"). PlanPilot does not decide clinical questions; escalated for clinician review.`
      });
    } else if (!NO_AUTO_BLOCK_STATUSES.has(current.status)
      && validateTransition(current, TASK_STATUS.BLOCKED, { actorType: actor.type }).ok) {
      transition = await applyTransitionInSession({
        session,
        task: current,
        to: TASK_STATUS.BLOCKED,
        actor,
        reason: `${barrierLabel(code)} reported: ${cleanDetail}`
      });
    }

    return {
      barrier: { ...barrier, label: barrierLabel(code) },
      task: transition?.task || current,
      emergency: risk.isEmergency
        ? { emergencyNumber: risk.emergencyNumber, instructions: risk.recommendation }
        : null,
      needsClinicalReview: Boolean(risk.isAmbiguous) || clinical.isClinical,
      clinicalReview: clinical.isClinical ? { matched: clinical.matched } : null
    };
  });
}

/**
 * Marks a barrier resolved, with a note saying how. Does not change the task's status:
 * moving a blocked task forward stays an explicit, logged decision.
 */
export async function resolveTaskBarrier({ taskId, barrierId, resolution, actor }) {
  const cleanResolution = typeof resolution === 'string' ? resolution.trim().slice(0, 500) : '';
  if (cleanResolution.length < 3) {
    throw new CarePlanError('Please say how the barrier was resolved.', 'RESOLUTION_REQUIRED', 400);
  }

  const task = await loadActiveTask(taskId);
  const barrier = await findBarrierById(barrierId);
  if (!barrier || barrier.taskId !== task._id) {
    throw new CarePlanError('Barrier not found for this task.', 'BARRIER_NOT_FOUND', 404);
  }
  if (barrier.resolvedAt) {
    throw new CarePlanError('This barrier is already resolved.', 'BARRIER_ALREADY_RESOLVED', 409);
  }

  return runInTransaction(async (session) => {
    const resolved = await resolveBarrier(barrier._id, { resolution: cleanResolution, resolvedBy: toStoredActor(actor) }, { session });
    if (!resolved) throw new CarePlanError('This barrier is already resolved.', 'BARRIER_ALREADY_RESOLVED', 409);

    const current = await findCareTaskById(task._id, { session });
    await insertTaskEvents([{
      ...eventBase(current, actor, new Date()),
      kind: 'barrier_resolved',
      barrierId: new ObjectId(barrier._id),
      reason: `${barrierLabel(barrier.code)}: ${cleanResolution}`
    }], { session });

    return { ...resolved, label: barrierLabel(resolved.code) };
  });
}
