import { findCarePlanById } from '../repositories/carePlan.repository.js';
import { findCareTaskById, listCareTasksByStatuses } from '../repositories/careTask.repository.js';
import { findPatientRecordById } from '../repositories/patient.repository.js';
import { listApprovalsByStatus } from '../repositories/approval.repository.js';
import { listSubmissionsByStatus } from '../repositories/documentSubmission.repository.js';
import { listEvidenceByTask } from '../repositories/evidence.repository.js';
import { listTaskEventsByTask } from '../repositories/taskEvent.repository.js';
import { APPROVAL_STATUS_LABELS } from './approval.service.js';
import { listHealthAlerts } from './symptomCheck.service.js';
import { TASK_STATUS, TASK_STATUS_LABELS, EVIDENCE_TYPES, missingEvidence } from './taskStateMachine.js';

/**
 * The clinician's review queue: everything PlanPilot is waiting on a person for.
 * Built from live data on every request; nothing here is a cached or invented count.
 */

const HOUR_MS = 60 * 60 * 1000;
const RECENT_FAILURE_MS = 72 * HOUR_MS;
const CLINICIAN_ONLY_EVIDENCE = Object.entries(EVIDENCE_TYPES)
  .filter(([, def]) => def.recordableBy.length === 1 && def.recordableBy[0] === 'clinician')
  .map(([type]) => type);

function ageHours(date, now) {
  return Math.max(0, Math.floor((now - new Date(date).getTime()) / HOUR_MS));
}

