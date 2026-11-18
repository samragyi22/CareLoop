import { Router } from 'express';
import { handleGetMyCarePlan, handleRespondToCareOption, handleReportCareProblem } from '../services/careVoiceTools.service.js';
import { placeCarePlanCall, placeHealthCheckCall } from '../services/careCall.service.js';
import { handleCheckSymptoms, handleBookTriageAppointment } from '../services/healthCheckVoiceTools.service.js';
import { noteUnfinishedHealthCall } from '../services/symptomCheck.service.js';
import twilio from 'twilio';
import { env } from '../config/env.js';
import { verifyTwilioWebhook } from '../middleware/twilioAuth.middleware.js';
import { requireClinician } from '../middleware/auth.middleware.js';
import { getEmergencyGuidance } from '../config/emergency.js';
import {
  createUltravoxCallSession,
  isUltravoxConfigured
} from '../services/ultravox.service.js';
import {
  createVoiceCall,
  updateVoiceCallStatus,
  listRecentVoiceCalls,
  maskPhoneNumber,
  recordVoiceCallToolEvent,
  findVoiceCallBySidRaw,
  findVoiceCallBySession
} from '../repositories/voiceCall.repository.js';
import { isSyntheticPhone } from '../utils/synthetic.js';
import { requireToolAuth } from '../services/toolSecurity.service.js';
import { cancelActiveConfirmation } from '../services/confirmation.service.js';
import {
  handleFindProviders,
  handleGetAvailableSlots,
  handleGetAppointmentStatus,
  handlePrepareBooking,
  handleConfirmBooking,
  handlePrepareCancellation,
  handleConfirmCancellation,
  handlePrepareReschedule,
  handleConfirmReschedule
} from '../services/agentTools.service.js';
import { 
  initiateOutboundReminderCall,
  initiateMissedCallCallback,
  retryMissedCallCallback
} from '../services/outboundVoice.service.js';
import {
  normalizeE164Phone,
  isPhoneEligibleForCallback,
  grantCallbackConsent,
  declineCallbackConsent,
  optOutCallbackConsent,
  getConsentRecord
} from '../repositories/callbackConsent.repository.js';
import { updateCallbackLockStatus } from '../repositories/callbackLock.repository.js';

export const voiceRouter = Router();

/**
 * POST /api/voice/inbound
 * Primary Twilio webhook for incoming phone calls.
 * 
 * Supports two operational modes:
 * 1. Direct Voice Assistant Mode (default):
 *    Initializes an Ultravox session and streams audio bidirectionally via TwiML <Connect><Stream>.
 * 2. Missed-Call Callback Mode (when VOICE_CALLBACK_ENABLED=true or ?callback=true):
 *    Acts as a short trigger: acknowledges call, speaks 112 emergency instructions, hangs up promptly,
 *    and places an outbound callback to the caller using the CareLoop outbound voice engine.
 */
