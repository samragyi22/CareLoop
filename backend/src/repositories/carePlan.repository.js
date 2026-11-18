import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

const COLLECTION_NAME = 'care_plans';

export function sanitizeCarePlan(doc) {
  if (!doc) return null;
  const { agentLock, ...rest } = doc;
  return {
    ...rest,
    _id: String(doc._id),
    patientId: String(doc.patientId),
    approvedBy: doc.approvedBy ? { ...doc.approvedBy, id: String(doc.approvedBy.id) } : null,
    approvedAt: isoOrNull(doc.approvedAt),
    completedAt: isoOrNull(doc.completedAt),
    createdAt: isoOrNull(doc.createdAt),
    updatedAt: isoOrNull(doc.updatedAt)
  };
}

export async function initCarePlanIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ patientId: 1, createdAt: -1 });
  await collection.createIndex({ status: 1 });
}

export async function insertCarePlan(doc, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  await db.collection(COLLECTION_NAME).insertOne(doc, { session });
  return sanitizeCarePlan(doc);
}

export async function findCarePlanById(id, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  return sanitizeCarePlan(await db.collection(COLLECTION_NAME).findOne({ _id: objectId }, { session }));
}

export async function listCarePlans({ patientId, status } = {}) {
  const db = getDb();
  if (!db) return [];

  const query = {};
  if (patientId) {
    const objectId = toObjectId(patientId);
    if (!objectId) return [];
    query.patientId = objectId;
  }
  if (status) query.status = status;

  const docs = await db.collection(COLLECTION_NAME).find(query).sort({ createdAt: -1 }).toArray();
  return docs.map(sanitizeCarePlan);
}

/**
 * Marks an active plan completed. No-op if it is already completed.
 */
export async function markCarePlanCompleted(id, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  const now = new Date();
  return db.collection(COLLECTION_NAME).updateOne(
    { _id: objectId, status: 'active' },
    { $set: { status: 'completed', completedAt: now, updatedAt: now } },
    { session }
  );
}

/**
 * Claims the plan for one PlanPilot agent run, so a scheduled tick and a manual run never act on the
 * same plan at once. A lock older than `ttlMs` (a crashed run) can be taken over.
 * Returns true if this run holds the lock.
 */
export async function acquirePlanAgentLock(id, runId, ttlMs) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return false;

  const now = new Date();
  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: objectId, $or: [{ agentLock: null }, { agentLock: { $exists: false } }, { 'agentLock.until': { $lt: now } }] },
    { $set: { agentLock: { runId, until: new Date(now.getTime() + ttlMs) } } },
    { returnDocument: 'after' }
  );
  return Boolean(result);
}

export async function releasePlanAgentLock(id, runId) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return;

  await db.collection(COLLECTION_NAME).updateOne({ _id: objectId, 'agentLock.runId': runId }, { $set: { agentLock: null } });
}
