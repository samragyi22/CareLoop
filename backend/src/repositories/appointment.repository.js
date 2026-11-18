import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { getDb } from '../config/db.js';

const COLLECTION_NAME = 'appointments';

export function sanitizeAppointment(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    providerId: String(doc.providerId),
    patientUserId: doc.patientUserId ? String(doc.patientUserId) : null,
    rescheduledFrom: doc.rescheduledFrom ? String(doc.rescheduledFrom) : null,
    startAt: doc.startAt instanceof Date ? doc.startAt.toISOString() : doc.startAt,
    endAt: doc.endAt instanceof Date ? doc.endAt.toISOString() : doc.endAt,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
    cancelledAt: doc.cancelledAt instanceof Date ? doc.cancelledAt.toISOString() : doc.cancelledAt || null
  };
}

export function generateBookingReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = 'CL-';
  for (let i = 0; i < 6; i++) {
    ref += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return ref;
}

export async function initAppointmentIndexes() {
  const db = getDb();
  if (!db) throw new Error('Database not connected. Cannot initialize appointment indexes.');

  const collection = db.collection(COLLECTION_NAME);
  
  // 1. Unique booking reference
  await collection.createIndex({ bookingReference: 1 }, { unique: true });

  // 2. Provider schedule interval lookup
  await collection.createIndex({ providerId: 1, status: 1, startAt: 1, endAt: 1 });

  // 3. Unique idempotency key partial index (only indexes non-null string keys)
  // Drop legacy non-unique idempotencyKey_1 index if it exists
  try {
    const existing = await collection.indexes();
    const legacy = existing.find(i => i.name === 'idempotencyKey_1' && !i.unique);
    if (legacy) {
      console.log('[MongoDB Migration] Dropping non-unique idempotencyKey_1 index...');
      await collection.dropIndex('idempotencyKey_1');
      console.log('[MongoDB Migration] Non-unique index dropped successfully.');
    }
  } catch (err) {
    console.warn('[MongoDB Migration] Index inspection notice:', err.message);
  }

  await collection.createIndex(
    { idempotencyKey: 1 },
    { 
      unique: true, 
      partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      name: 'idempotencyKey_1_unique'
    }
  );

  // 4. Status index
  await collection.createIndex({ status: 1 });

  // 5. Unique provider confirmed startAt partial index
  // Deduplicate any legacy conflicting confirmed appointments by marking later duplicates cancelled
  try {
    const duplicates = await collection.aggregate([
      { $match: { status: 'confirmed' } },
      { $group: {
          _id: { providerId: '$providerId', startAt: '$startAt' },
          count: { $sum: 1 },
          ids: { $push: '$_id' }
      }},
      { $match: { count: { $gt: 1 } } }
    ]).toArray();

    if (duplicates.length > 0) {
      console.log(`[MongoDB Migration] Resolving ${duplicates.length} duplicate confirmed appointment slot(s)...`);
      for (const group of duplicates) {
        // Keep the first document, cancel the rest
        const toCancel = group.ids.slice(1);
        await collection.updateMany(
          { _id: { $in: toCancel } },
          { $set: { status: 'cancelled', cancelledAt: new Date(), notes: 'System migration: deduplicated legacy conflicting slot' } }
        );
      }
      console.log('[MongoDB Migration] Duplicate confirmed slots cleanly reconciled.');
    }
  } catch (dedupErr) {
    console.warn('[MongoDB Migration] Deduplication inspection warning:', dedupErr.message);
  }

  // Enforces at the database level that no two confirmed appointments can start at the identical timestamp for the same provider
  await collection.createIndex(
    { providerId: 1, startAt: 1 },
    {
      unique: true,
      partialFilterExpression: { status: 'confirmed' },
      name: 'provider_confirmed_startAt_unique'
    }
  );

  // 6. Patient search indexes
  await collection.createIndex({ 'patient.email': 1 });
  await collection.createIndex({ patientUserId: 1, startAt: 1 });
}

/**
 * Finds any confirmed appointment overlapping the requested window for the same provider.
 * Overlap condition: existing.startAt < requestedEnd && existing.endAt > requestedStart
 */