voiceRouter.post('/inbound', verifyTwilioWebhook, async (req, res) => {
  const callSid = req.body.CallSid || `CALL-SIM-${Date.now()}`;
  const callerNumber = req.body.From || 'Unknown';
  const calledNumber = req.body.To || env.TWILIO_PHONE_NUMBER || 'CareLoop Main';

  console.log(`[Twilio Inbound] Incoming call received. CallSid: ${callSid}, Caller: ${maskPhoneNumber(callerNumber)}`);

  const isCallbackMode = Boolean(
    env.VOICE_CALLBACK_ENABLED ||
    req.query.mode === 'callback' ||
    req.query.callback === 'true' ||
    req.body.CallbackMode === 'true'
  );

  // =========================================================================
  // M8.1: MISSED-CALL CALLBACK WORKFLOW
  // =========================================================================
  if (isCallbackMode) {
    console.log(`[Twilio Inbound] Processing call ${callSid} in Missed-Call Callback mode.`);
    const emergency = getEmergencyGuidance();

    // 1. Inbound Idempotency Guard for trigger call
    let existingTrigger = null;
    try {
      existingTrigger = await findVoiceCallBySidRaw(callSid);
    } catch (_) {}

    if (existingTrigger && existingTrigger.direction === 'inbound') {
      console.log(`[Twilio Inbound] Duplicate webhook for trigger ${callSid} – replaying prompt acknowledgment.`);
      const twimlRetry = new twilio.twiml.VoiceResponse();
      twimlRetry.say(
        { voice: 'Polly.Joanna-Neural' },
        `Thank you for calling CareLoop. We have already logged your request and our assistant will call you back shortly. ${emergency.spokenInstructions}`
      );
      twimlRetry.hangup();
      res.type('text/xml');
      return res.send(twimlRetry.toString());
    }

    // 2. Validate Caller Phone Number to strict E.164
    const normalizedCaller = normalizeE164Phone(callerNumber);
    if (!normalizedCaller) {
      console.warn(`[Twilio Inbound] Callback trigger rejected: Caller ID "${callerNumber}" is missing or invalid E.164.`);
      try {
        await createVoiceCall({
          callSid,
          from: callerNumber || 'Unknown',
          to: calledNumber,
          direction: 'inbound',
          status: 'failed',
          triggerForCallback: true,
          errorNote: 'INVALID_CALLER_PHONE',
          isMock: Boolean(req.isTwilioMock || env.VOICE_MOCK_MODE)
        });
      } catch (_) {}

      const twimlInvalid = new twilio.twiml.VoiceResponse();
      twimlInvalid.say(
        { voice: 'Polly.Joanna-Neural' },
        `Thank you for calling CareLoop. We were unable to identify your caller ID to place an automated callback. Please contact our clinic staff directly during business hours. ${emergency.spokenInstructions}`
      );
      twimlInvalid.hangup();
      res.type('text/xml');
      return res.send(twimlInvalid.toString());
    }

    // 3. Determine Mock Simulation vs Live Telephony
    const isCallbackMock = Boolean(
      req.isTwilioMock ||
      env.VOICE_MOCK_MODE ||
      req.query.mock === 'true' ||
      req.body.Mock === 'true' ||
      req.headers['x-mock-callback'] === 'true' ||
      req.headers['x-mock-tool'] === 'true' ||
      isSyntheticPhone(normalizedCaller)
    );


    // Record Inbound Trigger Call Record
    try {
      await createVoiceCall({
        callSid,
        from: normalizedCaller,
        to: calledNumber,
        direction: 'inbound',
        status: 'completed',
        triggerForCallback: true,
        isMock: isCallbackMock
      });
    } catch (dbErr) {
      console.warn(`[Twilio Inbound] Could not record trigger call in DB:`, dbErr.message);
    }

    // 4. Verify First-Time Consent & Opt-Out
    const consentCheck = await isPhoneEligibleForCallback(normalizedCaller, {
      requireConsent: env.VOICE_CALLBACK_REQUIRE_CONSENT
    });

    if (!consentCheck.eligible) {
      console.warn(`[Twilio Inbound] Callback ineligible for ${maskPhoneNumber(normalizedCaller)}: ${consentCheck.reason}`);
      
      // Basic-phone IVR Consent Flow (Twilio <Gather>)
      // If affirmative consent is required but hasn't been granted yet, give basic-phone users
      // an immediate telephone DTMF IVR prompt instead of requiring an app or internet access.
      if (consentCheck.reason === 'CONSENT_REQUIRED') {
        console.log(`[Twilio Inbound] Prompting basic-phone caller ${maskPhoneNumber(normalizedCaller)} for IVR callback consent (<Gather>).`);
        const twimlGather = new twilio.twiml.VoiceResponse();
        const queryParams = new URLSearchParams();
        if (req.query.mode) queryParams.set('mode', req.query.mode);
        if (req.query.mock || isCallbackMock) queryParams.set('mock', 'true');
        const actionUrl = `/api/voice/callback/gather-consent${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;

        const gather = twimlGather.gather({
          numDigits: 1,
          action: actionUrl,
          method: 'POST',
          timeout: 8
        });

        gather.say(
          { voice: 'Polly.Joanna-Neural' },
          `Thank you for calling CareLoop. To have our healthcare coordination assistant call you back on this number for administrative assistance, press 1. To decline, press 2. ${emergency.spokenInstructions}`
        );

        // Fallback if caller hangs up or does not press any digit within timeout
        twimlGather.say(
          { voice: 'Polly.Joanna-Neural' },
          `We did not receive your response. No callback will be placed. ${emergency.spokenInstructions} Goodbye.`
        );
        twimlGather.hangup();
        res.type('text/xml');
        return res.send(twimlGather.toString());
      }

      const twimlIneligible = new twilio.twiml.VoiceResponse();
      let spokenReason = 'Automatic callbacks are currently unavailable for this number.';
      if (consentCheck.reason === 'OPTED_OUT') {
        spokenReason = 'You have opted out of automated callbacks from CareLoop. Please contact our clinic staff directly.';
      } else if (consentCheck.reason === 'DECLINED') {
        spokenReason = 'You have declined automated callbacks from CareLoop. Please contact our clinic staff directly.';
      } else if (consentCheck.reason === 'CONSENT_EXPIRED') {
        spokenReason = 'Your previous callback consent has expired. Please contact our clinic staff to renew consent.';
      }

      twimlIneligible.say(
        { voice: 'Polly.Joanna-Neural' },
        `Thank you for calling CareLoop. ${spokenReason} ${emergency.spokenInstructions}`
      );
      twimlIneligible.hangup();
      res.type('text/xml');
      return res.send(twimlIneligible.toString());
    }

    // 5. Initiate Missed-Call Callback (atomic lock, cooldown, limits, mock/live dispatch)
    let callbackResult = null;
    let callbackError = null;

    try {
      callbackResult = await initiateMissedCallCallback({
        phone: normalizedCaller,
        triggerCallSid: callSid,
        isMock: isCallbackMock,
        requireConsent: env.VOICE_CALLBACK_REQUIRE_CONSENT
      });
    } catch (err) {
      callbackError = err;
    }


    const twimlResponse = new twilio.twiml.VoiceResponse();

    if (callbackError) {
      if (callbackError.code === 'COOLDOWN_ACTIVE') {
        twimlResponse.say(
          { voice: 'Polly.Joanna-Neural' },
          `Thank you for calling CareLoop. We have already scheduled a callback to your number. Please wait for our incoming call shortly. ${emergency.spokenInstructions}`
        );
      } else if (callbackError.code === 'MAX_ATTEMPTS_EXCEEDED') {
        twimlResponse.say(
          { voice: 'Polly.Joanna-Neural' },
          `Thank you for calling CareLoop. You have reached the maximum daily callback requests. Please contact our clinic staff directly. ${emergency.spokenInstructions}`
        );
      } else if (callbackError.code === 'CALLBACK_ALREADY_IN_PROGRESS') {
        twimlResponse.say(
          { voice: 'Polly.Joanna-Neural' },
          `Thank you for calling CareLoop. A callback is already in progress for your phone number. Please wait for our incoming call. ${emergency.spokenInstructions}`
        );
      } else {
        twimlResponse.say(
          { voice: 'Polly.Joanna-Neural' },
          `Thank you for calling CareLoop. We are experiencing high call volume. Please try calling again in a few minutes or reach our clinic staff directly. ${emergency.spokenInstructions}`
        );
      }
    } else {
      twimlResponse.say(
        { voice: 'Polly.Joanna-Neural' },
        `Thank you for calling CareLoop. We have received your request and our healthcare coordination assistant will call you back shortly. ${emergency.spokenInstructions}`
      );
    }

    // Promptly hang up the trigger call
    twimlResponse.hangup();
    res.type('text/xml');
    return res.send(twimlResponse.toString());
  }

  // =========================================================================
  // M8: DIRECT INBOUND STREAMING ASSISTANT (Default Mode)
  // =========================================================================
  // ── M8: Idempotency guard ────────────────────────────────────────────────
  // Twilio retries the same webhook on transient HTTP errors.
  // If we already have an active record for this callSid, replay the same
  // TwiML type (stream / mock / error) to avoid creating duplicate sessions.
  let existingCall = null;
  try {
    existingCall = await findVoiceCallBySidRaw(callSid);
  } catch (_) { /* DB miss is fine – proceed to create */ }

  if (existingCall && existingCall.direction === 'inbound') {
    console.log(`[Twilio Inbound] Duplicate webhook for ${callSid} – replaying stored TwiML type.`);
    const twimlRetry = new twilio.twiml.VoiceResponse();
    if (existingCall.joinUrl && !existingCall.isMock && existingCall.status === 'in-progress') {
      const connect = twimlRetry.connect();
      connect.stream({ url: existingCall.joinUrl });
    } else {
      const emergency = getEmergencyGuidance();
      twimlRetry.say(
        { voice: 'Polly.Joanna-Neural' },
        `Thank you for calling CareLoop. We are connecting you now. ${emergency.spokenInstructions}`
      );
    }
    res.type('text/xml');
    return res.send(twimlRetry.toString());
  }


  let ultravoxSession = null;
  let hasError = false;
  let errorMessage = '';
  let httpsWarning = false;

  try {
    // 1. Initialize Ultravox voice session
    ultravoxSession = await createUltravoxCallSession({
      callSid,
      callerNumber
    });
    console.log(`[Twilio Inbound] Ultravox session ready for ${callSid}. Mode: ${ultravoxSession.isMock ? 'MOCK' : 'LIVE'}, SessionId: ${ultravoxSession.callId}`);

    // Detect live session with no tools (PUBLIC_URL not HTTPS)
    if (!ultravoxSession.isMock) {
      const base = env.PUBLIC_URL || '';
      if (!base.startsWith('https://')) httpsWarning = true;
    }
  } catch (err) {
    hasError = true;
    errorMessage = err.message;
    console.error(`[Twilio Inbound] Voice session failed for ${callSid}. Code: ${err.code || 'UNKNOWN'}, Message: ${err.message}`);
  }

  // 2. Record call initiation in MongoDB
  try {
    await createVoiceCall({
      callSid,
      from: callerNumber,
      to: calledNumber,
      direction: 'inbound',
      status: hasError ? 'failed' : 'in-progress',
      ultravoxCallId: ultravoxSession?.callId || null,
      joinUrl: ultravoxSession?.joinUrl || null,
      isMock: Boolean(ultravoxSession?.isMock || req.isTwilioMock)
    });
  } catch (dbErr) {
    console.warn(`[Twilio Inbound] Could not record call log in DB:`, dbErr.message);
  }

  // 3. Generate TwiML response
  const twiml = new twilio.twiml.VoiceResponse();
  const emergency = getEmergencyGuidance();

  if (hasError) {
    // Safe fallback: tell caller to try again or contact clinic staff
    const clinicPhone = env.CLINIC_PHONE || '';
    const contactMsg = clinicPhone
      ? `You may also reach our clinic staff directly. ${emergency.spokenInstructions}`
      : emergency.spokenInstructions;
    twiml.say(
      { voice: 'Polly.Joanna-Neural' },
      `Thank you for calling CareLoop. Our voice service is temporarily unavailable. Please try calling again in a few minutes or contact our clinic during business hours. ${contactMsg}`
    );
    twiml.hangup();
  } else if (ultravoxSession?.isMock) {
    // Mock-mode: announce AI assistant simulation is active (M8: accurate description)
    twiml.say(
      { voice: 'Polly.Joanna-Neural' },
      `Hello, thank you for calling CareLoop, your healthcare AI coordination assistant. You have reached our voice agent in simulation mode. In production, an AI assistant can help you find providers, check availability, and manage appointments. ${emergency.spokenInstructions}`
    );
    twiml.pause({ length: 1 });
    twiml.say(
      { voice: 'Polly.Joanna-Neural' },
      'If this is a real call, please ensure the CareLoop system is fully configured. Goodbye.'
    );
    twiml.hangup();
  } else if (httpsWarning) {
    // Live session but HTTPS not configured — agent tools cannot reach the backend
    console.warn(`[Twilio Inbound] Live Ultravox session for ${callSid} but PUBLIC_URL is not HTTPS. Agent tools will be unavailable.`);
    const connect = twiml.connect();
    connect.stream({ url: ultravoxSession.joinUrl });
    // Note: Ultravox will still converse but cannot invoke tool webhooks
  } else {
    // Live Ultravox integration: Connect bidirectional audio stream
    const connect = twiml.connect();
    connect.stream({
      url: ultravoxSession.joinUrl
    });
  }

  res.type('text/xml');
  return res.send(twiml.toString());
});

/**
 * POST /api/voice/status
 * Twilio status callback endpoint to track call lifecycle (ringing, completed, failed, etc.).
 */
voiceRouter.post('/status', verifyTwilioWebhook, async (req, res) => {
  const callSid = req.body.CallSid;
  const rawStatus = (req.body.CallStatus || 'completed').toLowerCase().trim();
  const duration = parseInt(req.body.CallDuration || '0', 10);
  const errorMessage = req.body.ErrorMessage || null;

  const ALLOWED_STATUSES = ['queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled'];
  const callStatus = ALLOWED_STATUSES.includes(rawStatus) ? rawStatus : 'completed';

  console.log(`[Twilio Status] Call ${callSid} status update: ${callStatus} (duration: ${duration}s)`);

  if (callSid) {
    try {
      await updateVoiceCallStatus(callSid, callStatus, {
        durationSeconds: duration,
        errorNote: errorMessage
      });
      // Synchronize callback lock status if this call was a callback
      await updateCallbackLockStatus(callSid, callStatus, {
        durationSeconds: duration,
        error: errorMessage
      });
      // M10 Safeguard: If the call has terminated, cancel any pending unconfirmed action.
      // Outbound calls bind agent tools to a session ID that differs from Twilio's CallSid.
      if (['completed', 'canceled', 'failed', 'busy', 'no-answer'].includes(callStatus)) {
        const call = await findVoiceCallBySession(callSid);
        const sessionIds = new Set([callSid, call?.agentSessionId].filter(Boolean));
        for (const sessionId of sessionIds) {
          await cancelActiveConfirmation(sessionId, `call_${callStatus}`);
        }
        // A health call that ended before its check finished becomes a "call back" for the clinic.
        // Waits a few seconds so a check still being saved at hang-up is not mistaken for a missing one.
        if (callStatus === 'completed' && call?.callIntent === 'health_check' && !call.isMock && duration >= 15) {
          setTimeout(() => {
            noteUnfinishedHealthCall(call).catch(err => console.warn(`[Health Check] Could not record unfinished call: ${err.message}`));
          }, 8000);
        }
      }
    } catch (err) {
      console.warn(`[Twilio Status] Error updating call status in DB:`, err.message);
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  res.type('text/xml');
  return res.send(twiml.toString());
});

/**
 * POST /api/voice/callback/gather-consent
 * Twilio webhook for basic-phone DTMF consent gathering (<Gather>).
 * Handles affirmative consent (key 1), explicit decline (key 2), or invalid/empty keys.
 */
voiceRouter.post('/callback/gather-consent', verifyTwilioWebhook, async (req, res) => {
  const emergency = getEmergencyGuidance();
  const digits = (req.body.Digits || '').trim();
  const callerNumber = req.body.From || 'Unknown';
  const calledNumber = req.body.To || env.TWILIO_PHONE_NUMBER || 'CareLoop Main';
  const callSid = req.body.CallSid || `CALL-GATHER-${Date.now()}`;
  const normalizedCaller = normalizeE164Phone(callerNumber);

  console.log(`[Twilio Consent Gather] Digit received from ${maskPhoneNumber(callerNumber)}: "${digits}" (CallSid: ${callSid})`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!normalizedCaller) {
    twiml.say(
      { voice: 'Polly.Joanna-Neural' },
      `Thank you for calling CareLoop. We were unable to identify your caller ID. Please contact our clinic staff directly. ${emergency.spokenInstructions}`
    );
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const isCallbackMock = Boolean(
    req.isTwilioMock ||
    env.VOICE_MOCK_MODE ||
    req.query.mock === 'true' ||
    req.body.Mock === 'true' ||
    req.headers['x-mock-callback'] === 'true' ||
    isSyntheticPhone(normalizedCaller)
  );

  // Key 1: Explicit Affirmative Consent
  if (digits === '1') {
    try {
      await grantCallbackConsent(normalizedCaller, {
        source: 'ivr_phone_gather',
        policyVersion: '1.0'
      });
      console.log(`[Twilio Consent Gather] Affirmative consent recorded for ${maskPhoneNumber(normalizedCaller)} via basic-phone IVR.`);
    } catch (consentErr) {
      console.warn(`[Twilio Consent Gather] Error recording consent:`, consentErr.message);
    }

    // Record inbound trigger call
    try {
      await createVoiceCall({
        callSid,
        from: normalizedCaller,
        to: calledNumber,
        direction: 'inbound',
        status: 'completed',
        triggerForCallback: true,
        isMock: isCallbackMock
      });
    } catch (_) {}

    // Initiate missed-call callback
    let callbackError = null;
    try {
      await initiateMissedCallCallback({
        phone: normalizedCaller,
        triggerCallSid: callSid,
        isMock: isCallbackMock,
        requireConsent: true
      });
    } catch (err) {
      callbackError = err;
    }

    if (callbackError) {
      if (callbackError.code === 'COOLDOWN_ACTIVE') {
        twiml.say(
          { voice: 'Polly.Joanna-Neural' },
          `Thank you. Your consent has been recorded. We have already scheduled a callback to your number. Please wait for our incoming call shortly. ${emergency.spokenInstructions}`
        );
      } else if (callbackError.code === 'MAX_ATTEMPTS_EXCEEDED') {
        twiml.say(
          { voice: 'Polly.Joanna-Neural' },
          `Thank you. Your consent has been recorded. You have reached the maximum daily callback requests. Please contact our clinic staff directly. ${emergency.spokenInstructions}`
        );
      } else {
        twiml.say(
          { voice: 'Polly.Joanna-Neural' },
          `Thank you. Your consent has been recorded. We are experiencing high call volume. Please try calling again in a few minutes. ${emergency.spokenInstructions}`
        );
      }
    } else {
      twiml.say(
        { voice: 'Polly.Joanna-Neural' },
        `Thank you. Your consent has been recorded. Our healthcare coordination assistant will call you back shortly. ${emergency.spokenInstructions}`
      );
    }
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Key 2: Explicit Decline
  if (digits === '2') {
    try {
      await declineCallbackConsent(normalizedCaller, {
        source: 'ivr_phone_gather',
        reason: 'Caller declined callback via basic-phone IVR'
      });
      console.log(`[Twilio Consent Gather] Explicit decline recorded for ${maskPhoneNumber(normalizedCaller)} via basic-phone IVR.`);
    } catch (declineErr) {
      console.warn(`[Twilio Consent Gather] Error recording decline:`, declineErr.message);
    }

    twiml.say(
      { voice: 'Polly.Joanna-Neural' },
      `You have declined automated callbacks. No call will be placed. ${emergency.spokenInstructions}`
    );
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Invalid key or timeout fallback
  twiml.say(
    { voice: 'Polly.Joanna-Neural' },
    `Invalid selection. No callback will be placed. ${emergency.spokenInstructions}`
  );
  twiml.hangup();
  res.type('text/xml');
  return res.send(twiml.toString());
});

/**
 * GET /api/voice/config
 * Clinician-authenticated status endpoint for phone and voice agent setup.
 */
voiceRouter.get('/config', requireClinician, (req, res) => {
  const twilioConfigured = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  const ultravoxConfigured = isUltravoxConfigured();
  const mockMode = Boolean(env.VOICE_MOCK_MODE || (!twilioConfigured && !ultravoxConfigured));

  const publicBase = env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, '') : `http://localhost:${env.PORT}`;

  res.json({
    status: 'success',
    data: {
      telephony: {
        provider: 'Twilio',
        isConfigured: twilioConfigured,
        phoneNumber: env.TWILIO_PHONE_NUMBER ? maskPhoneNumber(env.TWILIO_PHONE_NUMBER) : 'Not Configured',
        accountSid: env.TWILIO_ACCOUNT_SID ? `${env.TWILIO_ACCOUNT_SID.slice(0, 6)}...` : null
      },
      voiceAgent: {
        provider: 'Ultravox',
        isConfigured: ultravoxConfigured,
        model: env.ULTRAVOX_MODEL,
        voice: env.ULTRAVOX_VOICE,
        languageHint: env.ULTRAVOX_LANGUAGE_HINT || 'hi',
        primaryLanguage: 'hi',
        supportedLanguages: ['hi', 'en', 'hinglish']
      },
      webhooks: {
        inboundUrl: `${publicBase}/api/voice/inbound`,
        statusUrl: `${publicBase}/api/voice/status`
      },
      callback: {
        enabled: env.VOICE_CALLBACK_ENABLED,
        cooldownSeconds: env.VOICE_CALLBACK_COOLDOWN_SECONDS,
        maxAttempts: env.VOICE_CALLBACK_MAX_ATTEMPTS,
        requireConsent: env.VOICE_CALLBACK_REQUIRE_CONSENT
      },
      isMockMode: mockMode,
      emergencyProtocolActive: true,
      emergencyGuidance: getEmergencyGuidance()
    }
  });
});

/**
 * POST /api/voice/callback/consent
 * Clinician-authenticated management of phone callback consent (opt-in / opt-out).
 * Patients manage their own consent via /api/patient/callback-consent.
 */
voiceRouter.post('/callback/consent', requireClinician, async (req, res) => {
  try {
    const { phone, status, notes } = req.body || {};
    const source = `clinician:${req.user._id}`;
    const normalized = normalizeE164Phone(phone);
    if (!normalized) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'A valid E.164 phone number is required.',
        code: 'INVALID_PHONE_NUMBER'
      });
    }

    if (status === 'opted_out') {
      const record = await optOutCallbackConsent(normalized, { reason: notes || 'Opted out via consent API', source });
      return res.json({ status: 'success', message: 'Phone number opted out from callbacks.', data: record });
    } else {
      const record = await grantCallbackConsent(normalized, { source, notes });
      return res.json({ status: 'success', message: 'Callback consent granted.', data: record });
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: 'ConsentError', message: err.message });
  }
});

