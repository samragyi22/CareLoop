import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';

const COLLECTION_NAME = 'providers';

export function sanitizeProvider(provider) {
  if (!provider) return null;
  return {
    ...provider,
    _id: String(provider._id)
  };
}

export async function initProviderIndexes() {
  const db = getDb();
  if (!db) throw new Error('Database not connected. Cannot initialize provider indexes.');

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ specialty: 1 });
  await collection.createIndex({ isActive: 1 });
}

export async function createProvider({ name, specialty, location = null, isActive = true }, { session } = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Provider name is required');
  }
  if (!specialty || typeof specialty !== 'string' || !specialty.trim()) {
    throw new Error('Provider specialty is required');
  }

  const now = new Date();
  const doc = {
    name: name.trim(),
    specialty: specialty.trim(),
    ...(location ? { location: String(location).trim() } : {}),
    isActive: Boolean(isActive),
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection(COLLECTION_NAME).insertOne(doc, { session });
  return sanitizeProvider({ _id: result.insertedId, ...doc });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function findProviders({ specialty, name, isActive } = {}) {
  const db = getDb();
  if (!db) return [];

  const query = {};
  if (typeof specialty === 'string' && specialty.trim()) {
    query.specialty = new RegExp(`^${escapeRegex(specialty.trim())}$`, 'i');
  }
  if (typeof name === 'string' && name.trim()) {
    // Partial, case-insensitive match so "Rao" or "Dr. Rao" both find "Dr. Kavita Rao"
    query.name = new RegExp(escapeRegex(name.trim().replace(/^dr\.?\s*/i, '')), 'i');
  }
  if (typeof isActive === 'boolean') {
    query.isActive = isActive;
  }

  const list = await db.collection(COLLECTION_NAME).find(query).sort({ name: 1 }).toArray();
  return list.map(sanitizeProvider);
}

/**
 * Returns the distinct specialties offered by active providers, sorted alphabetically.
 */
export async function listActiveSpecialties() {
  const db = getDb();
  if (!db) return [];

  const specialties = await db.collection(COLLECTION_NAME).distinct('specialty', { isActive: true });
  return specialties.filter(Boolean).sort();
}

export async function findProviderById(id, { session } = {}) {
  const db = getDb();
  if (!db) return null;

  let queryId;
  try {
    queryId = typeof id === 'string' ? new ObjectId(id) : id;
  } catch (err) {
    return null;
  }

  const provider = await db.collection(COLLECTION_NAME).findOne({ _id: queryId }, { session });
  return sanitizeProvider(provider);
}

export async function updateProvider(id, updates = {}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  let queryId;
  try {
    queryId = typeof id === 'string' ? new ObjectId(id) : id;
  } catch (err) {
    return null;
  }

  const allowedUpdates = {};
  if (typeof updates.name === 'string' && updates.name.trim()) {
    allowedUpdates.name = updates.name.trim();
  }
  if (typeof updates.specialty === 'string' && updates.specialty.trim()) {
    allowedUpdates.specialty = updates.specialty.trim();
  }
  if (typeof updates.isActive === 'boolean') {
    allowedUpdates.isActive = updates.isActive;
  }

  if (Object.keys(allowedUpdates).length === 0) {
    return findProviderById(queryId);
  }

  allowedUpdates.updatedAt = new Date();

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: queryId },
    { $set: allowedUpdates },
    { returnDocument: 'after' }
  );

  return sanitizeProvider(result);
}

export async function deactivateProvider(id) {
  return updateProvider(id, { isActive: false });
}