export async function getReviewQueue({ now = Date.now() } = {}) {
  const planCache = new Map();
  const patientCache = new Map();
  const taskCache = new Map();

  const plan = async (id) => {
    if (!planCache.has(id)) planCache.set(id, await findCarePlanById(id));
    return planCache.get(id);
  };
  const patient = async (id) => {
    if (!patientCache.has(id)) patientCache.set(id, await findPatientRecordById(id));
    return patientCache.get(id);
  };
  const task = async (id) => {
    if (!taskCache.has(id)) taskCache.set(id, await findCareTaskById(id));
    return taskCache.get(id);
  };

  // Shared context for every item, or null if its plan is no longer active
  const context = async (taskDoc) => {
    if (!taskDoc) return null;
    const planDoc = await plan(taskDoc.planId);
    if (!planDoc || planDoc.status !== 'active') return null;
    const patientDoc = await patient(taskDoc.patientId);
    return {
      task: { _id: taskDoc._id, title: taskDoc.title, type: taskDoc.type, status: taskDoc.status, statusLabel: TASK_STATUS_LABELS[taskDoc.status], dueAt: taskDoc.dueAt },
      plan: { _id: planDoc._id, title: planDoc.title },
      patient: patientDoc ? { _id: patientDoc._id, name: patientDoc.name, isSynthetic: Boolean(patientDoc.isSynthetic) } : null
    };
  };

  const [openApprovals, failedApprovals, documents, attentionTasks] = await Promise.all([
    listApprovalsByStatus(['pending_clinician', 'pending_patient', 'approved', 'executing']),
    listApprovalsByStatus(['failed']),
    listSubmissionsByStatus('pending_review'),
    listCareTasksByStatuses([
      TASK_STATUS.ESCALATED,
      TASK_STATUS.UNABLE_TO_VERIFY,
      TASK_STATUS.REQUESTED,
      TASK_STATUS.CONFIRMED,
      TASK_STATUS.IN_PROGRESS
    ])
  ]);

  const approvalItem = async (approval) => {
    const ctx = await context(await task(approval.taskId));
    if (!ctx) return null;
    return {
      approvalId: approval._id,
      status: approval.status,
      statusLabel: APPROVAL_STATUS_LABELS[approval.status],
      description: approval.description,
      kind: approval.action.kind,
      approvalReason: approval.action.approvalReason,
      rationale: approval.action.rationale,
      facility: approval.action.facility,
      slot: approval.action.slot,
      requires: approval.requires,
      requestedBy: approval.requestedBy,
      clinicianDecision: approval.clinicianDecision,
      execution: approval.execution,
      createdAt: approval.createdAt,
      ageHours: ageHours(approval.createdAt, now),
      ...ctx
    };
  };

  const approvalItems = (await Promise.all(openApprovals.map(approvalItem))).filter(Boolean);
  const recentFailures = (await Promise.all(failedApprovals
    .filter(a => now - new Date(a.execution?.at || a.updatedAt).getTime() < RECENT_FAILURE_MS)
    .map(approvalItem))).filter(Boolean);

  const documentItems = (await Promise.all(documents.map(async (submission) => {
    const ctx = await context(await task(submission.taskId));
    if (!ctx) return null;
    return {
      submissionId: submission._id,
      fileName: submission.fileName,
      mimeType: submission.mimeType,
      sizeBytes: submission.sizeBytes,
      document: submission.document,
      submittedBy: submission.submittedBy,
      submittedAt: submission.submittedAt,
      ageHours: ageHours(submission.submittedAt, now),
      ...ctx
    };
  }))).filter(Boolean);

  const escalated = [];
  const unableToVerify = [];
  const evidenceToRecord = [];
  for (const taskDoc of attentionTasks) {
    taskCache.set(taskDoc._id, taskDoc);
    const ctx = await context(taskDoc);
    if (!ctx) continue;

    if (taskDoc.status === TASK_STATUS.ESCALATED || taskDoc.status === TASK_STATUS.UNABLE_TO_VERIFY) {
      const events = await listTaskEventsByTask(taskDoc._id);
      const entered = [...events].reverse().find(e => e.kind === 'transition' && e.to === taskDoc.status);
      const item = { ...ctx, reason: entered?.reason || null, since: entered?.at || taskDoc.updatedAt, by: entered?.actor || null };
      (taskDoc.status === TASK_STATUS.ESCALATED ? escalated : unableToVerify).push(item);
      continue;
    }

    // Active tasks where only a clinician can record what's still missing, and it should have happened by now
    const evidenceTypes = (await listEvidenceByTask(taskDoc._id)).map(e => e.type);
    const missing = missingEvidence(taskDoc.type, evidenceTypes).filter(type => CLINICIAN_ONLY_EVIDENCE.includes(type));
    if (missing.length === 0) continue;
    const visitHappened = taskDoc.booking?.startAt && new Date(taskDoc.booking.startAt).getTime() < now;
    const reportArrived = evidenceTypes.includes('report_received');
    const overdue = new Date(taskDoc.dueAt).getTime() < now;
    if (!visitHappened && !reportArrived && !overdue) continue;

    evidenceToRecord.push({
      ...ctx,
      missingEvidence: missing.map(type => ({ type, label: EVIDENCE_TYPES[type].label })),
      why: visitHappened ? 'The booked visit time has passed.' : reportArrived ? 'The report has arrived and needs review.' : 'The task is past its due date.',
      booking: taskDoc.booking || null
    });
  }

  // Urgent and emergency results from phone health checks that no clinician has looked at yet
  const healthAlerts = await listHealthAlerts();

  const needsClinician = approvalItems.filter(a => a.status === 'pending_clinician');
  const awaitingPatient = approvalItems.filter(a => a.status === 'pending_patient');
  const inFlight = approvalItems.filter(a => a.status === 'approved' || a.status === 'executing');

  const counts = {
    needsClinician: needsClinician.length,
    documents: documentItems.length,
    escalated: escalated.length,
    unableToVerify: unableToVerify.length,
    evidenceToRecord: evidenceToRecord.length,
    awaitingPatient: awaitingPatient.length,
    recentFailures: recentFailures.length,
    healthAlerts: healthAlerts.length
  };

  return {
    // Items only a clinician can clear (waiting-on-patient items are shown but not counted here)
    actionRequired: counts.needsClinician + counts.documents + counts.escalated + counts.unableToVerify + counts.evidenceToRecord + counts.healthAlerts,
    healthAlerts,
    counts,
    needsClinician,
    documents: documentItems,
    escalated,
    unableToVerify,
    evidenceToRecord,
    awaitingPatient,
    inFlight,
    recentFailures
  };
}