/**
 * GET /api/voice/callback/consent
 * Clinician-authenticated lookup of the callback consent record for a phone number.
 */
voiceRouter.get('/callback/consent', requireClinician, async (req, res) => {
  try {
    const { phone } = req.query;
    const normalized = normalizeE164Phone(phone);
    if (!normalized) {
      return res.status(400).json({ error: 'BadRequest', message: 'A valid E.164 phone number is required.' });
    }
    const record = await getConsentRecord(normalized);
    res.json({ status: 'success', data: record });
  } catch (err) {
    res.status(500).json({ error: 'ConsentError', message: err.message });
  }
});

/**
 * POST /api/voice/callback/retry
 * Clinician-authorized endpoint to safely retry an unanswered, busy, or failed callback.
 * Enforces bounded retry invariants, cooldown, daily limits, and opt-out/consent protection.
 */
voiceRouter.post('/callback/retry', requireClinician, async (req, res) => {
  try {
    const { callbackCallSid, mock, isMock } = req.body || {};
    const result = await retryMissedCallCallback({
      callbackCallSid,
      clinicianInitiated: true,
      isMock: typeof isMock === 'boolean' ? isMock : Boolean(mock)
    });
    return res.status(201).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      status: 'failed',
      error: err.name || 'RetryError',
      code: err.code || 'RETRY_FAILED',
      message: err.message
    });
  }
});

