import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * Replan proposals: alternatives PlanPilot suggests when a task is blocked.
 * A proposal never changes anything by itself; acting on one needs the approval it lists.
 *
 * status: 'proposed' | 'superseded' (replaced by a newer check) | 'selected' (an option was chosen and
 *         sent for approval; see the `approvals` collection)
 */
const COLLECTION_NAME = 'replan_proposals';

export function sanitizeProposal(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    taskId: String(doc.taskId),
    planId: String(doc.planId),
    approvalId: doc.approvalId ? String(doc.approvalId) : null,
    createdBy: doc.createdBy ? { ...doc.createdBy, id: doc.createdBy.id ? String(doc.createdBy.id) : null } : null,
    createdAt: isoOrNull(doc.createdAt),
    updatedAt: isoOrNull(doc.updatedAt)
  };
}

export async function initReplanProposalIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ taskId: 1, status: 1, createdAt: -1 });
  await collection.createIndex({ planId: 1, status: 1 });
}

export async function supersedeOpenProposals(taskId, { session } = {}) {
  const db = getDb();
  if (!db) return;

  await db.collection(COLLECTION_NAME).updateMany(
    { taskId: toObjectId(taskId), status: 'proposed' },
    { $set: { status: 'superseded', updatedAt: new Date() } },
    { session }
  );
}

export async function insertProposal(doc, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  const result = await db.collection(COLLECTION_NAME).insertOne(doc, { session });
  return sanitizeProposal({ _id: result.insertedId, ...doc });
}

export async function listOpenProposalsByPlan(planId) {
  const db = getDb();
  const objectId = toObjectId(planId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ planId: objectId, status: 'proposed' }).sort({ createdAt: -1 }).toArray();
  return docs.map(sanitizeProposal);
}

export async function findProposalById(id, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  return sanitizeProposal(await db.collection(COLLECTION_NAME).findOne({ _id: objectId }, { session }));
}

/**
 * Marks an open proposal as having had one of its alternatives chosen. Returns null if the
 * proposal is no longer open (e.g. a newer feasibility check superseded it).
 */
export async function markProposalSelected(id, { alternativeId, approvalId }, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: objectId, status: 'proposed' },
    { $set: { status: 'selected', selectedAlternativeId: alternativeId, approvalId, updatedAt: new Date() } },
    { returnDocument: 'after', session }
  );
  return sanitizeProposal(result);
}
