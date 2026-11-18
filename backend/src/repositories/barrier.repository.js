import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * Barriers: concrete reasons a care-plan task cannot proceed (e.g. the clinic is too far away).
 *
 * source: 'feasibility_check' (found by rules; auto-resolved when a re-check no longer finds it)
 *         'reported'          (entered by a person; stays open until someone resolves it)
 */
const COLLECTION_NAME = 'barriers';

export function sanitizeBarrier(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    taskId: String(doc.taskId),
    planId: String(doc.planId),
    patientId: String(doc.patientId),
    reportedBy: doc.reportedBy ? { ...doc.reportedBy, id: doc.reportedBy.id ? String(doc.reportedBy.id) : null } : null,
    resolvedBy: doc.resolvedBy ? { ...doc.resolvedBy, id: doc.resolvedBy.id ? String(doc.resolvedBy.id) : null } : null,
    detectedAt: isoOrNull(doc.detectedAt),
    lastSeenAt: isoOrNull(doc.lastSeenAt),
    resolvedAt: isoOrNull(doc.resolvedAt)
  };
}

export async function initBarrierIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ taskId: 1, resolvedAt: 1 });
  await collection.createIndex({ planId: 1 });
}

export async function insertBarrier(doc, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  const result = await db.collection(COLLECTION_NAME).insertOne(doc, { session });
  return sanitizeBarrier({ _id: result.insertedId, ...doc });
}

export async function findBarrierById(id, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  return sanitizeBarrier(await db.collection(COLLECTION_NAME).findOne({ _id: objectId }, { session }));
}

export async function listOpenBarriersByTask(taskId, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(taskId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ taskId: objectId, resolvedAt: null }, { session }).toArray();
  return docs.map(sanitizeBarrier);
}

export async function listBarriersByPlan(planId) {
  const db = getDb();
  const objectId = toObjectId(planId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ planId: objectId }).sort({ detectedAt: -1 }).toArray();
  return docs.map(sanitizeBarrier);
}

export async function refreshBarrier(id, { detail }, { session } = {}) {
  const db = getDb();
  if (!db) return null;

  await db.collection(COLLECTION_NAME).updateOne(
    { _id: toObjectId(id), resolvedAt: null },
    { $set: { detail, lastSeenAt: new Date() } },
    { session }
  );
}

/**
 * Resolves an open barrier. Returns the updated barrier, or null if it was already resolved.
 */
export async function resolveBarrier(id, { resolution, resolvedBy }, { session } = {}) {
  const db = getDb();
  if (!db) return null;

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: toObjectId(id), resolvedAt: null },
    { $set: { resolvedAt: new Date(), resolution, resolvedBy } },
    { returnDocument: 'after', session }
  );
  return sanitizeBarrier(result);
}
