import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * Patient records: the clinical identity a care plan belongs to.
 * Separate from login accounts (`users`), because many patients reach the clinic only by phone
 * and never create a portal login. `userId` links the two when a login exists.
 */
const COLLECTION_NAME = 'patients';

export const PATIENT_LANGUAGES = ['hi', 'en'];

export function sanitizePatientRecord(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    userId: doc.userId ? String(doc.userId) : null,
    createdAt: isoOrNull(doc.createdAt),
    updatedAt: isoOrNull(doc.updatedAt)
  };
}

export async function initPatientIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ phone: 1 });
  await collection.createIndex(
    { userId: 1 },
    { name: 'one_record_per_login', unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }
  );
}

/**
 * Logistical constraints PlanPilot uses for feasibility checks (Phase 2). Never clinical data.
 */
function normalizeConstraints(constraints = {}) {
  return {
    hasOwnTransport: constraints.hasOwnTransport !== false,
    maxTravelKm: Number.isFinite(Number(constraints.maxTravelKm)) ? Number(constraints.maxTravelKm) : 25,
    documentsHeld: Array.isArray(constraints.documentsHeld) ? constraints.documentsHeld.map(String) : [],
    caregiverName: constraints.caregiverName ? String(constraints.caregiverName).trim() : null
  };
}

/**
 * Home location on the simulated district map (kilometres east/north of the district centre).
 * Real deployments would use geocoded addresses; the demo never stores real addresses.
 */
function normalizeLocation(location) {
  if (!location || !Number.isFinite(Number(location.x)) || !Number.isFinite(Number(location.y))) return null;
  return {
    label: location.label ? String(location.label).trim() : 'Home',
    x: Number(location.x),
    y: Number(location.y)
  };
}

export async function createPatientRecord({
  name,
  phone = null,
  preferredLanguage = 'hi',
  userId = null,
  constraints = {},
  location = null,
  isSynthetic = false
}) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  const now = new Date();
  const doc = {
    name: String(name).trim(),
    phone: phone ? String(phone).trim() : null,
    preferredLanguage: PATIENT_LANGUAGES.includes(preferredLanguage) ? preferredLanguage : 'hi',
    userId: toObjectId(userId),
    constraints: normalizeConstraints(constraints),
    location: normalizeLocation(location),
    ...(isSynthetic ? { isSynthetic: true } : {}),
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection(COLLECTION_NAME).insertOne(doc);
  return sanitizePatientRecord({ _id: result.insertedId, ...doc });
}

export async function findPatientRecordById(id, { session } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  return sanitizePatientRecord(await db.collection(COLLECTION_NAME).findOne({ _id: objectId }, { session }));
}

export async function findPatientRecordByUserId(userId) {
  const db = getDb();
  const objectId = toObjectId(userId);
  if (!db || !objectId) return null;

  return sanitizePatientRecord(await db.collection(COLLECTION_NAME).findOne({ userId: objectId }));
}

/**
 * Patient records using this phone number (several family members can share one phone).
 */
export async function findPatientRecordsByPhone(phone) {
  const db = getDb();
  if (!db || !phone) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ phone: String(phone).trim() }).sort({ createdAt: 1 }).toArray();
  return docs.map(sanitizePatientRecord);
}

export async function findPatientRecordsByName(name) {
  const db = getDb();
  if (!db || !name) return [];

  const docs = await db.collection(COLLECTION_NAME).find({ name: String(name).trim() }).toArray();
  return docs.map(sanitizePatientRecord);
}

/**
 * Updates a patient's logistical profile (constraints and/or location). Other fields are immutable here.
 */
export async function updatePatientLogistics(id, { constraints, location } = {}) {
  const db = getDb();
  const objectId = toObjectId(id);
  if (!db || !objectId) return null;

  const updates = { updatedAt: new Date() };
  if (constraints) updates.constraints = normalizeConstraints(constraints);
  if (location !== undefined) updates.location = normalizeLocation(location);

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { _id: objectId },
    { $set: updates },
    { returnDocument: 'after' }
  );
  return sanitizePatientRecord(result);
}

export async function listPatientRecords() {
  const db = getDb();
  if (!db) return [];

  const docs = await db.collection(COLLECTION_NAME).find({}).sort({ name: 1 }).toArray();
  return docs.map(sanitizePatientRecord);
}
