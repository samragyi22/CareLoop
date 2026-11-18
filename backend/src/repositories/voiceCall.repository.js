import { ObjectId } from 'mongodb';
import { getDb } from '../config/db.js';
import { updateOutboundCallLockByCallSid } from './appointment.repository.js';

const COLLECTION_NAME = 'voice_calls';

/**
 * Masks a phone number as an application-level privacy safeguard.
 * Example: "+15551234567" -> "+1 (555) ***-4567"
 */
export function maskPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return 'Anonymous / Unknown';
  const clean = phone.trim();
  if (clean.length <= 4) return '***';
  const lastFour = clean.slice(-4);
  const prefix = clean.slice(0, Math.max(0, clean.length - 7));
  return `${prefix}***-${lastFour}`;
}

export function sanitizeVoiceCall(doc) {
  if (!doc) return null;
  return {
    _id: String(doc._id),
    callSid: doc.callSid,
    from: maskPhoneNumber(doc.from),
    to: doc.to ? maskPhoneNumber(doc.to) : 'CareLoop Main Line',
    direction: doc.direction || 'inbound',
    status: doc.status || 'initiated',
    appointmentId: doc.appointmentId ? String(doc.appointmentId) : null,
    bookingReference: doc.bookingReference || null,
    callIntent: doc.callIntent || null,
    triggerCallSid: doc.triggerCallSid || null,
    callbackCallSid: doc.callbackCallSid || null,
    triggerForCallback: Boolean(doc.triggerForCallback),
    ultravoxCallId: doc.ultravoxCallId || null,
    durationSeconds: typeof doc.durationSeconds === 'number' ? doc.durationSeconds : 0,
    isMock: Boolean(doc.isMock),
    errorNote: doc.errorNote || null,
    toolEvents: Array.isArray(doc.toolEvents) ? doc.toolEvents : [],
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
    endedAt: doc.endedAt instanceof Date ? doc.endedAt.toISOString() : doc.endedAt || null
  };
}

export async function initVoiceCallIndexes() {
  const db = getDb();
  if (!db) return;

  const collection = db.collection(COLLECTION_NAME);
  await collection.createIndex({ callSid: 1 }, { unique: true });
  await collection.createIndex({ agentSessionId: 1 });
  await collection.createIndex({ createdAt: -1 });
  await collection.createIndex({ status: 1 });
  await collection.createIndex({ appointmentId: 1, direction: 1, status: 1 });
  await collection.createIndex({ triggerCallSid: 1 });
}

/**
 * Creates a voice call record.
 *
 * `agentSessionId` is the identifier the voice agent's tools are bound to. For inbound calls it
 * equals Twilio's CallSid. For outbound calls the agent session is created before Twilio assigns
 * a CallSid, so the two differ and both are stored to keep tool events and cleanup linked.
 */
export async function createVoiceCall({
  callSid,
  agentSessionId = null,
  from,
  to,
  direction = 'inbound',
  status = 'initiated',
  appointmentId = null,
  bookingReference = null,
  callIntent = null,
  triggerCallSid = null,
  callbackCallSid = null,
  triggerForCallback = false,
  ultravoxCallId = null,
  joinUrl = null,
  durationSeconds = 0,
  errorNote = null,
  isMock = false,
  planpilot = null
}) {
  const db = getDb();
  if (!db) return null;

  const now = new Date();
  const doc = {
    callSid,
    agentSessionId: agentSessionId || callSid,
    from: from || 'Unknown',
    to: to || 'CareLoop Clinic',
    direction,
    status,
    appointmentId: appointmentId ? String(appointmentId) : null,
    bookingReference: bookingReference || null,
    callIntent: callIntent || null,
    triggerCallSid: triggerCallSid || null,
    callbackCallSid: callbackCallSid || null,
    triggerForCallback: Boolean(triggerForCallback),
    ultravoxCallId,
    joinUrl, // internal, not returned in sanitized output
    durationSeconds: typeof durationSeconds === 'number' ? durationSeconds : 0,
    errorNote: errorNote || null,
    isMock: Boolean(isMock),
    // PlanPilot care calls: which patient (and waiting option) the call is about, as plain strings
    planpilot: planpilot || null,
    createdAt: now,
    updatedAt: now
  };

  const result = await db.collection(COLLECTION_NAME).insertOne(doc);
  return sanitizeVoiceCall({ _id: result.insertedId, ...doc });
}

