import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * Documents a patient (or staff on their behalf) submits for a document task.
 * A submission is not evidence: it becomes evidence only when a clinician verifies it.
 *
 * status: 'pending_review' | 'verified' | 'rejected'
 */
const COLLECTION_NAME = 'document_submissions';

// Listing never loads file contents; only the download endpoint does
const WITHOUT_CONTENT = { projection: { content: 0 } };

function sanitizeActor(actor) {
  return actor ? { ...actor, id: actor.id ? String(actor.id) : null } : null;
}

export function sanitizeSubmission(doc) {
  if (!doc) return null;
  const { content, ...rest } = doc;
  return {
    ...rest,
    _id: String(doc._id),
    taskId: String(doc.taskId),
    planId: String(doc.planId),
    patientId: String(doc.patientId),
    submittedBy: sanitizeActor(doc.submittedBy),
    reviewedBy: sanitizeActor(doc.reviewedBy),
    submittedAt: isoOrNull(doc.submittedAt),
    reviewedAt: isoOrNull(doc.reviewedAt)
  };
}

export async function initDocumentSubmissionIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ taskId: 1, submittedAt: -1 });
  await collection.createIndex({ status: 1, submittedAt: 1 });
}

export async function insertSubmission(doc, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  const result = await db.collection(COLLECTION_NAME).insertOne(doc, { session });
  return sanitizeSubmission({ _id: result.insertedId, ...doc });
}

export async function findSubmissionById(id, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  return sanitizeSubmission(await db.collection(COLLECTION_NAME).findOne({ _id: objectId }, { ...WITHOUT_CONTENT, session }));
}

export async function findSubmissionFile(id) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  const doc = await db.collection(COLLECTION_NAME).findOne({ _id: objectId });
  if (!doc) return null;
  return { fileName: doc.fileName, mimeType: doc.mimeType, content: Buffer.from(doc.content.buffer) };
}

export async function listSubmissionsByPlan(planId) {
  const db = getDb();
  const objectId = toObjectId(planId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ planId: objectId }, WITHOUT_CONTENT).sort({ submittedAt: -1 }).toArray();
  return docs.map(sanitizeSubmission);
}

export async function listSubmissionsByStatus(status) {
  const db = getDb();
  if (!db) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ status }, WITHOUT_CONTENT).sort({ submittedAt: 1 }).toArray();
  return docs.map(sanitizeSubmission);
}

export async function listSubmissionsByPatient(patientId) {
  const db = getDb();
  const objectId = toObjectId(patientId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ patientId: objectId }, WITHOUT_CONTENT).sort({ submittedAt: -1 }).toArray();
  return docs.map(sanitizeSubmission);
}

/**
 * Records a review decision once. Returns null if the submission was already reviewed.
 */
export async function reviewSubmission(id, { status, reviewedBy, reviewNote }, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: objectId, status: 'pending_review' },
    { $set: { status, reviewedBy, reviewNote, reviewedAt: new Date() } },
    { returnDocument: 'after', projection: { content: 0 }, session }
  );
  return sanitizeSubmission(result);
}