/**
 * GET /api/voice/calls
 * Clinician-authenticated endpoint to list recent voice calls.
 */
voiceRouter.get('/calls', requireClinician, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '20', 10);
    const calls = await listRecentVoiceCalls({ limit: Math.min(limit, 50) });
    res.json({
      status: 'success',
      count: calls.length,
      data: calls
    });
  } catch (err) {
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to retrieve voice call logs.'
    });
  }
});

/**
 * POST /api/voice/outbound
 * Initiates an outbound AI voice appointment reminder call.
 * Requires clinician authentication and explicit confirmation.
 */
voiceRouter.post('/outbound', requireClinician, async (req, res) => {
  try {
    const { appointmentId, phone, confirmed, mock, isMock } = req.body || {};
    const idempotencyKey = req.body?.idempotencyKey || req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || null;

    const result = await initiateOutboundReminderCall({
      appointmentId,
      phone,
      confirmed,
      idempotencyKey,
      isMock: typeof isMock === 'boolean' ? isMock : Boolean(mock)
    });

    const statusCode = result.replayed ? 200 : 201;
    return res.status(statusCode).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      status: 'failed',
      error: err.name || 'OutboundCallError',
      code: err.code || 'OUTBOUND_CALL_ERROR',
      message: err.message
    });
  }
});

