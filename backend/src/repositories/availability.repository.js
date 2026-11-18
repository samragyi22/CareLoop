import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';

const COLLECTION_NAME = 'availability';

export function sanitizeAvailability(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    providerId: String(doc.providerId),
    startAt: doc.startAt instanceof Date ? doc.startAt.toISOString() : doc.startAt,
    endAt: doc.endAt instanceof Date ? doc.endAt.toISOString() : doc.endAt
  };
}

export async function initAvailabilityIndexes() {
  const db = getDb();
  if (!db) throw new Error('Database not connected. Cannot initialize availability indexes.');

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ providerId: 1, startAt: 1, endAt: 1 });
  await collection.createIndex({ startAt: 1, endAt: 1 });
}

/**
 * Checks if a requested window overlaps with an existing availability window for the provider.
 */
export async function findOverlappingAvailability(providerId, startAt, endAt, excludeId = null) {
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
    status: 'active',
    startAt: { $lt: endAt },
    endAt: { $gt: startAt }
  };

  if (excludeId) {
    try {
      query._id = { $ne: typeof excludeId === 'string' ? new ObjectId(excludeId) : excludeId };
    } catch (_) {}
  }

  return db.collection(COLLECTION_NAME).findOne(query);
}

/**
 * Creates an availability window for a provider.
 */
export async function createAvailability({ providerId, startAt, endAt, timezone = 'UTC' }) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  const startDate = new Date(startAt);
  const endDate = new Date(endAt);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    const error = new Error('Invalid start or end date format');
    error.statusCode = 400;
    error.code = 'INVALID_DATE_FORMAT';
    throw error;
  }

  if (endDate <= startDate) {
    const error = new Error('End time must be strictly after start time');
    error.statusCode = 400;
    error.code = 'INVALID_TIME_INTERVAL';
    throw error;
  }

  let providerObjId;
  try {
    providerObjId = typeof providerId === 'string' ? new ObjectId(providerId) : providerId;
  } catch (err) {
    const error = new Error('Invalid provider ID');
    error.statusCode = 400;
    error.code = 'INVALID_PROVIDER_ID';
    throw error;
  }

  // Prevent overlapping windows for the same provider
  const overlap = await findOverlappingAvailability(providerObjId, startDate, endDate);
  if (overlap) {
    const error = new Error('An overlapping availability window already exists for this provider');
    error.statusCode = 409;
    error.code = 'OVERLAPPING_AVAILABILITY';
    throw error;
  }

  const now = new Date();
  const doc = {
    providerId: providerObjId,
    startAt: startDate,
    endAt: endDate,
    timezone: timezone || 'UTC',
    status: 'active',
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection(COLLECTION_NAME).insertOne(doc);
  return sanitizeAvailability({ _id: result.insertedId, ...doc });
}

/**
 * Finds availability windows for a provider within an optional date range.
 */
export async function findAvailabilityByProvider(providerId, { startDate, endDate } = {}) {
  const db = getDb();
  if (!db) return [];

  let providerObjId;
  try {
    providerObjId = typeof providerId === 'string' ? new ObjectId(providerId) : providerId;
  } catch (err) {
    return [];
  }

  const query = {
    providerId: providerObjId,
    status: 'active'
  };

  // Only constrain the bounds that were provided (an empty `{}` condition would match nothing)
  if (startDate) {
    query.endAt = { $gt: new Date(startDate) };
  }
  if (endDate) {
    query.startAt = { $lt: new Date(endDate) };
  }

  const list = await db.collection(COLLECTION_NAME).find(query).sort({ startAt: 1 }).toArray();
  return list.map(sanitizeAvailability);
}

/**
 * Finds all active availability across all providers within a date range.
 */
export async function findAllActiveAvailability({ providerId, startDate, endDate } = {}) {
  const db = getDb();
  if (!db) return [];

  const query = { status: 'active' };

  if (providerId) {
    try {
      query.providerId = typeof providerId === 'string' ? new ObjectId(providerId) : providerId;
    } catch (_) {
      return [];
    }
  }

  if (startDate) {
    query.endAt = { ...(query.endAt || {}), $gt: new Date(startDate) };
  }
  if (endDate) {
    query.startAt = { ...(query.startAt || {}), $lt: new Date(endDate) };
  }

  const list = await db.collection(COLLECTION_NAME).find(query).sort({ startAt: 1 }).toArray();
  return list.map(sanitizeAvailability);
}

export async function findAvailabilityById(id) {
  const db = getDb();
  if (!db) return null;

  let queryId;
  try {
    queryId = typeof id === 'string' ? new ObjectId(id) : id;
  } catch (err) {
    return null;
  }

  const doc = await db.collection(COLLECTION_NAME).findOne({ _id: queryId });
  return sanitizeAvailability(doc);
}

/**
 * Deletes an availability window by ID.
 */
export async function deleteAvailability(id) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  let queryId;
  try {
    queryId = typeof id === 'string' ? new ObjectId(id) : id;
  } catch (err) {
    return false;
  }

  const result = await db.collection(COLLECTION_NAME).deleteOne({ _id: queryId });
  return result.deletedCount > 0;
}
