import crypto from 'crypto';
import { getDb } from '../config/db.js';
import { normalizeE164Phone } from './callbackConsent.repository.js';
import { maskPhoneNumber } from './voiceCall.repository.js';

const COLLECTION_NAME = 'callback_locks';
export const LOCK_TTL_MS = 60 * 1000; // 60s lock timeout for abandoned/stale reservations

const TERMINAL_LOCK_STATUSES = ['completed', 'failed', 'canceled', 'busy', 'no-answer'];

export async function initCallbackLockIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ triggerCallSid: 1 });
  await collection.createIndex({ callbackCallSid: 1 });
  await collection.createIndex({ createdAt: -1 });
  await collection.createIndex({ status: 1 });
  // Partial unique index prevents concurrent reservations on identical phone number
  try {
    await collection.createIndex(
      { phone: 1, status: 1 },
      { name: 'phone_reserving_unique', unique: true, partialFilterExpression: { status: 'reserving' } }
    );
  } catch (_) {}
}

/**
 * Scans for abandoned/stale callback reservations (e.g. from server crashes during dialing)
 * and safely transitions them to 'failed' (ABANDONED_RESERVATION_TIMEOUT).
 */
export async function recoverAbandonedCallbackLocks({ maxAgeMs = LOCK_TTL_MS } = {}) {
  const db = getDb();
  if (!db) return 0;

  const cutoff = new Date(Date.now() - maxAgeMs);
  const now = new Date();

  const result = await db.collection(COLLECTION_NAME).updateMany(
    {
      status: 'reserving',
      lockedAt: { $lt: cutoff }
    },
    {
      $set: {
        status: 'failed',
        error: 'ABANDONED_RESERVATION_TIMEOUT',
        recoveredAt: now,
        releasedAt: now,
        updatedAt: now
      }
    }
  );

  if (result.modifiedCount > 0) {
    console.log(`[Callback Lock Recovery] Cleaned up ${result.modifiedCount} abandoned callback reservation(s).`);
  }
  return result.modifiedCount;
}

/**
 * Checks whether this trigger CallSid has already initiated a callback.
 */
export async function findCallbackByTriggerSid(triggerCallSid) {
  const db = getDb();
  if (!db || !triggerCallSid) return null;

  return db.collection(COLLECTION_NAME).findOne({ triggerCallSid });
}

/**
 * Finds callback lock by the outbound callback CallSid.
 */
export async function findCallbackBySid(callbackCallSid) {
  const db = getDb();
  if (!db || !callbackCallSid) return null;

  return db.collection(COLLECTION_NAME).findOne({ callbackCallSid });
}

/**
 * Counts callbacks placed to this phone number within a rolling time window (default: 24h).
 */
export async function countRecentCallbacks(phone, windowMs = 24 * 60 * 60 * 1000) {
  const db = getDb();
  const normalized = normalizeE164Phone(phone);
  if (!db || !normalized) return 0;

  const since = new Date(Date.now() - windowMs);
  return db.collection(COLLECTION_NAME).countDocuments({
    phone: normalized,
    status: { $in: ['active', 'queued', 'initiated', 'ringing', 'in-progress', 'completed'] },
    createdAt: { $gte: since }
  });
}

/**
 * Retrieves the most recent callback lock/record for a phone number.
 */
export async function getLatestCallback(phone) {
  const db = getDb();
  const normalized = normalizeE164Phone(phone);
  if (!db || !normalized) return null;

  const docs = await db.collection(COLLECTION_NAME)
    .find({ phone: normalized, status: { $in: ['active', 'queued', 'initiated', 'ringing', 'in-progress', 'completed', 'reserving'] } })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  return docs.length > 0 ? docs[0] : null;
}

/**
 * Atomically acquires a callback lock for a phone number while checking:
 * 1. Automatic recovery of stale abandoned reservations
 * 2. Duplicate trigger CallSid (idempotency)
 * 3. Active in-flight reservation on the same phone (concurrency guard)
 * 4. Cooldown duration
 * 5. 24-hour attempt limits
 */
