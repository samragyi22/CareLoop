import { getDb } from '../config/db.js';
import { toObjectId, isoOrNull } from '../utils/objectId.js';

/**
 * Directory of healthcare facilities PlanPilot can route patients to.
 * In this prototype every entry is SIMULATED (`isSimulated: true`) and must be labelled as such
 * wherever it is shown. Clinic facilities link to real provider calendars via `providerIds`.
 *
 * Fields:
 *   code               stable identifier used by care-plan templates (e.g. "CARELOOP-DISTRICT")
 *   category           'clinic' | 'lab'
 *   modality           'in_person' | 'home_visit' | 'teleconsult'
 *   specialties[]      clinic services offered (e.g. "General Practice")
 *   tests[]            lab tests offered (e.g. "lipid_profile")
 *   location           { label, x, y } on the simulated district map (km)
 *   hours              { days: [0-6], open: "HH:MM", close: "HH:MM" } in clinic-local time
 *   requiredDocuments  documents a patient must bring (e.g. "aadhaar")
 *   bookAheadDays      minimum notice for home visits
 *   providerIds[]      doctors whose calendars serve this facility
 */
const COLLECTION_NAME = 'service_directory';

export function sanitizeFacility(doc) {
  if (!doc) return null;
  return {
    ...doc,
    _id: String(doc._id),
    providerIds: (doc.providerIds || []).map(String),
    createdAt: isoOrNull(doc.createdAt),
    updatedAt: isoOrNull(doc.updatedAt)
  };
}

export async function initServiceDirectoryIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ code: 1 }, { unique: true });
  await collection.createIndex({ category: 1, isActive: 1 });
}

/**
 * Inserts the facility if its code is new; otherwise leaves the existing entry untouched.
 */
export async function upsertFacility(facility) {
  const db = getDb();
  if (!db) throw new Error('Database not connected.');

  const now = new Date();
  const { code, ...fields } = facility;
  const doc = {
    ...fields,
    providerIds: (facility.providerIds || []).map(toObjectId).filter(Boolean),
    isActive: facility.isActive !== false,
    isSimulated: true,
    updatedAt: now
  };

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { code },
    { $setOnInsert: { ...doc, createdAt: now } },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true }
  );
  return { facility: sanitizeFacility(result.value), created: !result.lastErrorObject?.updatedExisting };
}

export async function findFacilityByCode(code) {
  const db = getDb();
  if (!db || !code) return null;

  return sanitizeFacility(await db.collection(COLLECTION_NAME).findOne({ code }));
}

export async function listFacilities({ category, activeOnly = false } = {}) {
  const db = getDb();
  if (!db) return [];

  const query = {};
  if (category) query.category = category;
  if (activeOnly) query.isActive = true;

  const docs = await db.collection(COLLECTION_NAME).find(query).sort({ category: 1, name: 1 }).toArray();
  return docs.map(sanitizeFacility);
}
