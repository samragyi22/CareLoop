import crypto from 'crypto';
import { getDb } from '../config/db.js';

/**
 * Server-Controlled Confirmation Lifecycle & State Machine (persisted in MongoDB)
 *
 * States:
 * - 'prepared': An action (booking, cancellation, reschedule) has been prepared and is awaiting caller confirmation
 * - 'confirmed': Caller has explicitly confirmed the action and commit is in progress
 * - 'completed': The action has been successfully committed to the database
 * - 'cancelled': The caller refused the action, changed their mind, or the call ended
 * - 'expired': The pending confirmation timed out before confirmation
 * - 'conflicted': A slot conflict occurred during final commit
 * - 'failed': Validation or unexpected failure occurred during commit
 *
 * Contexts survive server restarts. The prepared -> confirmed transition is a single atomic
 * update, so two concurrent confirmations of the same action cannot both commit.
 */

const COLLECTION_NAME = 'confirmations';
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes to confirm
const RETENTION_MS = 24 * 60 * 60 * 1000; // Finalized contexts kept 24h for replay and audit
const VALID_ACTIONS = ['BOOKING', 'CANCELLATION', 'RESCHEDULE'];

export class ConfirmationError extends Error {
  constructor(message, code = 'CONFIRMATION_ERROR', statusCode = 400) {
    super(message);
    this.name = 'ConfirmationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function getCollection() {
  const db = getDb();
  if (!db) {
    throw new ConfirmationError('Confirmation store is unavailable.', 'CONFIRMATION_STORE_UNAVAILABLE', 503);
  }
  return db.collection(COLLECTION_NAME);
}

function purgeDateFrom(now) {
  return new Date(now.getTime() + RETENTION_MS);
}

export async function initConfirmationIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ confirmationId: 1 }, { unique: true });
  await collection.createIndex({ callSid: 1, status: 1 });
  // At most one pending confirmation per call session
  await collection.createIndex(
    { callSid: 1 },
    { name: 'one_prepared_per_call', unique: true, partialFilterExpression: { status: 'prepared' } }
  );
  await collection.createIndex({ purgeAt: 1 }, { name: 'confirmation_purge_ttl', expireAfterSeconds: 0 });
}

/**
 * Prepares a new confirmation context bound to a voice call session.
 * Supersedes any existing pending confirmation for this session.
 */
export async function prepareConfirmation({
  callSid,
  action, // 'BOOKING' | 'CANCELLATION' | 'RESCHEDULE'
  payload, // verified action parameters
  summary, // human-readable summary for read-back
  ttlMs = DEFAULT_TTL_MS
}) {
  if (!callSid || typeof callSid !== 'string') {
    throw new ConfirmationError('A valid callSid is required to bind confirmation context.', 'INVALID_CALL_SID');
  }
  if (!action || !VALID_ACTIONS.includes(action)) {
    throw new ConfirmationError(`Invalid confirmation action: ${action}`, 'INVALID_ACTION');
  }

  const collection = getCollection();
  const confirmationId = `conf-${action.toLowerCase()}-${crypto.randomUUID()}`;

  // Retry covers a concurrent prepare on the same call racing us to the unique pending slot
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = new Date();
    await collection.updateMany(
      { callSid, status: 'prepared' },
      { $set: { status: 'cancelled', cancelledReason: 'superseded_by_new_action', updatedAt: now, purgeAt: purgeDateFrom(now) } }
    );

    const expiresAt = new Date(now.getTime() + ttlMs);
    const context = {
      confirmationId,
      callSid,
      action,
      status: 'prepared',
      payload: { ...payload },
      summary: { ...summary },
      createdAt: now,
      updatedAt: now,
      expiresAt,
      purgeAt: purgeDateFrom(expiresAt),
      result: null
    };

    try {
      await collection.insertOne(context);
      return {
        confirmationId,
        action,
        status: 'prepared',
        summary,
        expiresAt: expiresAt.toISOString()
      };
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }

  throw new ConfirmationError('Another action is being prepared on this call. Please try again.', 'CONFIRMATION_BUSY', 409);
}

/**
 * Retrieves and validates a confirmation context, marking it expired if its TTL has passed.
 */
