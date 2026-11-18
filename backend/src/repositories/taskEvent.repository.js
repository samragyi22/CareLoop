import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * Append-only audit log of everything that happens to a care-plan task.
 * Events are only ever inserted, never updated or deleted.
 *
 * kind: 'created' | 'transition' | 'evidence_recorded'
 *       | 'feasibility_checked' | 'barrier_detected' | 'barrier_resolved' | 'replan_proposed'
 *       | 'approval_requested' | 'approval_granted' | 'approval_rejected' | 'patient_confirmed'
 *       | 'patient_declined' | 'approval_executed' | 'approval_failed' | 'approval_cancelled'
 *       | 'logistics_updated' | 'document_submitted' | 'document_reviewed' | 'agent_decision'
 */
const COLLECTION_NAME = 'task_events';

export function sanitizeTaskEvent(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    taskId: String(doc.taskId),
    planId: String(doc.planId),
    evidenceId: doc.evidenceId ? String(doc.evidenceId) : null,
    barrierId: doc.barrierId ? String(doc.barrierId) : null,
    proposalId: doc.proposalId ? String(doc.proposalId) : null,
    approvalId: doc.approvalId ? String(doc.approvalId) : null,
    submissionId: doc.submissionId ? String(doc.submissionId) : null,
    actor: doc.actor ? { ...doc.actor, id: doc.actor.id ? String(doc.actor.id) : null } : null,
    at: isoOrNull(doc.at)
  };
}

export async function initTaskEventIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ taskId: 1, at: 1 });
  await collection.createIndex({ planId: 1, at: 1 });
}

export async function insertTaskEvents(events, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');
  if (events.length === 0) return [];

  const result = await db.collection(COLLECTION_NAME).insertMany(events, { session });
  return events.map((event, i) => sanitizeTaskEvent({ _id: result.insertedIds[i], ...event }));
}

export async function listTaskEventsByPlan(planId) {
  const db = getDb();
  const objectId = toObjectId(planId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ planId: objectId }).sort({ at: 1, _id: 1 }).toArray();
  return docs.map(sanitizeTaskEvent);
}

export async function listTaskEventsByTask(taskId, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(taskId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ taskId: objectId }, { session }).sort({ at: 1, _id: 1 }).toArray();
  return docs.map(sanitizeTaskEvent);
}