const TOOL_HANDLERS = {
  find_providers: handleFindProviders,
  get_available_slots: handleGetAvailableSlots,
  get_appointment_status: handleGetAppointmentStatus,
  prepare_booking: handlePrepareBooking,
  confirm_booking: handleConfirmBooking,
  prepare_cancellation: handlePrepareCancellation,
  confirm_cancellation: handleConfirmCancellation,
  prepare_reschedule: handlePrepareReschedule,
  confirm_reschedule: handleConfirmReschedule,
  // PlanPilot care-plan tools (patients answer and report by phone)
  get_my_care_plan: handleGetMyCarePlan,
  respond_to_care_option: handleRespondToCareOption,
  report_care_problem: handleReportCareProblem,
  // Health check-in (symptom check) tools
  check_symptoms: handleCheckSymptoms,
  book_triage_appointment: handleBookTriageAppointment
};

/**
 * POST /api/voice/health-check-call
 * Body: { name, phone, preferredLanguage }. CareLoop phones the person (they need not be a patient
 * yet), asks whether they have a health problem, and runs the symptom-check protocol on the call.
 */
voiceRouter.post('/health-check-call', requireClinician, async (req, res) => {
  try {
    const { name, phone, preferredLanguage } = req.body || {};
    const result = await placeHealthCheckCall({ name, phone, preferredLanguage });
    res.status(201).json({ status: 'success', data: result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.name, code: err.code, message: err.message, status: err.statusCode || 500 });
  }
});

