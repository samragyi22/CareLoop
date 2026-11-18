import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * One record per PlanPilot agent run over a care plan: what it decided for each task, who or what
 * decided (LLM or rules, and why it fell back), and what happened. Kept for review and evaluation.
 */
const COLLECTION_NAME = 'agent_runs';

export function sanitizeAgentRun(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    planId: String(doc.planId),
    requestedBy: doc.requestedBy ? { ...doc.requestedBy, id: doc.requestedBy.id ? String(doc.requestedBy.id) : null } : null,
    startedAt: isoOrNull(doc.startedAt),
    finishedAt: isoOrNull(doc.finishedAt)
  };
}

export async function initAgentRunIndexes() {
  const db = getDb();
  if (!db) return;
  await db.collection(COLLECTION_NAME).createIndex({ planId: 1, startedAt: -1 });
}

export async function insertAgentRun(doc) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');
  await db.collection(COLLECTION_NAME).insertOne(doc);
  return sanitizeAgentRun(doc);
}

export async function listAgentRunsByPlan(planId, { limit = 10 } = {}) {
  const db = getDb();
  const objectId = toObjectId(planId);
  if (!db || !objectId) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ planId: objectId }).sort({ startedAt: -1 }).limit(limit).toArray();
  return docs.map(sanitizeAgentRun);
}
