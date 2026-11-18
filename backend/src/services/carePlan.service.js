import { ObjectId } from 'mongodb';
import { getClient } from '../config/db.js';
import { findCarePlanTemplate } from '../config/carePlanTemplates.js';
import { findPatientRecordById } from '../repositories/patient.repository.js';
import {
  insertCarePlan,
  findCarePlanById,
  listCarePlans,
  markCarePlanCompleted
} from '../repositories/carePlan.repository.js';
import {
  insertCareTasks,
  findCareTaskById,
  findCareTasksByIds,
  listCareTasksByPlan,
  updateCareTaskStatus
} from '../repositories/careTask.repository.js';
import { insertTaskEvents, listTaskEventsByPlan } from '../repositories/taskEvent.repository.js';
import { insertEvidence, listEvidenceByTask, listEvidenceByPlan } from '../repositories/evidence.repository.js';
import { normalizeE164Phone } from '../repositories/callbackConsent.repository.js';
import { listBarriersByPlan } from '../repositories/barrier.repository.js';
import { listOpenProposalsByPlan } from '../repositories/replanProposal.repository.js';
import { findOpenApprovalForTask, updateApprovalStatus, listApprovalsByPlan } from '../repositories/approval.repository.js';
import { listSubmissionsByPlan } from '../repositories/documentSubmission.repository.js';
import { listFacilities } from '../repositories/serviceDirectory.repository.js';
import { getAppointmentStatus } from './booking.service.js';
import { distanceKm, BARRIER_CODES } from './feasibilityRules.js';
import {
  TASK_STATUS,
  TASK_STATUS_LABELS,
  TASK_TYPES,
  TASK_OWNERS,
  EVIDENCE_TYPES,
  requiredEvidenceFor,
  missingEvidence,
  validateTransition,
  describeNextTransitions
} from './taskStateMachine.js';
import { toObjectId } from '../utils/objectId.js';

/**
 * PlanPilot care-plan service: creates plans from clinician-approved definitions, moves tasks
 * through the state machine, and records evidence. Every task change and its audit event are
 * written in one transaction, so the log can never miss a change.
 */

