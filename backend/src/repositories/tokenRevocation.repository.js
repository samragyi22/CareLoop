import crypto from 'crypto';
import { getDb } from '../config/db.js';

const COLLECTION_NAME = 'revoked_tokens';

/**
 * Hashes a JWT string with SHA-256 so raw tokens and secrets are never stored in the database.
 */
export function hashToken(token) {
  if (!token || typeof token !== 'string') return null;
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Initializes MongoDB indexes for token revocation, including a TTL index
 * for automatic server-side cleanup once a token expires naturally.
 */
export async function initTokenRevocationIndexes() {
  const db = getDb();
  if (!db) {
    console.warn('[TokenRevocation] Database not connected. Cannot initialize indexes.');
    return;
  }

  const collection = db.collection(COLLECTION_NAME);

  // 1. Unique index on tokenHash to prevent duplicate records
  await collection.createIndex({ tokenHash: 1 }, { unique: true });

  // 2. TTL index: automatically purges documents when expiresAt timestamp has passed
  await collection.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'revoked_token_ttl' }
  );
}

/**
 * Records a token as revoked on the server.
 */
export async function revokeToken(token, { userId = null, expiresAt = null, reason = 'logout' } = {}) {
  const db = getDb();
  if (!db) {
    throw new Error('Database not connected. Cannot revoke token.');
  }

  const tokenHash = hashToken(token);
  if (!tokenHash) return false;

  const now = new Date();
  let expiryDate;

  if (expiresAt instanceof Date) {
    expiryDate = expiresAt;
  } else if (typeof expiresAt === 'number') {
    expiryDate = new Date(expiresAt * 1000);
  } else {
    // Default fallback: 24 hours from now
    expiryDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }

  try {
    await db.collection(COLLECTION_NAME).updateOne(
      { tokenHash },
      {
        $setOnInsert: {
          tokenHash,
          userId: userId ? String(userId) : null,
          reason,
          revokedAt: now,
          expiresAt: expiryDate
        }
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.warn('[TokenRevocation] Error recording revoked token:', err.message);
    return false;
  }
}

let _simulateFailure = false;

export function setSimulateRevocationFailure(flag) {
  _simulateFailure = Boolean(flag);
}

/**
 * Checks whether a given token has been revoked on the server.
 */
export async function isTokenRevoked(token) {
  if (_simulateFailure) {
    throw new Error('Revocation store connection timeout (simulated for resilience testing).');
  }

  const db = getDb();
  if (!db) {
    throw new Error('Database not connected. Revocation check unavailable.');
  }

  const tokenHash = hashToken(token);
  if (!tokenHash) return false;

  const doc = await db.collection(COLLECTION_NAME).findOne({ tokenHash });
  return Boolean(doc);
}

