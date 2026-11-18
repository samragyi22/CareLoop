import { createHash } from 'crypto';
import { Binary, ObjectId } from 'mongodb';
import { findCareTaskById } from '../repositories/careTask.repository.js';
import { listOpenBarriersByTask, resolveBarrier } from '../repositories/barrier.repository.js';
import { insertTaskEvents } from '../repositories/taskEvent.repository.js';
import { insertEvidence, listEvidenceByTask } from '../repositories/evidence.repository.js';
import {
  insertSubmission,
  findSubmissionById,
  listSubmissionsByPlan,
  reviewSubmission
} from '../repositories/documentSubmission.repository.js';
import {
  CarePlanError,
  runInTransaction,
  toStoredActor,
  loadActiveTask,
  cancelOpenApprovalInSession,
  completeWhenEvidenceSatisfiedInSession
} from './carePlan.service.js';
import { TASK_STATUS, EVIDENCE_TYPES } from './taskStateMachine.js';
import { BARRIER_CODES, documentLabel } from './feasibilityRules.js';

/**
 * Document submissions for "submit a document" tasks. A patient (portal) or clinic staff (on the
 * patient's behalf) uploads a file; it is NOT evidence. Evidence ("document received and verified
 * by staff") is recorded only when a clinician reviews the file and verifies it.
 */

export const MAX_DOCUMENT_BYTES = 2.5 * 1024 * 1024;
const MAX_PENDING_PER_TASK = 5;

// Accepted formats, checked against the file's actual first bytes (not just the declared type)
const FILE_SIGNATURES = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'image/png': [[0x89, 0x50, 0x4e, 0x47]],
  'image/jpeg': [[0xff, 0xd8, 0xff]]
};

function matchesSignature(buffer, mimeType) {
  return (FILE_SIGNATURES[mimeType] || []).some(sig => sig.every((byte, i) => buffer[i] === byte));
}

function cleanFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 120);
  return cleaned || 'document';
}

function decodeBase64(content) {
  if (typeof content !== 'string') return null;
  const stripped = content.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) return null;
  return Buffer.from(stripped, 'base64');
}

/**
 * Stores a submitted file for a document task and logs it. Does not change the task's status.
 *
 * @param {string|null} args.patientRecordId  for portal uploads: the logged-in patient's record
 */
export async function submitDocument({ taskId, fileName, mimeType, contentBase64, actor, patientRecordId = null }) {
  if (!['patient', 'clinician'].includes(actor?.type)) {
    throw new CarePlanError('Only the patient or clinic staff can submit a document.', 'ACTOR_NOT_ALLOWED', 403);
  }

  const task = await loadActiveTask(taskId);
  if (actor.type === 'patient' && task.patientId !== String(patientRecordId)) {
    throw new CarePlanError('Task not found.', 'TASK_NOT_FOUND', 404);
  }
  if (task.type !== 'document_submission') {
    throw new CarePlanError('This task does not ask for a document.', 'NOT_A_DOCUMENT_TASK', 400);
  }
  if (task.status === TASK_STATUS.COMPLETED) {
    throw new CarePlanError('This document has already been received and verified.', 'TASK_CLOSED', 409);
  }

  if (!FILE_SIGNATURES[mimeType]) {
    throw new CarePlanError('Please upload a PDF, JPG, or PNG file.', 'UNSUPPORTED_FILE_TYPE', 415);
  }
  const buffer = decodeBase64(contentBase64);
  if (!buffer || buffer.length === 0) {
    throw new CarePlanError('The file could not be read.', 'INVALID_FILE', 400);
  }
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new CarePlanError('The file is too large (2.5 MB maximum). Try a smaller photo or scan.', 'FILE_TOO_LARGE', 413);
  }
  if (!matchesSignature(buffer, mimeType)) {
    throw new CarePlanError('The file content does not match its type. Please upload a real PDF, JPG, or PNG.', 'FILE_TYPE_MISMATCH', 415);
  }

  const pending = (await listSubmissionsByPlan(task.planId)).filter(s => s.taskId === task._id && s.status === 'pending_review');
  if (pending.length >= MAX_PENDING_PER_TASK) {
    throw new CarePlanError('Several files are already waiting for review for this task. Please wait for the clinic to check them.', 'TOO_MANY_PENDING', 429);
  }

  const name = cleanFileName(fileName);
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  return runInTransaction(async (session) => {
    const current = await findCareTaskById(task._id, { session });
    const now = new Date();
    const submission = await insertSubmission({
      taskId: new ObjectId(current._id),
      planId: new ObjectId(current.planId),
      patientId: new ObjectId(current.patientId),
      document: current.serviceRequirement?.document || null,
      fileName: name,
      mimeType,
      sizeBytes: buffer.length,
      sha256,
      content: new Binary(buffer),
      status: 'pending_review',
      submittedBy: toStoredActor(actor),
      submittedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null
    }, { session });

    await insertTaskEvents([{
      taskId: new ObjectId(current._id),
      planId: new ObjectId(current.planId),
      kind: 'document_submitted',
      from: current.status,
      to: current.status,
      actor: toStoredActor(actor),
      reason: `${name} (${Math.ceil(buffer.length / 1024)} KB) submitted${actor.type === 'patient' ? ' by the patient' : ' by clinic staff'}; waiting for a clinician to verify it.`,
      submissionId: new ObjectId(submission._id),
      at: now
    }], { session });

    return submission;
  });
}

