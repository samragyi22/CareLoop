import twilio from 'twilio';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { 
  findAppointmentById,
  acquireOutboundCallLock,
  commitOutboundCallLock,
  releaseOutboundCallLock 
} from '../repositories/appointment.repository.js';
import { findProviderById } from '../repositories/provider.repository.js';
import { 
  createVoiceCall, 
  findActiveOutboundCallForAppointment, 
  findVoiceCallBySid,
  findVoiceCallBySidRaw,
  maskPhoneNumber,
  linkTriggerAndCallbackCalls
} from '../repositories/voiceCall.repository.js';
import {
  acquireCallbackLock,
  commitCallbackLock,
  releaseCallbackLock
} from '../repositories/callbackLock.repository.js';
import {
  normalizeE164Phone,
  isPhoneEligibleForCallback
} from '../repositories/callbackConsent.repository.js';
import { 
  createUltravoxCallSession, 
  cancelUltravoxCallSession,
  isUltravoxConfigured 
} from './ultravox.service.js';
import { formatSpokenDateTime } from './agentTools.service.js';
import { isSyntheticPhone, isSyntheticAppointment } from '../utils/synthetic.js';

// Strict E.164 phone number pattern: + followed by 7 to 15 digits
const E164_REGEX = /^\+[1-9]\d{6,14}$/;


function isValidObjectId(id) {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-fA-F]{24}$/.test(id);
}

/**
 * Generates the identifier the voice agent's tools are bound to for an outbound call.
 * Twilio only assigns its CallSid after dialing, so the call record stores both.
 */
function generateAgentSessionId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Sanitizes external provider error messages to prevent credential leakage.
 */
function sanitizeProviderErrorMessage(rawMessage, providerName = 'Provider') {
  if (!rawMessage || typeof rawMessage !== 'string') {
    return `${providerName} rejected the call request.`;
  }
  let sanitized = rawMessage;
  if (env.TWILIO_AUTH_TOKEN) {
    sanitized = sanitized.replaceAll(env.TWILIO_AUTH_TOKEN, '[REDACTED]');
  }
  if (env.TWILIO_ACCOUNT_SID) {
    sanitized = sanitized.replaceAll(env.TWILIO_ACCOUNT_SID, '[REDACTED]');
  }
  if (env.ULTRAVOX_API_KEY) {
    sanitized = sanitized.replaceAll(env.ULTRAVOX_API_KEY, '[REDACTED]');
  }
  return sanitized;
}

/**
 * Initiates an outbound AI voice appointment reminder call through Twilio and Ultravox.
 * 
 * Hardened Features (Milestone M5.1):
 * - Concurrency safety via atomic MongoDB document-level reservation lock.
 * - Idempotency support (replaying with identical key returns existing call).
 * - Automatic recovery from stale/abandoned in-flight reservations.
 * - Immediate proactive cleanup of orphaned Ultravox sessions if Twilio dialing fails.
 * - Sanitized provider error reporting with zero credential exposure.
 */