export async function acquireCallbackLock(phone, {
  triggerCallSid,
  cooldownSeconds = 300,
  maxAttempts = 3,
  now = new Date()
} = {}) {
  const db = getDb();
  const normalized = normalizeE164Phone(phone);
  if (!db) throw new Error('Database connection unavailable.');
  if (!normalized) {
    return {
      success: false,
      reason: 'INVALID_PHONE_NUMBER',
      message: 'A valid E.164 phone number is required.'
    };
  }
  if (!triggerCallSid) {
    return {
      success: false,
      reason: 'MISSING_TRIGGER_SID',
      message: 'A trigger CallSid is required to place a callback.'
    };
  }

  const collection = db.collection(COLLECTION_NAME);

  // 1. Recover stale reservations across backend restarts or crashed requests
  await recoverAbandonedCallbackLocks().catch(() => {});

  // 2. Check duplicate trigger CallSid (idempotency)
  const existingTrigger = await collection.findOne({ triggerCallSid });
  if (existingTrigger) {
    console.log(`[Callback Lock] Trigger ${triggerCallSid} already processed with lock ${existingTrigger.lockId}.`);
    return {
      success: false,
      reason: 'TRIGGER_ALREADY_PROCESSED',
      lock: existingTrigger,
      isDuplicate: true,
      callbackCallSid: existingTrigger.callbackCallSid || null
    };
  }

  // 3. Check active in-flight reservation (concurrency guard)
  const activeReservation = await collection.findOne({
    phone: normalized,
    status: 'reserving',
    lockedAt: { $gte: new Date(now.getTime() - LOCK_TTL_MS) }
  });

  if (activeReservation) {
    console.warn(`[Callback Lock] Concurrency conflict: Callback already reserving for ${maskPhoneNumber(normalized)}.`);
    return {
      success: false,
      reason: 'CALLBACK_IN_PROGRESS',
      message: 'A callback is currently being prepared for this phone number.'
    };
  }

  // 4. Cooldown verification against completed or active calls
  const latestCompleted = await collection.findOne(
    {
      phone: normalized,
      status: { $in: ['active', 'queued', 'initiated', 'ringing', 'in-progress', 'completed'] }
    },
    { sort: { createdAt: -1 } }
  );

  if (latestCompleted && latestCompleted.createdAt) {
    const elapsedSeconds = (now.getTime() - new Date(latestCompleted.createdAt).getTime()) / 1000;
    if (elapsedSeconds < cooldownSeconds) {
      const remainingSeconds = Math.ceil(cooldownSeconds - elapsedSeconds);
      console.log(`[Callback Lock] Cooldown active for ${maskPhoneNumber(normalized)}: ${remainingSeconds}s remaining.`);
      return {
        success: false,
        reason: 'COOLDOWN_ACTIVE',
        remainingSeconds,
        message: `Callback cooldown active. Please wait ${remainingSeconds} seconds before requesting another callback.`
      };
    }
  }

  // 5. Maximum attempts limit check (last 24 hours UTC)
  const window24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const attemptsCount = await collection.countDocuments({
    phone: normalized,
    status: { $in: ['active', 'queued', 'initiated', 'ringing', 'in-progress', 'completed'] },
    createdAt: { $gte: window24h }
  });

  if (attemptsCount >= maxAttempts) {
    console.warn(`[Callback Lock] Max attempts exceeded for ${maskPhoneNumber(normalized)} (${attemptsCount}/${maxAttempts}).`);
    return {
      success: false,
      reason: 'MAX_ATTEMPTS_EXCEEDED',
      attemptsCount,
      maxAttempts,
      message: `Maximum daily callback requests reached (${attemptsCount}/${maxAttempts}).`
    };
  }

  // 6. Atomically acquire new lock
  const lockId = `CBL-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const lockDoc = {
    lockId,
    phone: normalized,
    triggerCallSid,
    callbackCallSid: null,
    status: 'reserving',
    lockedAt: now,
    createdAt: now,
    updatedAt: now
  };

  try {
    await collection.insertOne(lockDoc);
    console.log(`[Callback Lock] Acquired lock ${lockId} for ${maskPhoneNumber(normalized)} (trigger: ${triggerCallSid})`);
    return {
      success: true,
      lockId,
      lock: lockDoc
    };
  } catch (err) {
    if (err.code === 11000) {
      console.warn(`[Callback Lock] Concurrency conflict (unique partial index): Callback already reserving for ${maskPhoneNumber(normalized)}.`);
      return {
        success: false,
        reason: 'CALLBACK_IN_PROGRESS',
        message: 'A callback is currently being prepared for this phone number.'
      };
    }
    console.error(`[Callback Lock] Error inserting lock document:`, err.message);
    return {
      success: false,
      reason: 'LOCK_ACQUISITION_FAILED',
      message: err.message
    };
  }
}

/**
 * Commits an acquired callback lock with the resulting outbound CallSid.
 */
export async function commitCallbackLock(lockId, { callbackCallSid, status = 'queued' } = {}) {
  const db = getDb();
  if (!db || !lockId) return null;

  const now = new Date();
  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { lockId },
    {
      $set: {
        callbackCallSid: callbackCallSid || null,
        status,
        committedAt: now,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );

  console.log(`[Callback Lock] Committed lock ${lockId} -> callbackCallSid: ${callbackCallSid} (status: ${status})`);
  return result;
}

/**
 * Releases a callback lock in case outbound call placement fails.
 */
export async function releaseCallbackLock(lockId, { status = 'failed', error = null } = {}) {
  const db = getDb();
  if (!db || !lockId) return null;

  const now = new Date();
  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { lockId },
    {
      $set: {
        status,
        error: error ? String(error) : null,
        releasedAt: now,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );

  console.log(`[Callback Lock] Released lock ${lockId} with status "${status}" (error: ${error || 'none'})`);
  return result;
}

/**
 * Synchronizes callback lock status when Twilio status callbacks arrive.
 * Enforces terminal-state preservation so terminal statuses are never overwritten by out-of-order events.
 */
export async function updateCallbackLockStatus(callbackCallSid, status, { durationSeconds = null, error = null } = {}) {
  const db = getDb();
  if (!db || !callbackCallSid) return null;

  const collection = db.collection(COLLECTION_NAME);
  const current = await collection.findOne({ callbackCallSid });
  if (!current) return null;

  const isCurrentTerminal = TERMINAL_LOCK_STATUSES.includes(current.status);
  const isNewTerminal = TERMINAL_LOCK_STATUSES.includes(status);

  // Preserve terminal state
  if (isCurrentTerminal && !isNewTerminal) {
    console.log(`[Callback Lock] Ignored non-terminal status "${status}" for terminal callback lock ${callbackCallSid} (current: ${current.status})`);
    return current;
  }

  const now = new Date();
  const updates = {
    updatedAt: now
  };

  if (!isCurrentTerminal || isNewTerminal) {
    updates.status = status;
  }
  if (typeof durationSeconds === 'number') {
    updates.durationSeconds = durationSeconds;
  }
  if (error) {
    updates.error = String(error);
  }
  if (isNewTerminal && !current.endedAt) {
    updates.endedAt = now;
  }

  const result = await collection.findOneAndUpdate(
    { callbackCallSid },
    { $set: updates },
    { returnDocument: 'after' }
  );

  return result;
}
