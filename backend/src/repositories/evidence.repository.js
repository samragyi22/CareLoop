import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * Evidence records: proof that a care-plan task actually happened.
 * Like task events, evidence is append-only.
 */
const COLLECTION_NAME = 'evidence';

export function sanitizeEvidence(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    taskId: String(doc.taskId),
    planId: String(doc.planId),
    recordedBy: doc.recordedBy ? { ...doc.recordedBy, id: doc.recordedBy.id ? String(doc.recordedBy.id) : null } : null,
    recordedAt: isoOrNull(doc.recordedAt)
  };
}

export async function initEvidenceIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  // One record per evidence type per task, even under concurrent submissions
  await collection.createIndex({ taskId: 1, type: 1 }, { unique: true, name: 'one_evidence_type_per_task' });
  await collection.createIndex({ planId: 1 });
}

export async function insertEvidence(doc, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  const result = await db.collection(COLLECTION_NAME).insertOne(doc, { session });
  return sanitizeEvidence({ _id: result.insertedId, ...doc });
}

export async function listEvidenceByTask(taskId, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(taskId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ taskId: objectId }, { session }).sort({ recordedAt: 1 }).toArray();
  return docs.map(sanitizeEvidence);
}

export async function listEvidenceByPlan(planId) {
  const db = getDb();
  const objectId = toObjectId(planId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ planId: objectId }).sort({ recordedAt: 1 }).toArray();
  return docs.map(sanitizeEvidence);
}