/**
 * Links a trigger call record with its corresponding callback call record.
 */
export async function linkTriggerAndCallbackCalls(triggerCallSid, callbackCallSid) {
  const db = getDb();
  if (!db || !triggerCallSid || !callbackCallSid) return null;

  await db.collection(COLLECTION_NAME).updateOne(
    { callSid: triggerCallSid },
    { $set: { callbackCallSid, updatedAt: new Date() } }
  );

  await db.collection(COLLECTION_NAME).updateOne(
    { callSid: callbackCallSid },
    { $set: { triggerCallSid, updatedAt: new Date() } }
  );
}


/**
 * Finds an active outbound call for a given appointment to prevent duplicate calls.
 */
export async function findActiveOutboundCallForAppointment(appointmentId) {
  const db = getDb();
  if (!db || !appointmentId) return null;

  const doc = await db.collection(COLLECTION_NAME).findOne({
    appointmentId: String(appointmentId),
    direction: 'outbound',
    status: { $in: ['queued', 'initiated', 'ringing', 'in-progress'] }
  });

  return sanitizeVoiceCall(doc);
}

/**
 * Gets the most recent outbound call for an appointment to determine reminder status.
 */
export async function getLatestOutboundCallForAppointment(appointmentId) {
  const db = getDb();
  if (!db || !appointmentId) return null;

  const docs = await db.collection(COLLECTION_NAME)
    .find({
      appointmentId: String(appointmentId),
      direction: 'outbound'
    })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  return docs.length > 0 ? sanitizeVoiceCall(docs[0]) : null;
}

const TERMINAL_STATUSES = ['completed', 'failed', 'canceled', 'busy', 'no-answer'];

export async function updateVoiceCallStatus(callSid, status, { durationSeconds = null, errorNote = null } = {}) {
  const db = getDb();
  if (!db || !callSid) return null;

  const now = new Date();
  const isNewStatusTerminal = TERMINAL_STATUSES.includes(status);

  // 1. Fetch current call record
  const currentCall = await db.collection(COLLECTION_NAME).findOne({ callSid });
  if (!currentCall) return null;

  // 2. Terminal state preservation:
  // If the call is already in a terminal state, DO NOT regress it to a non-terminal state
  // (e.g. out-of-order 'ringing' or 'in-progress' callbacks).
  const isCurrentTerminal = TERMINAL_STATUSES.includes(currentCall.status);
  if (isCurrentTerminal && !isNewStatusTerminal) {
    console.log(`[VoiceCall] Ignored out-of-order non-terminal callback for ${callSid}: "${status}" (call already terminal: "${currentCall.status}")`);
    return sanitizeVoiceCall(currentCall);
  }

  const updates = {
    updatedAt: now
  };

  // Only update status if not regressing a terminal call
  if (!isCurrentTerminal || isNewStatusTerminal) {
    updates.status = status;
  }

  // Ensure duration is monotonically non-decreasing
  if (typeof durationSeconds === 'number') {
    const prevDuration = typeof currentCall.durationSeconds === 'number' ? currentCall.durationSeconds : 0;
    updates.durationSeconds = Math.max(prevDuration, durationSeconds);
  }

  if (isNewStatusTerminal && !currentCall.endedAt) {
    updates.endedAt = now;
  }
  if (errorNote) {
    updates.errorNote = errorNote;
  }

  const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
    { callSid },
    { $set: updates },
    { returnDocument: 'after' }
  );

  // Synchronize appointment outboundCallLock when terminal status is reached
  if (isNewStatusTerminal && currentCall.appointmentId) {
    await updateOutboundCallLockByCallSid(callSid, status).catch(err => {
      console.warn(`[VoiceCall] Notice: Could not sync appointment lock for ${callSid}:`, err.message);
    });
  }

  return sanitizeVoiceCall(result);
}

export async function findVoiceCallBySid(callSid) {
  const db = getDb();
  if (!db || !callSid) return null;

  const doc = await db.collection(COLLECTION_NAME).findOne({ callSid });
  return sanitizeVoiceCall(doc);
}

