import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * Approvals: a chosen option for a task (a replan alternative, or a slot at the planned facility)
 * waiting for the clinician's approval and/or the patient's confirmation before anything is booked.
 *
 * status: 'pending_clinician' -> 'pending_patient' -> 'approved' -> 'executing' -> 'executed'
 *         or 'rejected' (clinician) | 'declined' (patient) | 'failed' (could not be carried out)
 *         | 'cancelled' (the task changed while it was waiting)
 */
const COLLECTION_NAME = 'approvals';

export const OPEN_APPROVAL_STATUSES = ['pending_clinician', 'pending_patient', 'approved', 'executing'];

function sanitizeActor(actor) {
  return actor ? { ...actor, id: actor.id ? String(actor.id) : null } : null;
}

function sanitizeDecision(decision) {
  return decision ? { ...decision, by: sanitizeActor(decision.by), at: isoOrNull(decision.at) } : null;
}

export function sanitizeApproval(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    taskId: String(doc.taskId),
    planId: String(doc.planId),
    patientId: String(doc.patientId),
    proposalId: doc.proposalId ? String(doc.proposalId) : null,
    requestedBy: sanitizeActor(doc.requestedBy),
    clinicianDecision: sanitizeDecision(doc.clinicianDecision),
    patientDecision: sanitizeDecision(doc.patientDecision),
    execution: doc.execution ? { ...doc.execution, at: isoOrNull(doc.execution.at), startedAt: isoOrNull(doc.execution.startedAt) } : null,
    createdAt: isoOrNull(doc.createdAt),
    updatedAt: isoOrNull(doc.updatedAt)
  };
}

export async function initApprovalIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  // At most one open approval per task, even if two people choose options at the same moment
  await collection.createIndex(
    { taskId: 1 },
    { name: 'one_open_approval_per_task', unique: true, partialFilterExpression: { isOpen: true } }
  );
  await collection.createIndex({ status: 1, createdAt: 1 });
  await collection.createIndex({ planId: 1, createdAt: -1 });
}

export async function insertApproval(doc, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  const full = { ...doc, isOpen: OPEN_APPROVAL_STATUSES.includes(doc.status) };
  const result = await db.collection(COLLECTION_NAME).insertOne(full, { session });
  return sanitizeApproval({ _id: result.insertedId, ...full });
}

export async function findApprovalById(id, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  return sanitizeApproval(await db.collection(COLLECTION_NAME).findOne({ _id: objectId }, { session }));
}

export async function findOpenApprovalForTask(taskId, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(taskId);
  if (!db || !objectId) return null;

  return sanitizeApproval(await db.collection(COLLECTION_NAME).findOne({ taskId: objectId, isOpen: true }, { session }));
}

/**
 * Compare-and-set status change: applies only if the approval is still in one of `fromStatuses`.
 * Returns the updated approval, or null if someone else changed it first.
 */
export async function updateApprovalStatus(id, { fromStatuses, to, set = {}, extraFilter = {} }, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: objectId, status: { $in: fromStatuses }, ...extraFilter },
    { $set: { ...set, status: to, isOpen: OPEN_APPROVAL_STATUSES.includes(to), updatedAt: new Date() } },
    { returnDocument: 'after', session }
  );
  return sanitizeApproval(result);
}

export async function listApprovalsByPlan(planId) {
  const db = getDb();
  const objectId = toObjectId(planId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ planId: objectId }).sort({ createdAt: -1 }).toArray();
  return docs.map(sanitizeApproval);
}

export async function listApprovalsByTask(taskId, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(taskId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ taskId: objectId }, { session }).sort({ createdAt: -1 }).toArray();
  return docs.map(sanitizeApproval);
}

export async function listApprovalsByStatus(statuses) {
  const db = getDb();
  if (!db) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ status: { $in: statuses } }).sort({ createdAt: 1 }).toArray();
  return docs.map(sanitizeApproval);
}

export async function listOpenApprovalsByPatient(patientId) {
  const db = getDb();
  const objectId = toObjectId(patientId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ patientId: objectId, isOpen: true }).sort({ createdAt: 1 }).toArray();
  return docs.map(sanitizeApproval);
}