/**
 * POST /api/voice/care-call
 * Body: { patientId, approvalId? }. PlanPilot phones the patient about their care plan (usually to
 * confirm a waiting option). Synthetic patients get a simulated call.
 */
voiceRouter.post('/care-call', requireClinician, async (req, res) => {
  try {
    const { patientId, approvalId } = req.body || {};
    const result = await placeCarePlanCall({ patientId, approvalId: approvalId || null });
    res.status(201).json({ status: 'success', data: result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.name, code: err.code, message: err.message, status: err.statusCode || 500 });
  }
});

/**
 * POST /api/voice/tools/:toolName
 * Webhook endpoint for Ultravox agent tool execution.
 * Authenticated via session-bound HMAC tool token.
 */
voiceRouter.post('/tools/:toolName', requireToolAuth, async (req, res) => {
  const { toolName } = req.params;
  const handler = TOOL_HANDLERS[toolName];

  if (!handler) {
    return res.status(404).json({
      status: 'not_found',
      error: 'NotFound',
      message: `Tool "${toolName}" is not recognized or supported.`,
      code: 'TOOL_NOT_FOUND'
    });
  }

  try {
    const callSid = req.callSid || req.body?.callSid;
    const result = await handler({
      ...req.body,
      callSid
    });

    // Answer the agent first (the caller is waiting), then record the audited tool execution
    res.json(result);
    if (callSid) {
      console.log(`[Tool Audit] Call: ${callSid}, Tool: ${toolName}, Status: ${result.status}, Action: ${result.action || 'N/A'}${result.bookingReference ? `, Ref: ${result.bookingReference}` : ''}`);
      recordVoiceCallToolEvent(callSid, {
        toolName,
        action: result.action || null,
        status: result.status || 'success',
        bookingReference: result.bookingReference || result.appointment?.bookingReference || null,
        summary: result.summary || null
      }).catch(err => {
        console.warn(`[Tool Audit] Failed to record event for ${toolName}:`, err.message);
      });
    }
  } catch (err) {
    console.error(`[Tool Execution Error] ${toolName}:`, err.message);
    return res.status(500).json({
      status: 'failed',
      error: 'InternalServerError',
      message: 'An unexpected error occurred during tool execution. Please offer alternatives.',
      code: 'TOOL_EXECUTION_ERROR'
    });
  }
});