export async function findOverlappingAppointment(providerId, startAt, endAt, { excludeId = null, session } = {}) {
  const db = getDb();
  if (!db) return null;

  let providerObjId;
  try {
    providerObjId = typeof providerId === 'string' ? new ObjectId(providerId) : providerId;
  } catch (err) {
    return null;
  }

  const query = {
    providerId: providerObjId,
    status: 'confirmed',
    startAt: { $lt: endAt },
    endAt: { $gt: startAt }
  };

  if (excludeId) {
    try {
      query._id = { $ne: typeof excludeId === 'string' ? new ObjectId(excludeId) : excludeId };
    } catch (_) {}
  }

  return db.collection(COLLECTION_NAME).findOne(query, { session });
}

/**
 * Finds an appointment by idempotency key.
 */
export async function findAppointmentByIdempotencyKey(key, { session } = {}) {
  if (!key) return null;
  const db = getDb();
  if (!db) return null;

  const doc = await db.collection(COLLECTION_NAME).findOne({ idempotencyKey: key }, { session });
  return sanitizeAppointment(doc);
}

/**
 * Inserts a new appointment document.
 */
export async function insertAppointment(appointmentData, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  const now = new Date();
  const doc = {
    ...appointmentData,
    status: appointmentData.status || 'confirmed',
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection(COLLECTION_NAME).insertOne(doc, { session });
  return sanitizeAppointment({ _id: result.insertedId, ...doc });
}

/**
 * Finds an appointment by ID.
 */
export async function findAppointmentById(id, { session } = {}) {
  const db = getDb();
  if (!db) return null;

  let queryId;
  try {
    queryId = typeof id === 'string' ? new ObjectId(id) : id;
  } catch (err) {
    return null;
  }

  const doc = await db.collection(COLLECTION_NAME).findOne({ _id: queryId }, { session });
  return sanitizeAppointment(doc);
}

/**
 * Finds an appointment by booking reference.
 */
export async function findAppointmentByReference(reference, { session } = {}) {
  if (!reference) return null;
  const db = getDb();
  if (!db) return null;

  const doc = await db.collection(COLLECTION_NAME).findOne({ bookingReference: reference.trim().toUpperCase() }, { session });
  return sanitizeAppointment(doc);
}

/**
 * Queries appointments with filters (providerId, status, date range).
 */
export async function listAppointments({ providerId, status, startDate, endDate } = {}) {
  const db = getDb();
  if (!db) return [];

  const query = {};
  if (providerId) {
    try {
      query.providerId = typeof providerId === 'string' ? new ObjectId(providerId) : providerId;
    } catch (_) {
      return [];
    }
  }

  if (status) {
    query.status = status;
  }

  if (startDate || endDate) {
    query.startAt = {};
    if (startDate) query.startAt.$gte = new Date(startDate);
    if (endDate) query.startAt.$lte = new Date(endDate);
  }

  const list = await db.collection(COLLECTION_NAME)
    .find(query)
    .sort({ startAt: 1 })
    .toArray();

  return list.map(sanitizeAppointment);
}

/**
 * Queries appointments belonging strictly to a patient (by linked account ID, normalized email, or phone).
 */
export async function listAppointmentsByPatient({ patientUserId, email, phone, status } = {}) {
  const db = getDb();
  if (!db) return [];

  const orConditions = [];
  if (patientUserId) {
    try {
      orConditions.push({ patientUserId: typeof patientUserId === 'string' ? new ObjectId(patientUserId) : patientUserId });
    } catch (_) {
      // Ignore malformed IDs and fall back to the remaining identifiers
    }
  }
  if (email && typeof email === 'string') {
    const cleanEmail = email.trim().toLowerCase();
    // Case-insensitive exact match
    orConditions.push({ 'patient.email': new RegExp(`^${cleanEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  }
  if (phone && typeof phone === 'string') {
    orConditions.push({ 'patient.phone': phone.trim() });
  }

  if (orConditions.length === 0) {
    return [];
  }

  const query = orConditions.length === 1 ? orConditions[0] : { $or: orConditions };

  if (status) {
    query.status = status;
  }

  const list = await db.collection(COLLECTION_NAME)
    .find(query)
    .sort({ startAt: 1 })
    .toArray();

  return list.map(sanitizeAppointment);
}

/**
 * Updates status of an appointment (e.g. to cancelled), recording who cancelled it and why.
 */
export async function updateAppointmentStatus(id, newStatus, {
  cancelledAt = null,
  cancellationReason = null,
  cancelledBy = null,
  session
} = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  let queryId;
  try {
    queryId = typeof id === 'string' ? new ObjectId(id) : id;
  } catch (err) {
    return null;
  }

  const updates = {
    status: newStatus,
    updatedAt: new Date()
  };
  if (cancelledAt) {
    updates.cancelledAt = cancelledAt;
  }
  if (cancellationReason) {
    updates.cancellationReason = String(cancellationReason).trim().slice(0, 500);
  }
  if (cancelledBy) {
    updates.cancelledBy = cancelledBy;
  }

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: queryId },
    { $set: updates },
    { returnDocument: 'after', session }
  );

  return sanitizeAppointment(result);
}

export const STALE_OUTBOUND_LOCK_MS = 2 * 60 * 1000; // 2 minutes auto-recovery

/**
 * Atomically acquires an outbound call reservation lock on the appointment document.
 * Ensures concurrent requests cannot both proceed to dial external telephony.
 * Automatically reclaims abandoned in-progress locks older than STALE_OUTBOUND_LOCK_MS.
 */
export async function acquireOutboundCallLock(appointmentId, { reservationId, idempotencyKey = null, phone = null } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  let queryId;
  try {
    queryId = typeof appointmentId === 'string' ? new ObjectId(appointmentId) : appointmentId;
  } catch (err) {
    return null;
  }

  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_OUTBOUND_LOCK_MS);

  const filter = {
    _id: queryId,
    status: 'confirmed',
    $or: [
      { outboundCallLock: { $exists: false } },
      { outboundCallLock: null },
      { 'outboundCallLock.status': { $in: ['completed', 'failed', 'canceled', 'busy', 'no-answer'] } },
      { 'outboundCallLock.lockedAt': { $lt: staleThreshold } }
    ]
  };

  const generatedResId = reservationId || `RES-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const update = {
    $set: {
      outboundCallLock: {
        reservationId: generatedResId,
        status: 'reserving',
        phone: phone || null,
        idempotencyKey: idempotencyKey || null,
        lockedAt: now,
        callSid: null
      },
      updatedAt: now
    }
  };

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    filter,
    update,
    { returnDocument: 'after' }
  );

  return sanitizeAppointment(result);
}

/**
 * Commits the outbound call lock once the call is successfully created in Twilio.
 */
export async function commitOutboundCallLock(appointmentId, reservationId, { callSid, status = 'queued' } = {}) {
  const db = getDb();
  if (!db) return null;

  let queryId;
  try {
    queryId = typeof appointmentId === 'string' ? new ObjectId(appointmentId) : appointmentId;
  } catch (err) {
    return null;
  }

  const now = new Date();
  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    {
      _id: queryId,
      'outboundCallLock.reservationId': reservationId
    },
    {
      $set: {
        'outboundCallLock.callSid': callSid,
        'outboundCallLock.status': status,
        'outboundCallLock.committedAt': now,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );

  return sanitizeAppointment(result);
}

/**
 * Releases or marks failed the outbound call lock if external provider initiation fails.
 */
export async function releaseOutboundCallLock(appointmentId, reservationId, { status = 'failed', error = null } = {}) {
  const db = getDb();
  if (!db) return null;

  let queryId;
  try {
    queryId = typeof appointmentId === 'string' ? new ObjectId(appointmentId) : appointmentId;
  } catch (err) {
    return null;
  }

  const now = new Date();
  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    {
      _id: queryId,
      'outboundCallLock.reservationId': reservationId
    },
    {
      $set: {
        'outboundCallLock.status': status,
        'outboundCallLock.error': error ? String(error).slice(0, 200) : null,
        'outboundCallLock.releasedAt': now,
        updatedAt: now
      }
    },
    { returnDocument: 'after' }
  );

  return sanitizeAppointment(result);
}

/**
 * Updates the appointment's outbound call lock when Twilio reports a terminal status callback.
 */
export async function updateOutboundCallLockByCallSid(callSid, status) {
  const db = getDb();
  if (!db || !callSid) return null;

  const now = new Date();
  await db.collection(COLLECTION_NAME).updateOne(
    { 'outboundCallLock.callSid': callSid },
    {
      $set: {
        'outboundCallLock.status': status,
        'outboundCallLock.endedAt': now,
        updatedAt: now
      }
    }
  );
}

