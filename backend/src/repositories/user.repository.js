import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';

const COLLECTION_NAME = 'users';

/**
 * Strips sensitive fields (like passwordHash) from a user document.
 */
export function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...sanitized } = user;
  return sanitized;
}

/**
 * Initializes required MongoDB indexes for the users collection.
 */
export async function initUserIndexes() {
  const db = getDb();
  if (!db) {
    throw new Error('Database not connected. Cannot initialize user indexes.');
  }

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ email: 1 }, { unique: true });
}

/**
 * Finds a user by email address (case-insensitive normalized).
 * By default, passwordHash is stripped unless includePassword is true.
 */
export async function findUserByEmail(email, { includePassword = false } = {}) {
  const db = getDb();
  if (!db) return null;

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await db.collection(COLLECTION_NAME).findOne({ email: normalizedEmail });

  if (!user) return null;
  return includePassword ? user : sanitizeUser(user);
}

/**
 * Finds a user by their MongoDB ObjectId or string id.
 */
export async function findUserById(id, { includePassword = false } = {}) {
  const db = getDb();
  if (!db) return null;

  let queryId;
  try {
    queryId = typeof id === 'string' ? new ObjectId(id) : id;
  } catch (err) {
    return null;
  }

  const user = await db.collection(COLLECTION_NAME).findOne({ _id: queryId });
  if (!user) return null;
  return includePassword ? user : sanitizeUser(user);
}

/**
 * Finds active patient accounts registered with the given phone number.
 */
export async function findActivePatientUsersByPhone(phone) {
  const db = getDb();
  if (!db || !phone) return [];

  const users = await db.collection(COLLECTION_NAME)
    .find({ role: 'patient', isActive: true, phone: String(phone).trim() })
    .limit(5)
    .toArray();
  return users.map(sanitizeUser);
}

/**
 * Creates a new user record in MongoDB.
 * Enforces role 'clinician' if not specified.
 */
export async function createUser({ name, email, passwordHash, role = 'clinician', phone = null, isActive = true, isSynthetic = false }) {
  const db = getDb();
  if (!db) {
    throw new Error('Database not connected. Cannot create user.');
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const now = new Date();

  const validRole = role === 'patient' ? 'patient' : 'clinician';

  const newUser = {
    name: name.trim(),
    email: normalizedEmail,
    passwordHash,
    role: validRole,
    phone: phone ? String(phone).trim() : null,
    isActive: Boolean(isActive),
    ...(isSynthetic ? { isSynthetic: true } : {}),
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection(COLLECTION_NAME).insertOne(newUser);
  return sanitizeUser({ _id: result.insertedId, ...newUser });
}