/**
 * Returns the raw database document for a voice call, including internal fields
 * such as joinUrl that are stripped from the public sanitized output.
 * Use only for internal server-side logic (e.g. webhook idempotency replay).
 */
export async function findVoiceCallBySidRaw(callSid) {
  const db = getDb();
  if (!db || !callSid) return null;

  return db.collection(COLLECTION_NAME).findOne({ callSid });
}

/**
 * Finds the raw call record for an agent session ID or a Twilio CallSid.
 */
export async function findVoiceCallBySession(sessionId) {
  const db = getDb();
  if (!db || !sessionId) return null;

  return db.collection(COLLECTION_NAME).findOne({
    $or: [{ agentSessionId: sessionId }, { callSid: sessionId }]
  });
}

/**
 * Recent outbound calls to a phone number, newest first (used to detect an unreachable patient).
 */
export async function listRecentOutboundCallsTo(phone, { since, limit = 5 } = {}) {
  const db = getDb();
  if (!db || !phone) return [];

  const query = { direction: 'outbound', to: phone };
  if (since) query.createdAt = { $gte: since };

  const docs = await db.collection(COLLECTION_NAME).find(query).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map(sanitizeVoiceCall);
}

export async function listRecentVoiceCalls({ limit = 30 } = {}) {
  const db = getDb();
  if (!db) return [];

  const docs = await db.collection(COLLECTION_NAME)
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  return docs.map(sanitizeVoiceCall);
}

/**
 * Appends an audited tool execution event to the call record.
 * Accepts either the agent session ID the tool was bound to or the Twilio CallSid.
 */
export async function recordVoiceCallToolEvent(sessionId, toolEvent) {
  const db = getDb();
  if (!db || !sessionId) return null;

  const eventEntry = {
    toolName: toolEvent.toolName,
    action: toolEvent.action || null,
    status: toolEvent.status || 'success',
    bookingReference: toolEvent.bookingReference || null,
    summary: toolEvent.summary || null,
    timestamp: new Date()
  };

  const result = await db.collection(COLLECTION_NAME).updateOne(
    { $or: [{ agentSessionId: sessionId }, { callSid: sessionId }] },
    {
      $push: { toolEvents: eventEntry },
      $set: { updatedAt: new Date() }
    }
  );

  if (result.matchedCount === 0) {
    console.warn(`[VoiceCall] Tool event "${eventEntry.toolName}" has no matching call record for session ${sessionId}.`);
  }

  return eventEntry;
}

const LIVE_CALL_STATUSES = ['queued', 'initiated', 'ringing', 'in-progress'];

/**
 * Real (non-simulated) calls with this phone that the database still shows as live.
 */
export async function listLiveCallsWith(phone, { staleMs = 30 * 60 * 1000 } = {}) {
  const db = getDb();
  if (!db || !phone) return [];
  return db.collection(COLLECTION_NAME).find({
    $or: [{ to: phone }, { from: phone }],
    status: { $in: LIVE_CALL_STATUSES },
    isMock: { $ne: true },
    createdAt: { $gte: new Date(Date.now() - staleMs) }
  }).toArray();
}

/**
 * True if this phone is on a call with the clinic right now, or PlanPilot called it in the last
 * `recentMs` (so automation never rings a patient twice in a row or mid-conversation).
 */
export async function hasActiveOrRecentCallWith(phone, { recentMs = 3 * 60 * 1000, staleMs = 30 * 60 * 1000 } = {}) {
  const db = getDb();
  if (!db || !phone) return false;

  const now = Date.now();
  // Simulated calls never receive status updates (they stay "queued"), so only real calls count as live
  const active = await db.collection(COLLECTION_NAME).findOne({
    $or: [{ to: phone }, { from: phone }],
    status: { $in: LIVE_CALL_STATUSES },
    isMock: { $ne: true },
    createdAt: { $gte: new Date(now - staleMs) }
  });
  if (active) return true;

  if (!recentMs) return false;
  const recentCareCall = await db.collection(COLLECTION_NAME).findOne({
    to: phone,
    callIntent: 'planpilot_care',
    createdAt: { $gte: new Date(now - recentMs) }
  });
  return Boolean(recentCareCall);
}