/**
 * A clinician's review of a submitted file. Verifying records "document received and verified"
 * evidence, resolves the missing-document barrier, and completes the task if nothing else is missing.
 * Rejecting (with a reason) leaves the task waiting for a new file.
 */
export async function reviewDocumentSubmission({ submissionId, decision, note = '', actor }) {
  if (actor?.type !== 'clinician') {
    throw new CarePlanError('Only a clinician can verify a document.', 'ACTOR_NOT_ALLOWED', 403);
  }
  if (!['verify', 'reject'].includes(decision)) {
    throw new CarePlanError('Decision must be "verify" or "reject".', 'INVALID_DECISION', 400);
  }
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  if (decision === 'reject' && cleanNote.length < 3) {
    throw new CarePlanError('Please say why the document is not accepted, so the patient knows what to send.', 'REASON_REQUIRED', 400);
  }

  const submission = await findSubmissionById(submissionId);
  if (!submission) throw new CarePlanError('Document not found.', 'SUBMISSION_NOT_FOUND', 404);
  if (submission.status !== 'pending_review') {
    throw new CarePlanError('This document has already been reviewed.', 'ALREADY_REVIEWED', 409);
  }
  await loadActiveTask(submission.taskId);

  return runInTransaction(async (session) => {
    let task = await findCareTaskById(submission.taskId, { session });
    const reviewed = await reviewSubmission(submission._id, {
      status: decision === 'verify' ? 'verified' : 'rejected',
      reviewedBy: toStoredActor(actor),
      reviewNote: cleanNote || null
    }, { session });
    if (!reviewed) throw new CarePlanError('This document has already been reviewed.', 'ALREADY_REVIEWED', 409);

    const event = (fields) => ({
      taskId: new ObjectId(task._id),
      planId: new ObjectId(task.planId),
      from: task.status,
      to: task.status,
      actor: toStoredActor(actor),
      at: new Date(),
      submissionId: new ObjectId(submission._id),
      ...fields
    });

    if (decision === 'reject') {
      await insertTaskEvents([event({ kind: 'document_reviewed', reason: `${submission.fileName} not accepted: ${cleanNote}` })], { session });
      return { submission: reviewed, evidence: null, task, completed: false };
    }

    await insertTaskEvents([event({ kind: 'document_reviewed', reason: `${submission.fileName} verified${cleanNote ? `: ${cleanNote}` : ''}.` })], { session });

    let evidence = null;
    const already = (await listEvidenceByTask(task._id, { session })).some(e => e.type === 'document_verified');
    if (!already && task.requiredEvidence.includes('document_verified')) {
      evidence = await insertEvidence({
        taskId: new ObjectId(task._id),
        planId: new ObjectId(task.planId),
        type: 'document_verified',
        reference: `submission:${submission._id}`,
        verifiedReference: { submissionId: submission._id, fileName: submission.fileName, sha256: submission.sha256 },
        note: cleanNote,
        recordedBy: toStoredActor(actor),
        recordedAt: new Date()
      }, { session });
      await insertTaskEvents([event({ kind: 'evidence_recorded', evidenceId: new ObjectId(evidence._id), reason: EVIDENCE_TYPES.document_verified.label })], { session });
    }

    for (const barrier of await listOpenBarriersByTask(task._id, { session })) {
      if (barrier.code !== 'MISSING_DOCUMENT' || barrier.facilityCode) continue;
      await resolveBarrier(barrier._id, { resolution: `${documentLabel(task.serviceRequirement?.document)} received and verified`, resolvedBy: toStoredActor(actor) }, { session });
      await insertTaskEvents([event({
        kind: 'barrier_resolved',
        barrierId: new ObjectId(barrier._id),
        reason: `${BARRIER_CODES.MISSING_DOCUMENT.label}: document received and verified`
      })], { session });
    }

    await cancelOpenApprovalInSession({ session, task, actor, reason: 'The document arrived and was verified.' });
    task = await findCareTaskById(task._id, { session });
    const completion = await completeWhenEvidenceSatisfiedInSession({
      session,
      task,
      actor,
      reason: `Document verified by ${actor.name || 'a clinician'}.`
    });

    return { submission: reviewed, evidence, task: completion?.task || task, completed: Boolean(completion) };
  });
}
