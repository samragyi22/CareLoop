import { getDb } from '../config/db.js';
import { maskPhoneNumber } from './voiceCall.repository.js';

const COLLECTION_NAME = 'callback_consents';
const CURRENT_POLICY_VERSION = '1.0';
const DEFAULT_CONSENT_MAX_AGE_DAYS = 365;

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

// Deterministic Consent States
export const CONSENT_STATES = {
  PENDING: 'pending',
  CONSENTED: 'consented',
  DECLINED: 'declined',
  OPTED_OUT: 'opted_out',
  EXPIRED: 'expired'
};

export async function initCallbackConsentIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ phone: 1 }, { unique: true });
  await collection.createIndex({ consentStatus: 1 });
  await collection.createIndex({ updatedAt: -1 });
  await collection.createIndex({ consentPolicyVersion: 1 });
}

/**
 * Normalizes phone number to strict E.164 format.
 * Returns null if invalid.
 */
export function normalizeE164Phone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const clean = phone.trim().replace(/[\s\-\(\)]/g, '');
  if (!E164_REGEX.test(clean)) return null;
  return clean;
}

/**
 * Retrieves the consent record for a phone number.
 */
export async function getConsentRecord(phone) {
  const db = getDb();
  const normalized = normalizeE164Phone(phone);
  if (!db || !normalized) return null;

  return db.collection(COLLECTION_NAME).findOne({ phone: normalized });
}

/**
 * Explicitly grants patient consent for automated phone callbacks.
 * Enforces affirmative consent, records policy version, source, and prevents stale overwrite.
 */
export async function grantCallbackConsent(phone, {
  source = 'patient_portal',
  notes = null,
  policyVersion = CURRENT_POLICY_VERSION,
  requestedAt = new Date()
} = {}) {
  const db = getDb();
  const normalized = normalizeE164Phone(phone);
  if (!db) throw new Error('Database connection unavailable.');
  if (!normalized) {
    const err = new Error('Invalid E.164 phone number.');
    err.code = 'INVALID_PHONE_NUMBER';
    err.statusCode = 400;
    throw err;
  }

  const collection = db.collection(COLLECTION_NAME);
  const existing = await collection.findOne({ phone: normalized });

  // Stale update protection: prevent older requests from overwriting newer consent records
  if (existing && existing.updatedAt && new Date(existing.updatedAt).getTime() > new Date(requestedAt).getTime()) {
    console.warn(`[Callback Consent] Stale consent update rejected for ${maskPhoneNumber(normalized)} (existing: ${existing.updatedAt.toISOString()}, requested: ${new Date(requestedAt).toISOString()})`);
    const err = new Error('Stale consent update rejected: a newer consent record already exists.');
    err.code = 'STALE_CONSENT_UPDATE';
    err.statusCode = 409;
    throw err;
  }

  const now = new Date();
  const updateDoc = {
    phone: normalized,
    consentStatus: CONSENT_STATES.CONSENTED,
    consentSource: source,
    consentPolicyVersion: policyVersion,
    consentGrantedAt: now,
    declinedAt: null,
    declineReason: null,
    optedOutAt: null,
    optOutReason: null,
    notes: notes || null,
    updatedAt: now
  };

  const result = await collection.findOneAndUpdate(
    { phone: normalized },
    { 
      $set: updateDoc,
      $setOnInsert: { createdAt: now }
    },
    { upsert: true, returnDocument: 'after' }
  );

  console.log(`[Callback Consent] Granted consent for ${maskPhoneNumber(normalized)} (source: ${source}, policy: v${policyVersion})`);
  return result;
}

/**
 * Records explicit decline of automated callbacks (e.g. basic-phone IVR digit '2').
 * Blocks callback placement without marking a permanent opt-out.
 */
export async function declineCallbackConsent(phone, {
  source = 'ivr_phone_gather',
  reason = 'Caller declined callback via IVR',
  policyVersion = CURRENT_POLICY_VERSION,
  requestedAt = new Date()
} = {}) {
  const db = getDb();
  const normalized = normalizeE164Phone(phone);
  if (!db) throw new Error('Database connection unavailable.');
  if (!normalized) {
    const err = new Error('Invalid E.164 phone number.');
    err.code = 'INVALID_PHONE_NUMBER';
    err.statusCode = 400;
    throw err;
  }

  const collection = db.collection(COLLECTION_NAME);
  const existing = await collection.findOne({ phone: normalized });

  // Stale update protection
  if (existing && existing.updatedAt && new Date(existing.updatedAt).getTime() > new Date(requestedAt).getTime()) {
    const err = new Error('Stale decline update rejected.');
    err.code = 'STALE_CONSENT_UPDATE';
    err.statusCode = 409;
    throw err;
  }

  const now = new Date();
  const updateDoc = {
    phone: normalized,
    consentStatus: CONSENT_STATES.DECLINED,
    consentSource: source,
    consentPolicyVersion: policyVersion,
    declinedAt: now,
    declineReason: reason,
    updatedAt: now
  };

  const result = await collection.findOneAndUpdate(
    { phone: normalized },
    { 
      $set: updateDoc,
      $setOnInsert: { createdAt: now, consentGrantedAt: null, optedOutAt: null }
    },
    { upsert: true, returnDocument: 'after' }
  );

  console.log(`[Callback Consent] Recorded decline for ${maskPhoneNumber(normalized)} (source: ${source}, reason: ${reason})`);
  return result;
}

