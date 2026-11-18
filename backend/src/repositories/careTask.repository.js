import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

const COLLECTION_NAME = 'care_tasks';

export function sanitizeCareTask(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    planId: String(doc.planId),
    patientId: String(doc.patientId),
    dependsOn: (doc.dependsOn || []).map(String),
    dueAt: isoOrNull(doc.dueAt),
    originalDueAt: isoOrNull(doc.originalDueAt),
    booking: doc.booking ? { ...doc.booking, startAt: isoOrNull(doc.booking.startAt), endAt: isoOrNull(doc.booking.endAt) } : null,
    createdAt: isoOrNull(doc.createdAt),
    updatedAt: isoOrNull(doc.updatedAt)
  };
}

export async function initCareTaskIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ planId: 1, order: 1 });
  await collection.createIndex({ patientId: 1, status: 1 });
  await collection.createIndex({ status: 1, dueAt: 1 });
}

export async function insertCareTasks(docs, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');
  if (docs.length === 0) return [];

  await db.collection(COLLECTION_NAME).insertMany(docs, { session });
  return docs.map(sanitizeCareTask);
}

export async function findCareTaskById(id, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  return sanitizeCareTask(await db.collection(COLLECTION_NAME).findOne({ _id: objectId }, { session }));
}

export async function findCareTasksByIds(ids, { session } = {}) {
  const db = getDb();
  if (!db || ids.length === 0) return [];

  const objectIds = ids.map(toObjectId).filter(Boolean);
  const docs = await db.collection(COLLECTION_NAME).find({ _id: { $in: objectIds } }, { session }).toArray();
  return docs.map(sanitizeCareTask);
}

export async function listCareTasksByPlan(planId, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(planId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ planId: objectId }, { session }).sort({ order: 1 }).toArray();
  return docs.map(sanitizeCareTask);
}

/**
 * Compare-and-set status update: succeeds only if the task is still in `from` at `version`.
 * Returns the updated task, or null if someone else changed it first.
 */
export async function updateCareTaskStatus(id, { from, to, version }, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: objectId, status: from, version },
    { $set: { status: to, updatedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: 'after', session }
  );
  return sanitizeCareTask(result);
}

/**
 * Updates where and when a task happens (planned facility, booking, deadline) after an approved
 * change. Never touches status or the clinician's instruction. Bumps `version` so a concurrent
 * status change based on the old logistics is refused.
 */
export async function updateCareTaskLogistics(id, set, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  const allowed = ['serviceRequirement', 'originalFacilityCode', 'booking', 'dueAt', 'originalDueAt'];
  const updates = Object.fromEntries(Object.entries(set).filter(([key]) => allowed.includes(key)));
  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: objectId },
    { $set: { ...updates, updatedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: 'after', session }
  );
  return sanitizeCareTask(result);
}

export async function listCareTasksByStatuses(statuses) {
  const db = getDb();
  if (!db) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ status: { $in: statuses } }).sort({ dueAt: 1 }).toArray();
  return docs.map(sanitizeCareTask);
}

export async function listCareTasksByPatient(patientId) {
  const db = getDb();
  const objectId = toObjectId(patientId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ patientId: objectId }).sort({ planId: 1, order: 1 }).toArray();
  return docs.map(sanitizeCareTask);
}
