import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * Symptom checks done on phone health calls: what the person reported, the protocol's decision
 * (care level and advice), and any appointment booked from it. One record per check.
 */
const COLLECTION_NAME = 'symptom_checks';

export function sanitizeSymptomCheck(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    patientId: doc.patientId ? String(doc.patientId) : null,
    appointment: doc.appointment ? { ...doc.appointment, startAt: isoOrNull(doc.appointment.startAt) } : null,
    followUpOn: isoOrNull(doc.followUpOn),
    reviewedAt: isoOrNull(doc.reviewedAt),
    createdAt: isoOrNull(doc.createdAt),
    updatedAt: isoOrNull(doc.updatedAt)
  };
}

export async function initSymptomCheckIndexes() {
  const db = getDb();
  if (!db) return;
  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ createdAt: -1 });
  await collection.createIndex({ careLevel: 1, reviewedAt: 1 });
  await collection.createIndex({ phone: 1, createdAt: -1 });
  await collection.createIndex({ callSid: 1 });
}

export async function insertSymptomCheck(doc) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');
  const result = await db.collection(COLLECTION_NAME).insertOne(doc);
  return sanitizeSymptomCheck({ _id: result.insertedId, ...doc });
}

/**
 * Saves a phone call's symptom check. A new assessment on the same call (the assistant asked again,
 * or retried) replaces the earlier one unless that one already led to a booking, so each call shows
 * as a single check.
 */
export async function saveSymptomCheckForCall(doc) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');
  if (!doc.callSid) return insertSymptomCheck(doc);
  const { createdAt, ...fields } = doc;
  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { callSid: doc.callSid, appointment: null },
    { $set: fields, $setOnInsert: { createdAt } },
    { upsert: true, returnDocument: 'after' }
  );
  return sanitizeSymptomCheck(result);
}

export async function findSymptomCheckById(id) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;
  return sanitizeSymptomCheck(await db.collection(COLLECTION_NAME).findOne({ _id: objectId }));
}

export async function findSymptomCheckByCallSid(callSid) {
  const db = getDb();
  if (!db || !callSid) return null;
  return sanitizeSymptomCheck(await db.collection(COLLECTION_NAME).findOne({ callSid }));
}

export async function updateSymptomCheck(id, set) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;
  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: objectId },
    { $set: { ...set, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  return sanitizeSymptomCheck(result);
}

export async function listSymptomChecks({ limit = 50 } = {}) {
  const db = getDb();
  if (!db) return [];
  const docs = await db.collection(COLLECTION_NAME).find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map(sanitizeSymptomCheck);
}

/**
 * Urgent, emergency and unfinished ("call back") checks a clinician has not reviewed yet (for the review queue).
 */
export async function listUnreviewedAlerts() {
  const db = getDb();
  if (!db) return [];
  const docs = await db.collection(COLLECTION_NAME)
    .find({ careLevel: { $in: ['urgent', 'emergency', 'call_back'] }, reviewedAt: null })
    .sort({ createdAt: -1 })
    .toArray();
  return docs.map(sanitizeSymptomCheck);
}