/**
 * Opts out a phone number from receiving automated callbacks.
 * Strict terminal user preference: prevents automated callbacks until explicitly renewed.
 */
export async function optOutCallbackConsent(phone, {
  reason = 'Patient opted out',
  source = 'patient_portal',
  policyVersion = CURRENT_POLICY_VERSION,
  notes = null,
  requestedAt = new Date()
} = {}) {
  const db = getDb();
  const normalized = normalizeE164Phone(phone);
  if (!db) throw new Error('Database connection unavailable.');
  if (!normalized) {
    const err = new Error('Invalid E.164 phone number.');
    err.code = 'INVALID_PHONE_NUMBER';
    err.statusCode = 400;
    throw err;
  }

  const collection = db.collection(COLLECTION_NAME);
  const existing = await collection.findOne({ phone: normalized });

  // Stale update protection
  if (existing && existing.updatedAt && new Date(existing.updatedAt).getTime() > new Date(requestedAt).getTime()) {
    const err = new Error('Stale opt-out update rejected.');
    err.code = 'STALE_CONSENT_UPDATE';
    err.statusCode = 409;
    throw err;
  }

  const now = new Date();
  const updateDoc = {
    phone: normalized,
    consentStatus: CONSENT_STATES.OPTED_OUT,
    consentSource: source,
    consentPolicyVersion: policyVersion,
    optedOutAt: now,
    optOutReason: reason,
    notes: notes || null,
    updatedAt: now
  };

  const result = await collection.findOneAndUpdate(
    { phone: normalized },
    { 
      $set: updateDoc,
      $setOnInsert: { createdAt: now, consentGrantedAt: null }
    },
    { upsert: true, returnDocument: 'after' }
  );

  console.log(`[Callback Consent] Opted out ${maskPhoneNumber(normalized)} (reason: ${reason})`);
  return result;
}

/**
 * Evaluates whether a phone number is eligible for an automated callback based on consent policy.
 * Validates state transitions, explicit affirmative consent, decline, opt-out, and expiration.
 */
export async function isPhoneEligibleForCallback(phone, {
  requireConsent = true,
  maxAgeDays = DEFAULT_CONSENT_MAX_AGE_DAYS
} = {}) {
  const normalized = normalizeE164Phone(phone);
  if (!normalized) {
    return {
      eligible: false,
      reason: 'INVALID_PHONE_NUMBER',
      message: 'Caller phone number is not a valid E.164 number.'
    };
  }

  const record = await getConsentRecord(normalized);

  // 1. Explicit opt-out strictly blocks callbacks
  if (record && record.consentStatus === CONSENT_STATES.OPTED_OUT) {
    return {
      eligible: false,
      reason: 'OPTED_OUT',
      status: CONSENT_STATES.OPTED_OUT,
      source: record.consentSource || null,
      message: 'Caller has explicitly opted out of automated voice callbacks.'
    };
  }

  // 2. Explicit decline blocks callbacks
  if (record && record.consentStatus === CONSENT_STATES.DECLINED) {
    return {
      eligible: false,
      reason: 'DECLINED',
      status: CONSENT_STATES.DECLINED,
      source: record.consentSource || null,
      message: 'Caller has declined automated callbacks for this phone number.'
    };
  }

  // 3. Expiration check for granted consent
  if (record && record.consentStatus === CONSENT_STATES.CONSENTED) {
    if (record.consentGrantedAt) {
      const ageMs = Date.now() - new Date(record.consentGrantedAt).getTime();
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
      if (ageMs > maxAgeMs) {
        return {
          eligible: false,
          reason: 'CONSENT_EXPIRED',
          status: CONSENT_STATES.EXPIRED,
          source: record.consentSource || null,
          message: `Callback consent has expired after ${maxAgeDays} days. Prior consent must be renewed.`
        };
      }
    }

    return {
      eligible: true,
      status: CONSENT_STATES.CONSENTED,
      source: record.consentSource || 'patient_portal',
      policyVersion: record.consentPolicyVersion || CURRENT_POLICY_VERSION
    };
  }

  // 4. Prior affirmative consent required by policy
  if (requireConsent) {
    return {
      eligible: false,
      reason: 'CONSENT_REQUIRED',
      status: record ? record.consentStatus : CONSENT_STATES.PENDING,
      message: 'Prior affirmative consent is required before placing automated callbacks.'
    };
  }

  return {
    eligible: true,
    status: record ? record.consentStatus : 'permitted_by_policy'
  };
}