export async function initiateOutboundReminderCall({
  appointmentId,
  phone = null,
  confirmed = false,
  idempotencyKey = null,
  isMock = false,
  mock = false
} = {}) {
  // 1. Explicit Staff Confirmation Requirement
  if (confirmed !== true && confirmed !== 'true') {
    const err = new Error('Explicit confirmation is required before placing an outbound reminder call.');
    err.statusCode = 400;
    err.code = 'CONFIRMATION_REQUIRED';
    throw err;
  }

  // 2. Validate Appointment ID
  if (!isValidObjectId(appointmentId)) {
    const err = new Error('A valid 24-character hexadecimal appointment ID is required.');
    err.statusCode = 400;
    err.code = 'INVALID_APPOINTMENT_ID';
    throw err;
  }

  // 3. Fetch and Validate Appointment Record
  const appointment = await findAppointmentById(appointmentId);
  if (!appointment) {
    const err = new Error('Appointment record not found.');
    err.statusCode = 404;
    err.code = 'APPOINTMENT_NOT_FOUND';
    throw err;
  }

  if (appointment.status !== 'confirmed') {
    const err = new Error(`Cannot place reminder call for appointment with status: "${appointment.status}". Only confirmed appointments can receive reminder calls.`);
    err.statusCode = 400;
    err.code = 'APPOINTMENT_NOT_ACTIVE';
    throw err;
  }

  // 4. Resolve and Validate Destination Phone
  const destinationPhone = (phone && typeof phone === 'string' && phone.trim()) 
    ? phone.trim() 
    : appointment.patient?.phone;

  if (!destinationPhone || !E164_REGEX.test(destinationPhone)) {
    const err = new Error('Destination phone number must be a valid E.164 phone number (e.g. +15551234567 or +919876543210).');
    err.statusCode = 400;
    err.code = 'INVALID_PHONE_NUMBER';
    throw err;
  }

  // 5. Idempotent Replay Handling
  if (idempotencyKey && typeof idempotencyKey === 'string') {
    const existingLock = appointment.outboundCallLock;
    if (existingLock && existingLock.idempotencyKey === idempotencyKey) {
      if (existingLock.callSid) {
        const existingCall = await findVoiceCallBySid(existingLock.callSid);
        if (existingCall) {
          console.log(`[Outbound Voice] Idempotent replay for key "${idempotencyKey}": Returning existing call ${existingLock.callSid}`);
          return {
            status: 'success',
            message: 'Outbound reminder call already placed (idempotent replay).',
            replayed: true,
            data: {
              callSid: existingCall.callSid,
              status: existingCall.status,
              direction: 'outbound',
              appointmentId: String(appointment._id),
              bookingReference: appointment.bookingReference,
              patientName: appointment.patient?.name,
              to: existingCall.to,
              isMock: Boolean(existingCall.isMock)
            }
          };
        }
      }
      if (existingLock.status === 'reserving' || existingLock.status === 'active') {
        const err = new Error(`An outbound call for appointment ${appointment.bookingReference} is already being processed with this idempotency key.`);
        err.statusCode = 409;
        err.code = 'CALL_ALREADY_IN_PROGRESS';
        throw err;
      }
    }
  }

  // 6. Concurrency-Safe Atomic Reservation Lock
  // Generates a unique reservation ID and attempts atomic document-level acquisition
  const reservationId = `RES-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const lockedAppointment = await acquireOutboundCallLock(appointment._id, {
    reservationId,
    idempotencyKey: idempotencyKey || null,
    phone: destinationPhone
  });

  if (!lockedAppointment) {
    // Check if an existing call record is active to provide helpful context
    const activeCall = await findActiveOutboundCallForAppointment(appointment._id);
    const existingStatus = activeCall?.status || appointment.outboundCallLock?.status || 'in-progress';
    const err = new Error(`An outbound call for appointment ${appointment.bookingReference} is already active or in progress (${existingStatus}). Duplicate call prevented.`);
    err.statusCode = 409;
    err.code = 'CALL_ALREADY_IN_PROGRESS';
    err.existingCallSid = activeCall?.callSid || appointment.outboundCallLock?.callSid || null;
    throw err;
  }

  // 7. Prepare Spoken Details for Reminder
  const provider = await findProviderById(appointment.providerId);
  const spokenTime = formatSpokenDateTime(appointment.startAt);

  const outboundReminderData = {
    patientName: appointment.patient?.name || 'Patient',
    providerName: provider?.name || 'Clinic Physician',
    specialty: provider?.specialty || 'General Practice',
    appointmentTime: spokenTime,
    bookingReference: appointment.bookingReference
  };

  // Synthetic patients are always simulated, whatever the request asked for
  const forceMock = isSyntheticAppointment(appointment) || isSyntheticPhone(destinationPhone);

  // --------------------------------------------------------------------------
  // MOCK MODE SIMULATION
  // --------------------------------------------------------------------------
  if (env.VOICE_MOCK_MODE || isMock || mock || forceMock) {
    const mockCallSid = `CA-MOCK-OUTBOUND-${Date.now()}`;
    console.log(`[Outbound Voice] Initiating simulated reminder call to ${maskPhoneNumber(destinationPhone)} (MOCK MODE ACTIVE)`);

    try {
      await createVoiceCall({
        callSid: mockCallSid,
        from: env.TWILIO_PHONE_NUMBER || '+15550000000',
        to: destinationPhone,
        direction: 'outbound',
        status: 'queued',
        appointmentId: String(appointment._id),
        bookingReference: appointment.bookingReference,
        ultravoxCallId: `mock-uv-${Date.now()}`,
        isMock: true
      });

      // Commit reservation in DB
      await commitOutboundCallLock(appointment._id, reservationId, {
        callSid: mockCallSid,
        status: 'queued'
      });

      return {
        status: 'success',
        message: 'Outbound voice reminder call initiated successfully (MOCK MODE).',
        data: {
          callSid: mockCallSid,
          status: 'queued',
          direction: 'outbound',
          appointmentId: String(appointment._id),
          bookingReference: appointment.bookingReference,
          patientName: appointment.patient?.name,
          to: maskPhoneNumber(destinationPhone),
          isMock: true
        }
      };
    } catch (mockErr) {
      await releaseOutboundCallLock(appointment._id, reservationId, {
        status: 'failed',
        error: mockErr.message
      });
      throw mockErr;
    }
  }

  // --------------------------------------------------------------------------
  // LIVE TELEPHONY & AI SESSION CREATION
  // --------------------------------------------------------------------------
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
    await releaseOutboundCallLock(appointment._id, reservationId, {
      status: 'failed',
      error: 'Twilio telephony credentials are not configured.'
    });
    const err = new Error('Twilio telephony credentials are not configured on this server.');
    err.statusCode = 503;
    err.code = 'TWILIO_UNCONFIGURED';
    throw err;
  }

  if (!isUltravoxConfigured()) {
    await releaseOutboundCallLock(appointment._id, reservationId, {
      status: 'failed',
      error: 'Ultravox AI credentials are not configured.'
    });
    const err = new Error('Ultravox AI credentials are not configured on this server.');
    err.statusCode = 503;
    err.code = 'ULTRAVOX_UNCONFIGURED';
    throw err;
  }

  const agentSessionId = generateAgentSessionId('AGENT-OUT');
  let ultravoxSession = null;

  // Step 1: Initialize Ultravox AI Voice Session (tools are bound to agentSessionId)
  try {
    ultravoxSession = await createUltravoxCallSession({
      callSid: agentSessionId,
      isOutbound: true,
      outboundReminderData
    });
  } catch (uvErr) {
    console.error(`[Outbound Voice] Ultravox session creation failed for appointment ${appointment.bookingReference}:`, uvErr.message);
    await releaseOutboundCallLock(appointment._id, reservationId, {
      status: 'failed',
      error: uvErr.message
    });
    const err = new Error(`Failed to initialize Ultravox AI voice session: ${sanitizeProviderErrorMessage(uvErr.message, 'Ultravox')}`);
    err.statusCode = uvErr.statusCode || 502;
    err.code = uvErr.code || 'ULTRAVOX_SESSION_FAILED';
    throw err;
  }

  // Step 2: Generate Twilio Media Stream TwiML connecting to Ultravox joinUrl
  const twimlResponse = new twilio.twiml.VoiceResponse();
  const connect = twimlResponse.connect();
  connect.stream({ url: ultravoxSession.joinUrl });

  // Step 3: Initiate Outbound Call via Twilio REST API
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  const statusCallbackUrl = env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/+$/, '')}/api/voice/status` : null;

  let twilioCall = null;
  try {
    twilioCall = await client.calls.create({
      to: destinationPhone,
      from: env.TWILIO_PHONE_NUMBER,
      twiml: twimlResponse.toString(),
      statusCallback: statusCallbackUrl,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    console.log(`[Outbound Voice] Twilio outbound call placed: ${twilioCall.sid} -> ${maskPhoneNumber(destinationPhone)} (Status: ${twilioCall.status})`);
  } catch (twErr) {
    console.error(`[Outbound Voice] Twilio call placement failed:`, twErr.message);

    // Proactively delete orphaned Ultravox session so it doesn't linger or consume credits
    if (ultravoxSession?.callId) {
      await cancelUltravoxCallSession(ultravoxSession.callId).catch(() => {});
    }

    // Release the appointment lock so future attempts are permitted
    await releaseOutboundCallLock(appointment._id, reservationId, {
      status: 'failed',
      error: twErr.message
    });

    const err = new Error(`Twilio outbound call placement failed: ${sanitizeProviderErrorMessage(twErr.message, 'Twilio')}`);
    err.statusCode = 502;
    err.code = 'TWILIO_CALL_FAILED';
    throw err;
  }

  // Step 4: Commit Lock & Record Call in Database
  try {
    await commitOutboundCallLock(appointment._id, reservationId, {
      callSid: twilioCall.sid,
      status: twilioCall.status || 'queued'
    });

    await createVoiceCall({
      callSid: twilioCall.sid,
      agentSessionId,
      from: env.TWILIO_PHONE_NUMBER,
      to: destinationPhone,
      direction: 'outbound',
      status: twilioCall.status || 'queued',
      appointmentId: String(appointment._id),
      bookingReference: appointment.bookingReference,
      ultravoxCallId: ultravoxSession.callId,
      joinUrl: ultravoxSession.joinUrl,
      isMock: false
    });
  } catch (dbErr) {
    console.warn(`[Outbound Voice] Notice: Could not record outbound call in DB:`, dbErr.message);
  }

  return {
    status: 'success',
    message: 'Outbound voice reminder call placed successfully.',
    data: {
      callSid: twilioCall.sid,
      status: twilioCall.status || 'queued',
      direction: 'outbound',
      appointmentId: String(appointment._id),
      bookingReference: appointment.bookingReference,
      patientName: appointment.patient?.name,
      to: maskPhoneNumber(destinationPhone),
      isMock: false
    }
  };
}

/**
 * Initiates an outbound missed-call callback using the CareLoop outbound voice engine.
 * 
 * Reuses the M5/M5.1 telephony engine and Ultravox AI session bridging with:
 * - Atomic per-phone concurrency reservation locks (protects against concurrent webhook races).
 * - Cooldown enforcement (configurable via VOICE_CALLBACK_COOLDOWN_SECONDS).
 * - Maximum attempts enforcement (configurable via VOICE_CALLBACK_MAX_ATTEMPTS per 24h).
 * - First-time consent and opt-out checking (VOICE_CALLBACK_REQUIRE_CONSENT).
 * - Idempotency support (replaying triggerCallSid returns existing call without duplicate dialing).
 * - Separate safe callback intent (does not fabricate fake appointments).
 * - Linking trigger CallSid and outbound callback CallSid.
 * - Proactive cleanup of orphaned Ultravox sessions and lock release on provider errors.
 * - Sanitized provider error messages with zero credential exposure.
 */
export async function initiateMissedCallCallback({
  phone,
  triggerCallSid,
  idempotencyKey = null,
  isMock = false,
  mock = false,
  clinicName = 'CareLoop Outpatient Clinic',
  requireConsent = env.VOICE_CALLBACK_REQUIRE_CONSENT
} = {}) {
  // 1. Validate destination phone number
  const destinationPhone = normalizeE164Phone(phone);
  if (!destinationPhone) {
    const err = new Error('Destination phone number must be a valid E.164 phone number (e.g. +15551234567 or +919876543210).');
    err.statusCode = 400;
    err.code = 'INVALID_PHONE_NUMBER';
    throw err;
  }

  // 2. Validate trigger CallSid
  if (!triggerCallSid || typeof triggerCallSid !== 'string') {
    const err = new Error('A valid inbound trigger CallSid is required to initiate a callback.');
    err.statusCode = 400;
    err.code = 'MISSING_TRIGGER_CALL_SID';
    throw err;
  }

  // 3. Consent check: Ensure patient has not opted out, and verify consent if required
  const consentCheck = await isPhoneEligibleForCallback(destinationPhone, { requireConsent });
  if (!consentCheck.eligible) {
    console.warn(`[Missed-Call Callback] Ineligible caller ${maskPhoneNumber(destinationPhone)}: ${consentCheck.reason} - ${consentCheck.message}`);
    const err = new Error(consentCheck.message);
    err.statusCode = consentCheck.reason === 'OPTED_OUT' ? 403 : 400;
    err.code = consentCheck.reason;
    throw err;
  }

  // 4. Concurrency Guard, Cooldown, and Attempt Limit verification via atomic callback lock
  const lockResult = await acquireCallbackLock(destinationPhone, {
    triggerCallSid,
    cooldownSeconds: env.VOICE_CALLBACK_COOLDOWN_SECONDS,
    maxAttempts: env.VOICE_CALLBACK_MAX_ATTEMPTS
  });

  if (!lockResult.success) {
    // 4a. Idempotent replay for same trigger CallSid
    if (lockResult.reason === 'TRIGGER_ALREADY_PROCESSED') {
      console.log(`[Missed-Call Callback] Idempotent replay for trigger ${triggerCallSid}: returning existing callback.`);
      const existingCall = lockResult.callbackCallSid ? await findVoiceCallBySid(lockResult.callbackCallSid) : null;
      return {
        status: 'success',
        message: 'Missed-call callback already placed for this trigger (idempotent replay).',
        replayed: true,
        data: {
          callSid: lockResult.callbackCallSid || existingCall?.callSid || null,
          status: existingCall?.status || 'queued',
          direction: 'outbound',
          callIntent: 'missed_call_callback',
          triggerCallSid,
          to: maskPhoneNumber(destinationPhone),
          isMock: Boolean(existingCall?.isMock)
        }
      };
    }

    // 4b. Cooldown violation
    if (lockResult.reason === 'COOLDOWN_ACTIVE') {
      const err = new Error(lockResult.message);
      err.statusCode = 429;
      err.code = 'COOLDOWN_ACTIVE';
      err.remainingSeconds = lockResult.remainingSeconds;
      throw err;
    }

    // 4c. Max daily attempts limit reached
    if (lockResult.reason === 'MAX_ATTEMPTS_EXCEEDED') {
      const err = new Error(lockResult.message);
      err.statusCode = 429;
      err.code = 'MAX_ATTEMPTS_EXCEEDED';
      err.attemptsCount = lockResult.attemptsCount;
      err.maxAttempts = lockResult.maxAttempts;
      throw err;
    }

    // 4d. Concurrent in-flight reservation
    if (lockResult.reason === 'CALLBACK_IN_PROGRESS') {
      const err = new Error(lockResult.message);
      err.statusCode = 409;
      err.code = 'CALLBACK_ALREADY_IN_PROGRESS';
      throw err;
    }

    const err = new Error(lockResult.message || 'Failed to acquire callback reservation lock.');
    err.statusCode = 400;
    err.code = lockResult.reason || 'LOCK_FAILED';
    throw err;
  }

  const reservationId = lockResult.lockId;

  // --------------------------------------------------------------------------
  // MOCK MODE SIMULATION (synthetic numbers are always simulated)
  // --------------------------------------------------------------------------
  if (env.VOICE_MOCK_MODE || isMock || mock || isSyntheticPhone(destinationPhone)) {
    const mockCallSid = `CA-MOCK-CALLBACK-${Date.now()}`;
    console.log(`[Missed-Call Callback] Initiating simulated callback to ${maskPhoneNumber(destinationPhone)} (MOCK MODE ACTIVE)`);

    try {
      await createVoiceCall({
        callSid: mockCallSid,
        from: env.TWILIO_PHONE_NUMBER || '+15550000000',
        to: destinationPhone,
        direction: 'outbound',
        status: 'queued',
        callIntent: 'missed_call_callback',
        triggerCallSid,
        ultravoxCallId: `mock-uv-cb-${Date.now()}`,
        isMock: true
      });

      await commitCallbackLock(reservationId, {
        callbackCallSid: mockCallSid,
        status: 'queued'
      });

      await linkTriggerAndCallbackCalls(triggerCallSid, mockCallSid);

      return {
        status: 'success',
        message: 'Missed-call callback initiated successfully (MOCK MODE).',
        data: {
          callSid: mockCallSid,
          status: 'queued',
          direction: 'outbound',
          callIntent: 'missed_call_callback',
          triggerCallSid,
          to: maskPhoneNumber(destinationPhone),
          isMock: true
        }
      };
    } catch (mockErr) {
      await releaseCallbackLock(reservationId, {
        status: 'failed',
        error: mockErr.message
      });
      throw mockErr;
    }
  }

  // --------------------------------------------------------------------------
  // LIVE TELEPHONY & AI SESSION CREATION
  // --------------------------------------------------------------------------
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
    await releaseCallbackLock(reservationId, {
      status: 'failed',
      error: 'Twilio telephony credentials are not configured.'
    });
    const err = new Error('Twilio telephony credentials are not configured on this server.');
    err.statusCode = 503;
    err.code = 'TWILIO_UNCONFIGURED';
    throw err;
  }

  if (!isUltravoxConfigured()) {
    await releaseCallbackLock(reservationId, {
      status: 'failed',
      error: 'Ultravox AI credentials are not configured.'
    });
    const err = new Error('Ultravox AI credentials are not configured on this server.');
    err.statusCode = 503;
    err.code = 'ULTRAVOX_UNCONFIGURED';
    throw err;
  }

  const agentSessionId = generateAgentSessionId('AGENT-CB');
  let ultravoxSession = null;

  // Step 1: Initialize Ultravox AI Callback Voice Session (tools are bound to agentSessionId)
  try {
    ultravoxSession = await createUltravoxCallSession({
      callSid: agentSessionId,
      isCallback: true,
      callbackData: {
        clinicName,
        region: env.DEPLOYMENT_REGION
      }
    });
  } catch (uvErr) {
    console.error(`[Missed-Call Callback] Ultravox callback session creation failed:`, uvErr.message);
    await releaseCallbackLock(reservationId, {
      status: 'failed',
      error: uvErr.message
    });
    const err = new Error(`Failed to initialize Ultravox AI callback session: ${sanitizeProviderErrorMessage(uvErr.message, 'Ultravox')}`);
    err.statusCode = uvErr.statusCode || 502;
    err.code = uvErr.code || 'ULTRAVOX_SESSION_FAILED';
    throw err;
  }

  // Step 2: Generate Twilio Media Stream TwiML connecting to Ultravox joinUrl
  const twimlResponse = new twilio.twiml.VoiceResponse();
  const connect = twimlResponse.connect();
  connect.stream({ url: ultravoxSession.joinUrl });

  // Step 3: Initiate Outbound Call via Twilio REST API
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  const statusCallbackUrl = env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/+$/, '')}/api/voice/status` : null;

  let twilioCall = null;
  try {
    twilioCall = await client.calls.create({
      to: destinationPhone,
      from: env.TWILIO_PHONE_NUMBER,
      twiml: twimlResponse.toString(),
      statusCallback: statusCallbackUrl,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    console.log(`[Missed-Call Callback] Twilio callback placed: ${twilioCall.sid} -> ${maskPhoneNumber(destinationPhone)} (Status: ${twilioCall.status})`);
  } catch (twErr) {
    console.error(`[Missed-Call Callback] Twilio call placement failed:`, twErr.message);

    // Proactively delete orphaned Ultravox session
    if (ultravoxSession?.callId) {
      await cancelUltravoxCallSession(ultravoxSession.callId).catch(() => {});
    }

    // Release callback lock so subsequent attempts are permitted
    await releaseCallbackLock(reservationId, {
      status: 'failed',
      error: twErr.message
    });

    const err = new Error(`Twilio outbound callback placement failed: ${sanitizeProviderErrorMessage(twErr.message, 'Twilio')}`);
    err.statusCode = 502;
    err.code = 'TWILIO_CALL_FAILED';
    throw err;
  }

  // Step 4: Commit Lock & Record Call in Database
  try {
    await commitCallbackLock(reservationId, {
      callbackCallSid: twilioCall.sid,
      status: twilioCall.status || 'queued'
    });

    await createVoiceCall({
      callSid: twilioCall.sid,
      agentSessionId,
      from: env.TWILIO_PHONE_NUMBER,
      to: destinationPhone,
      direction: 'outbound',
      status: twilioCall.status || 'queued',
      callIntent: 'missed_call_callback',
      triggerCallSid,
      ultravoxCallId: ultravoxSession.callId,
      joinUrl: ultravoxSession.joinUrl,
      isMock: false
    });

    await linkTriggerAndCallbackCalls(triggerCallSid, twilioCall.sid);
  } catch (dbErr) {
    console.warn(`[Missed-Call Callback] Notice: Could not record callback call in DB:`, dbErr.message);
  }

  return {
    status: 'success',
    message: 'Missed-call callback placed successfully.',
    data: {
      callSid: twilioCall.sid,
      status: twilioCall.status || 'queued',
      direction: 'outbound',
      callIntent: 'missed_call_callback',
      triggerCallSid,
      to: maskPhoneNumber(destinationPhone),
      isMock: false
    }
  };
}

/**
 * Retries a failed, unanswered, or busy missed-call callback according to a bounded safe retry policy.
 * 
 * Safety invariants:
 * 1. Validates previous callback existence.
 * 2. Strictly prohibits retrying already successful callbacks ('completed').
 * 3. Strictly prohibits retrying active in-flight calls ('reserving', 'queued', 'initiated', 'ringing', 'in-progress').
 * 4. Re-checks current consent status (blocks if caller opted out or declined).
 * 5. Strictly enforces atomic cooldown and 24h daily attempt limits.
 * 6. Generates deterministic retry trigger identifier for idempotency.
 * 7. Sanitizes all error messages.
 */
export async function retryMissedCallCallback({
  callbackCallSid,
  clinicianInitiated = false,
  isMock = false,
  mock = false
} = {}) {
  if (!callbackCallSid || typeof callbackCallSid !== 'string') {
    const err = new Error('A valid callback CallSid is required to initiate a retry.');
    err.statusCode = 400;
    err.code = 'INVALID_CALLBACK_CALL_SID';
    throw err;
  }

  const existingCall = await findVoiceCallBySid(callbackCallSid);
  if (!existingCall) {
    const err = new Error(`Callback record "${callbackCallSid}" not found.`);
    err.statusCode = 404;
    err.code = 'CALLBACK_NOT_FOUND';
    throw err;
  }

  // 1. Prohibit retrying already completed callbacks
  if (existingCall.status === 'completed') {
    const err = new Error(`Callback ${callbackCallSid} has already completed successfully. Retrying is prohibited.`);
    err.statusCode = 409;
    err.code = 'ALREADY_COMPLETED';
    throw err;
  }

  // 2. Prohibit retrying in-flight callbacks
  const IN_FLIGHT_STATUSES = ['reserving', 'queued', 'initiated', 'ringing', 'in-progress'];
  if (IN_FLIGHT_STATUSES.includes(existingCall.status)) {
    const err = new Error(`Callback ${callbackCallSid} is currently in progress (${existingCall.status}). Duplicate call prevented.`);
    err.statusCode = 409;
    err.code = 'CALL_IN_PROGRESS';
    throw err;
  }

  // Raw destination phone
  const rawCall = await findVoiceCallBySidRaw(callbackCallSid);
  const destinationPhone = normalizeE164Phone(rawCall?.to || existingCall.to);
  if (!destinationPhone) {
    const err = new Error('Cannot resolve destination phone number for retry.');
    err.statusCode = 400;
    err.code = 'INVALID_PHONE_NUMBER';
    throw err;
  }

  // 3. Re-verify consent
  const consentCheck = await isPhoneEligibleForCallback(destinationPhone, {
    requireConsent: env.VOICE_CALLBACK_REQUIRE_CONSENT
  });

  if (!consentCheck.eligible) {
    const err = new Error(consentCheck.message || 'Phone number is ineligible for callback retry.');
    err.statusCode = consentCheck.reason === 'OPTED_OUT' ? 403 : 400;
    err.code = consentCheck.reason;
    throw err;
  }

  // 4. Initiate retry using new trigger identifier linked to previous CallSid
  const retryTriggerSid = `RETRY-${callbackCallSid}-${Date.now()}`;
  const shouldMock = typeof isMock === 'boolean' ? isMock : (Boolean(mock) || Boolean(existingCall.isMock));

  console.log(`[Callback Retry] Initiating safe retry for ${maskPhoneNumber(destinationPhone)} (previous: ${callbackCallSid}, clinicianInitiated: ${clinicianInitiated})`);

  return initiateMissedCallCallback({
    phone: destinationPhone,
    triggerCallSid: retryTriggerSid,
    isMock: shouldMock,
    requireConsent: env.VOICE_CALLBACK_REQUIRE_CONSENT
  });
}