export class CarePlanError extends Error {
  constructor(message, code = 'CARE_PLAN_ERROR', statusCode = 400, details = undefined) {
    super(message);
    this.name = 'CarePlanError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

// HTTP status for each state-machine refusal
const REFUSAL_STATUS = {
  UNKNOWN_STATUS: 400,
  UNKNOWN_ACTOR: 400,
  NO_CHANGE: 409,
  TASK_CLOSED: 409,
  ILLEGAL_TRANSITION: 409,
  ACTOR_NOT_ALLOWED: 403,
  DEPENDENCIES_INCOMPLETE: 422,
  EVIDENCE_MISSING: 422
};

// Moving into these states must say why, for the audit trail
const REASON_REQUIRED_STATUSES = new Set([TASK_STATUS.BLOCKED, TASK_STATUS.ESCALATED, TASK_STATUS.UNABLE_TO_VERIFY]);

const MAX_TASKS = 20;
const TASK_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runInTransaction(work) {
  const client = getClient();
  if (!client) throw new CarePlanError('Database not connected.', 'DB_UNAVAILABLE', 503);

  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export function toStoredActor(actor) {
  return {
    type: actor.type,
    id: toObjectId(actor.id),
    name: actor.name || null
  };
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CarePlanError(`${field} is required.`, 'INVALID_PLAN', 400, { field });
  }
  return value.trim().slice(0, maxLength);
}

/**
 * Returns the keys forming a dependency cycle, or null if the task graph is acyclic.
 */
export function findDependencyCycle(tasks) {
  const dependsOn = new Map(tasks.map(t => [t.key, t.dependsOn]));
  const state = new Map(); // key -> 'visiting' | 'done'
  const path = [];

  const visit = (key) => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting') return path.slice(path.indexOf(key)).concat(key);
    state.set(key, 'visiting');
    path.push(key);
    for (const dep of dependsOn.get(key) || []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(key, 'done');
    return null;
  };

  for (const task of tasks) {
    const cycle = visit(task.key);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Validates and normalizes a plan definition (from a template or a clinician-written JSON plan).
 */
export function normalizePlanDefinition({ title, sourceText, tasks }) {
  const normalizedTitle = requireText(title, 'title', 200);
  const normalizedSource = typeof sourceText === 'string' ? sourceText.trim().slice(0, 5000) : '';

  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new CarePlanError('A care plan needs at least one task.', 'INVALID_PLAN', 400, { field: 'tasks' });
  }
  if (tasks.length > MAX_TASKS) {
    throw new CarePlanError(`A care plan can have at most ${MAX_TASKS} tasks.`, 'INVALID_PLAN', 400, { field: 'tasks' });
  }

  const keys = new Set();
  const normalized = tasks.map((task, index) => {
    const key = typeof task?.key === 'string' ? task.key.trim() : '';
    if (!TASK_KEY_PATTERN.test(key)) {
      throw new CarePlanError(`Task ${index + 1} needs a key like "book_followup" (lowercase letters, digits, underscores).`, 'INVALID_PLAN', 400, { field: `tasks[${index}].key` });
    }
    if (keys.has(key)) {
      throw new CarePlanError(`Task key "${key}" is used more than once.`, 'INVALID_PLAN', 400, { field: `tasks[${index}].key` });
    }
    keys.add(key);

    if (!TASK_TYPES[task.type]) {
      throw new CarePlanError(`Task "${key}" has unknown type "${task.type}". Use one of: ${Object.keys(TASK_TYPES).join(', ')}.`, 'INVALID_PLAN', 400, { field: `tasks[${index}].type` });
    }
    if (!TASK_OWNERS.includes(task.owner)) {
      throw new CarePlanError(`Task "${key}" has unknown owner "${task.owner}". Use one of: ${TASK_OWNERS.join(', ')}.`, 'INVALID_PLAN', 400, { field: `tasks[${index}].owner` });
    }

    const dueInDays = Number(task.dueInDays);
    if (!Number.isInteger(dueInDays) || dueInDays < 0 || dueInDays > 365) {
      throw new CarePlanError(`Task "${key}" needs dueInDays between 0 and 365.`, 'INVALID_PLAN', 400, { field: `tasks[${index}].dueInDays` });
    }

    return {
      key,
      type: task.type,
      title: requireText(task.title, `tasks[${index}].title`, 200),
      clinicalInstruction: requireText(task.clinicalInstruction, `tasks[${index}].clinicalInstruction`, 1000),
      owner: task.owner,
      dueInDays,
      dependsOn: Array.isArray(task.dependsOn) ? [...new Set(task.dependsOn.map(String))] : [],
      serviceRequirement: task.serviceRequirement && typeof task.serviceRequirement === 'object' ? { ...task.serviceRequirement } : null
    };
  });

  for (const task of normalized) {
    for (const dep of task.dependsOn) {
      if (dep === task.key) {
        throw new CarePlanError(`Task "${task.key}" cannot depend on itself.`, 'INVALID_PLAN', 400, { field: 'dependsOn' });
      }
      if (!keys.has(dep)) {
        throw new CarePlanError(`Task "${task.key}" depends on unknown task "${dep}".`, 'INVALID_PLAN', 400, { field: 'dependsOn' });
      }
    }
  }

  const cycle = findDependencyCycle(normalized);
  if (cycle) {
    throw new CarePlanError(`Tasks depend on each other in a loop: ${cycle.join(' → ')}.`, 'DEPENDENCY_CYCLE', 400, { cycle });
  }

  return { title: normalizedTitle, sourceText: normalizedSource, tasks: normalized };
}

/**
 * Creates a care plan for a patient. The creating clinician is recorded as the approver.
 * Accepts either `templateId` or an explicit `{ title, sourceText, tasks }` definition.
 */
export async function createCarePlan({ patientId, templateId = null, title, sourceText, tasks, actor }) {
  if (actor?.type !== 'clinician') {
    throw new CarePlanError('Only a clinician can create and approve a care plan.', 'ACTOR_NOT_ALLOWED', 403);
  }

  const patient = await findPatientRecordById(patientId);
  if (!patient) {
    throw new CarePlanError('Patient record not found.', 'PATIENT_NOT_FOUND', 404);
  }

  let definitionInput;
  if (templateId) {
    const template = findCarePlanTemplate(templateId);
    if (!template) throw new CarePlanError(`Unknown care plan template "${templateId}".`, 'TEMPLATE_NOT_FOUND', 404);
    definitionInput = template;
  } else {
    definitionInput = { title, sourceText, tasks };
  }
  const definition = normalizePlanDefinition(definitionInput);

  const now = new Date();
  const planId = new ObjectId();
  const patientObjectId = new ObjectId(patient._id);
  const storedActor = toStoredActor(actor);
  const taskIdsByKey = new Map(definition.tasks.map(t => [t.key, new ObjectId()]));

  const planDoc = {
    _id: planId,
    patientId: patientObjectId,
    title: definition.title,
    sourceText: definition.sourceText,
    templateId,
    status: 'active',
    approvedBy: storedActor,
    approvedAt: now,
    createdAt: now,
    updatedAt: now
  };

  const taskDocs = definition.tasks.map((task, order) => ({
    _id: taskIdsByKey.get(task.key),
    planId,
    patientId: patientObjectId,
    key: task.key,
    order,
    type: task.type,
    title: task.title,
    clinicalInstruction: task.clinicalInstruction,
    owner: task.owner,
    dueAt: new Date(now.getTime() + task.dueInDays * DAY_MS),
    dependsOn: task.dependsOn.map(key => taskIdsByKey.get(key)),
    requiredEvidence: requiredEvidenceFor(task.type),
    serviceRequirement: task.serviceRequirement,
    status: TASK_STATUS.SUGGESTED,
    version: 0,
    createdAt: now,
    updatedAt: now
  }));

  const events = taskDocs.map(task => ({
    taskId: task._id,
    planId,
    kind: 'created',
    from: null,
    to: TASK_STATUS.SUGGESTED,
    actor: storedActor,
    reason: 'Care plan approved and created by clinician',
    at: now
  }));

  await runInTransaction(async (session) => {
    await insertCarePlan(planDoc, { session });
    await insertCareTasks(taskDocs, { session });
    await insertTaskEvents(events, { session });
  });

  return getCarePlanDetail(String(planId));
}

function summarizeProgress(tasks, barriers = []) {
  return {
    total: tasks.length,
    openBarriers: barriers.filter(b => !b.resolvedAt).length,
    completed: tasks.filter(t => t.status === TASK_STATUS.COMPLETED).length,
    blocked: tasks.filter(t => t.status === TASK_STATUS.BLOCKED).length,
    escalated: tasks.filter(t => t.status === TASK_STATUS.ESCALATED).length,
    unableToVerify: tasks.filter(t => t.status === TASK_STATUS.UNABLE_TO_VERIFY).length
  };
}

/**
 * Full view of a plan: patient, tasks (with dependency status, evidence, and every possible next
 * move marked allowed or refused with a reason), and the complete audit log.
 */
export async function getCarePlanDetail(planId, { actorType = 'clinician' } = {}) {
  const plan = await findCarePlanById(planId);
  if (!plan) throw new CarePlanError('Care plan not found.', 'PLAN_NOT_FOUND', 404);

  const [patient, tasks, evidence, events, barriers, proposals, facilities, approvals, submissions] = await Promise.all([
    findPatientRecordById(plan.patientId),
    listCareTasksByPlan(planId),
    listEvidenceByPlan(planId),
    listTaskEventsByPlan(planId),
    listBarriersByPlan(planId),
    listOpenProposalsByPlan(planId),
    listFacilities(),
    listApprovalsByPlan(planId),
    listSubmissionsByPlan(planId)
  ]);

  const tasksById = new Map(tasks.map(t => [t._id, t]));
  const facilitiesByCode = new Map(facilities.map(f => [f.code, f]));
  const now = Date.now();

  const detailedTasks = tasks.map(task => {
    const dependencies = task.dependsOn.map(id => tasksById.get(id)).filter(Boolean)
      .map(dep => ({ _id: dep._id, key: dep.key, title: dep.title, status: dep.status }));
    const taskEvidence = evidence.filter(e => e.taskId === task._id);
    const evidenceTypes = taskEvidence.map(e => e.type);
    const facility = facilitiesByCode.get(task.serviceRequirement?.facilityCode);
    const taskBarriers = barriers
      .filter(b => b.taskId === task._id)
      .map(b => ({ ...b, label: BARRIER_CODES[b.code]?.label || b.code }))
      .sort((a, b) => Number(Boolean(a.resolvedAt)) - Number(Boolean(b.resolvedAt)));

    return {
      ...task,
      statusLabel: TASK_STATUS_LABELS[task.status],
      isOverdue: task.status !== TASK_STATUS.COMPLETED && new Date(task.dueAt).getTime() < now,
      plannedFacility: facility ? {
        code: facility.code,
        name: facility.name,
        modality: facility.modality,
        distanceKm: facility.modality === 'in_person' ? distanceKm(patient?.location, facility.location) : 0,
        isSimulated: Boolean(facility.isSimulated),
        changedFrom: task.originalFacilityCode ? (facilitiesByCode.get(task.originalFacilityCode)?.name || task.originalFacilityCode) : null
      } : null,
      barriers: taskBarriers,
      latestProposal: proposals.find(p => p.taskId === task._id) || null,
      openApproval: approvals.find(a => a.taskId === task._id && a.isOpen) || null,
      approvalHistory: approvals.filter(a => a.taskId === task._id && !a.isOpen).slice(0, 5),
      documentSubmissions: submissions.filter(s => s.taskId === task._id),
      dependencies,
      evidence: taskEvidence,
      missingEvidence: missingEvidence(task.type, evidenceTypes),
      nextTransitions: plan.status === 'active'
        ? describeNextTransitions(task, { actorType, dependencies, evidenceTypes })
        : []
    };
  });

  return {
    plan: {
      ...plan,
      progress: {
        ...summarizeProgress(tasks, barriers),
        openApprovals: approvals.filter(a => a.isOpen).length,
        documentsToReview: submissions.filter(s => s.status === 'pending_review').length
      }
    },
    patient,
    tasks: detailedTasks,
    events
  };
}

export async function listCarePlanSummaries({ patientId } = {}) {
  const plans = await listCarePlans({ patientId });
  return Promise.all(plans.map(async (plan) => {
    const [patient, tasks, barriers] = await Promise.all([
      findPatientRecordById(plan.patientId),
      listCareTasksByPlan(plan._id),
      listBarriersByPlan(plan._id)
    ]);
    return {
      ...plan,
      patient: patient ? { _id: patient._id, name: patient.name, isSynthetic: Boolean(patient.isSynthetic) } : null,
      progress: summarizeProgress(tasks, barriers)
    };
  }));
}

/**
 * Moves a task to a new status if the state machine allows it, recording an audit event in the
 * same transaction. Completes the plan when its last task is completed with evidence.
 */
export async function transitionTask({ taskId, to, actor, reason = '' }) {
  const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
  if (REASON_REQUIRED_STATUSES.has(to) && !cleanReason) {
    throw new CarePlanError(`Please give a reason when marking a task "${TASK_STATUS_LABELS[to]}".`, 'REASON_REQUIRED', 400);
  }

  return runInTransaction(async (session) => {
    const task = await findCareTaskById(taskId, { session });
    if (!task) throw new CarePlanError('Task not found.', 'TASK_NOT_FOUND', 404);

    const plan = await findCarePlanById(task.planId, { session });
    if (!plan || plan.status !== 'active') {
      throw new CarePlanError('This care plan is no longer active.', 'PLAN_NOT_ACTIVE', 409);
    }

    // An option waiting for approval must be decided through the approval, not bypassed.
    // Blocking or escalating the task withdraws it instead.
    const openApproval = await findOpenApprovalForTask(task._id, { session });
    if (openApproval) {
      if (openApproval.status === 'executing') {
        throw new CarePlanError('An approved option is being carried out right now. Try again in a moment.', 'APPROVAL_EXECUTING', 409);
      }
      if (![TASK_STATUS.BLOCKED, TASK_STATUS.ESCALATED].includes(to)) {
        throw new CarePlanError('An option for this task is waiting for approval. Approve, reject, or cancel it first.', 'APPROVAL_OPEN', 409, { approvalId: openApproval._id });
      }
      await cancelOpenApprovalInSession({ session, task, actor, reason: `Task moved to "${TASK_STATUS_LABELS[to]}": ${cleanReason}` });
    }

    return applyTransitionInSession({ session, task, to, actor, reason: cleanReason });
  });
}

/**
 * Loads a task and checks its plan is still active.
 */
export async function loadActiveTask(taskId, { session } = {}) {
  const task = await findCareTaskById(taskId, { session });
  if (!task) throw new CarePlanError('Task not found.', 'TASK_NOT_FOUND', 404);
  const plan = await findCarePlanById(task.planId, { session });
  if (!plan || plan.status !== 'active') {
    throw new CarePlanError('This care plan is no longer active.', 'PLAN_NOT_ACTIVE', 409);
  }
  return task;
}

/**
 * Withdraws a task's open approval (one not already being carried out) and logs why.
 * Must run inside a transaction. Returns the cancelled approval, or null if there was none.
 */
export async function cancelOpenApprovalInSession({ session, task, actor, reason }) {
  const open = await findOpenApprovalForTask(task._id, { session });
  if (!open || open.status === 'executing') return null;

  const at = new Date();
  const cancelled = await updateApprovalStatus(open._id, {
    fromStatuses: ['pending_clinician', 'pending_patient', 'approved'],
    to: 'cancelled',
    set: { cancellation: { by: toStoredActor(actor), at, reason } }
  }, { session });
  if (!cancelled) return null;

  await insertTaskEvents([{
    taskId: new ObjectId(task._id),
    planId: new ObjectId(task.planId),
    kind: 'approval_cancelled',
    from: task.status,
    to: task.status,
    actor: toStoredActor(actor),
    reason: `Waiting option withdrawn. ${reason}`,
    approvalId: new ObjectId(open._id),
    at
  }], { session });
  return cancelled;
}

/**
 * Completes a task once every piece of evidence its type needs has been recorded, stepping through
 * "requested" first if needed. Every step goes through the state machine; if any step is refused
 * (missing evidence, unfinished prerequisites, actor not allowed) nothing changes and null is returned.
 * Must run inside a transaction.
 */
export async function completeWhenEvidenceSatisfiedInSession({ session, task, actor, reason }) {
  const dependencies = await findCareTasksByIds(task.dependsOn, { session });
  const evidenceTypes = (await listEvidenceByTask(task._id, { session })).map(e => e.type);
  const context = { actorType: actor.type, dependencies, evidenceTypes };

  let path;
  if (validateTransition(task, TASK_STATUS.COMPLETED, context).ok) {
    path = [TASK_STATUS.COMPLETED];
  } else if (validateTransition(task, TASK_STATUS.REQUESTED, context).ok
    && validateTransition({ ...task, status: TASK_STATUS.REQUESTED }, TASK_STATUS.COMPLETED, context).ok) {
    path = [TASK_STATUS.REQUESTED, TASK_STATUS.COMPLETED];
  } else {
    return null;
  }

  let current = task;
  let planCompleted = false;
  for (const to of path) {
    const result = await applyTransitionInSession({ session, task: current, to, actor, reason });
    current = result.task;
    planCompleted = result.planCompleted;
  }
  return { task: current, planCompleted };
}

/**
 * The single guarded path every status change goes through, whoever starts it (clinician,
 * feasibility check, or later the agent). Must run inside a transaction: it validates against the
 * state machine, applies a compare-and-set update, and writes the audit event.
 */
export async function applyTransitionInSession({ session, task, to, actor, reason = null }) {
  const dependencies = await findCareTasksByIds(task.dependsOn, { session });
  const evidenceTypes = (await listEvidenceByTask(task._id, { session })).map(e => e.type);

  const verdict = validateTransition(task, to, { actorType: actor.type, dependencies, evidenceTypes });
  if (!verdict.ok) {
    throw new CarePlanError(verdict.message, verdict.code, REFUSAL_STATUS[verdict.code] || 400, verdict.details);
  }

  const updated = await updateCareTaskStatus(task._id, { from: task.status, to, version: task.version }, { session });
  if (!updated) {
    throw new CarePlanError('This task was just changed by someone else. Reload and try again.', 'CONCURRENT_UPDATE', 409);
  }

  const [event] = await insertTaskEvents([{
    taskId: new ObjectId(task._id),
    planId: new ObjectId(task.planId),
    kind: 'transition',
    from: task.status,
    to,
    actor: toStoredActor(actor),
    reason: reason || null,
    at: new Date()
  }], { session });

  let planCompleted = false;
  if (to === TASK_STATUS.COMPLETED) {
    const planTasks = await listCareTasksByPlan(task.planId, { session });
    if (planTasks.every(t => t.status === TASK_STATUS.COMPLETED)) {
      await markCarePlanCompleted(task.planId, { session });
      planCompleted = true;
    }
  }

  return { task: { ...updated, statusLabel: TASK_STATUS_LABELS[updated.status] }, event, planCompleted };
}

/**
 * Checks that a booking reference is a real, confirmed appointment belonging to this patient.
 */
async function verifyBookingReference(reference, patient) {
  const appointment = await getAppointmentStatus(String(reference).trim());
  if (!appointment) {
    throw new CarePlanError(`No appointment found for "${reference}".`, 'REFERENCE_INVALID', 422);
  }
  if (!['confirmed', 'completed'].includes(appointment.status)) {
    throw new CarePlanError(`Appointment ${appointment.bookingReference} is ${appointment.status}, not confirmed.`, 'REFERENCE_INVALID', 422);
  }

  const sameAccount = Boolean(patient.userId) && appointment.patientUserId === patient.userId;
  const patientPhone = normalizeE164Phone(patient.phone);
  const samePhone = Boolean(patientPhone) && normalizeE164Phone(appointment.patient?.phone) === patientPhone;
  if (!sameAccount && !samePhone) {
    throw new CarePlanError(`Appointment ${appointment.bookingReference} does not belong to ${patient.name}.`, 'REFERENCE_INVALID', 422);
  }

  return {
    bookingReference: appointment.bookingReference,
    appointmentId: appointment._id,
    startAt: appointment.startAt
  };
}

/**
 * Records proof that part of a task happened. Only evidence the task's type actually needs is
 * accepted, only from actors allowed to vouch for it, and booking evidence must point to a real
 * confirmed appointment for this patient. Recording evidence does not change the task's status.
 */
export async function recordEvidence({ taskId, type, reference = null, note = '', actor }) {
  const definition = EVIDENCE_TYPES[type];
  if (!definition) {
    throw new CarePlanError(`Unknown evidence type "${type}".`, 'UNKNOWN_EVIDENCE_TYPE', 400);
  }
  if (!definition.recordableBy.includes(actor.type)) {
    throw new CarePlanError(`Only ${definition.recordableBy.join(' or ')} can record "${definition.label}".`, 'ACTOR_NOT_ALLOWED', 403);
  }

  const task = await findCareTaskById(taskId);
  if (!task) throw new CarePlanError('Task not found.', 'TASK_NOT_FOUND', 404);
  if (!task.requiredEvidence.includes(type)) {
    throw new CarePlanError(`"${definition.label}" is not evidence for a "${TASK_TYPES[task.type].label}" task.`, 'EVIDENCE_NOT_APPLICABLE', 400);
  }
  if (task.status === TASK_STATUS.COMPLETED) {
    throw new CarePlanError('Task is already completed.', 'TASK_CLOSED', 409);
  }

  const plan = await findCarePlanById(task.planId);
  if (!plan || plan.status !== 'active') {
    throw new CarePlanError('This care plan is no longer active.', 'PLAN_NOT_ACTIVE', 409);
  }

  let verifiedReference = null;
  if (definition.requiresReference) {
    if (!reference || !String(reference).trim()) {
      throw new CarePlanError(`"${definition.label}" needs a booking reference.`, 'REFERENCE_REQUIRED', 400);
    }
    const patient = await findPatientRecordById(task.patientId);
    verifiedReference = await verifyBookingReference(reference, patient);
  }

  const alreadyRecorded = () => new CarePlanError(`"${definition.label}" is already recorded for this task.`, 'EVIDENCE_ALREADY_RECORDED', 409);

  try {
    return await insertEvidenceWithEvent({ task, type, definition, reference, verifiedReference, note, actor });
  } catch (err) {
    if (err.code === 11000) throw alreadyRecorded();
    throw err;
  }
}

async function insertEvidenceWithEvent({ task, type, definition, reference, verifiedReference, note, actor }) {
  return runInTransaction(async (session) => {
    const now = new Date();
    const storedActor = toStoredActor(actor);
    const evidence = await insertEvidence({
      taskId: new ObjectId(task._id),
      planId: new ObjectId(task.planId),
      type,
      reference: verifiedReference?.bookingReference || (reference ? String(reference).trim().slice(0, 200) : null),
      verifiedReference,
      note: typeof note === 'string' ? note.trim().slice(0, 500) : '',
      recordedBy: storedActor,
      recordedAt: now
    }, { session });

    await insertTaskEvents([{
      taskId: new ObjectId(task._id),
      planId: new ObjectId(task.planId),
      kind: 'evidence_recorded',
      from: task.status,
      to: task.status,
      actor: storedActor,
      reason: definition.label,
      evidenceId: new ObjectId(evidence._id),
      at: now
    }], { session });

    return evidence;
  });
}