export async function getConfirmation(confirmationId, callSid = null) {
  if (!confirmationId || typeof confirmationId !== 'string') {
    return null;
  }

  const collection = getCollection();
  const context = await collection.findOne({ confirmationId });
  if (!context) return null;

  // Validate call session binding
  if (callSid && context.callSid !== callSid) {
    throw new ConfirmationError(
      'Confirmation context does not belong to the active call session.',
      'CROSS_CALL_FORBIDDEN',
      403
    );
  }

  // Check TTL expiry
  if (context.status === 'prepared' && Date.now() > context.expiresAt.getTime()) {
    const now = new Date();
    await collection.updateOne(
      { confirmationId, status: 'prepared' },
      { $set: { status: 'expired', updatedAt: now, purgeAt: purgeDateFrom(now) } }
    );
    context.status = 'expired';
  }

  return context;
}

/**
 * Atomically transitions state from 'prepared' to 'confirmed'.
 * Rejects if expired, cross-call, action mismatch, or already finalized.
 */
export async function transitionToConfirmed(confirmationId, callSid, expectedAction) {
  const context = await getConfirmation(confirmationId, callSid);

  if (!context) {
    throw new ConfirmationError('Confirmation context not found.', 'CONFIRMATION_NOT_FOUND', 404);
  }

  if (context.action !== expectedAction) {
    throw new ConfirmationError(
      `Action mismatch. Expected ${expectedAction} but context is for ${context.action}.`,
      'ACTION_MISMATCH',
      400
    );
  }

  if (context.status === 'completed') {
    return { context, alreadyCompleted: true };
  }

  if (context.status === 'expired') {
    throw new ConfirmationError(
      'The confirmation request has expired. Please select the appointment again.',
      'CONFIRMATION_EXPIRED',
      410
    );
  }

  if (context.status === 'cancelled') {
    throw new ConfirmationError(
      'This pending action was previously cancelled or superseded.',
      'CONFIRMATION_CANCELLED',
      400
    );
  }

  if (context.status !== 'prepared') {
    throw new ConfirmationError(
      `Cannot confirm action from current state: "${context.status}".`,
      'INVALID_STATE_TRANSITION',
      400
    );
  }

  const collection = getCollection();
  const now = new Date();
  const updated = await collection.findOneAndUpdate(
    { confirmationId, status: 'prepared', expiresAt: { $gt: now } },
    { $set: { status: 'confirmed', confirmedAt: now, updatedAt: now } },
    { returnDocument: 'after' }
  );

  if (!updated) {
    // Lost a race with a concurrent confirmation, cancellation, or expiry
    const latest = await collection.findOne({ confirmationId });
    if (latest?.status === 'completed') {
      return { context: latest, alreadyCompleted: true };
    }
    throw new ConfirmationError(
      `Cannot confirm action from current state: "${latest?.status || 'unknown'}".`,
      'INVALID_STATE_TRANSITION',
      409
    );
  }

  return { context: updated, alreadyCompleted: false };
}

/**
 * Finalizes the confirmation context upon successful database commit.
 */
export async function transitionToCompleted(confirmationId, result) {
  const collection = getCollection();
  const now = new Date();
  return collection.findOneAndUpdate(
    { confirmationId },
    { $set: { status: 'completed', result, updatedAt: now, purgeAt: purgeDateFrom(now) } },
    { returnDocument: 'after' }
  );
}

/**
 * Transitions the confirmation context to 'conflicted' or 'failed'.
 */
export async function transitionToFailed(confirmationId, reason, status = 'failed') {
  const collection = getCollection();
  const now = new Date();
  return collection.findOneAndUpdate(
    { confirmationId },
    { $set: { status, errorReason: reason, updatedAt: now, purgeAt: purgeDateFrom(now) } },
    { returnDocument: 'after' }
  );
}

/**
 * Explicitly cancels the active pending confirmation for a call session.
 * Returns true if a pending confirmation was cancelled.
 */
export async function cancelActiveConfirmation(callSid, reason = 'caller_refused') {
  if (!callSid) return false;
  const collection = getCollection();
  const now = new Date();
  const result = await collection.updateMany(
    { callSid, status: 'prepared' },
    { $set: { status: 'cancelled', cancelledReason: reason, updatedAt: now, purgeAt: purgeDateFrom(now) } }
  );
  return result.modifiedCount > 0;
}
