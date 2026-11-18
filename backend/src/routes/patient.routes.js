import express from 'express';
import { requirePatient } from '../middleware/auth.middleware.js';
import { getAvailableSlots } from '../services/slot.service.js';
import { 
  rescheduleBooking, 
  cancelBooking 
} from '../services/booking.service.js';
import { 
  findAppointmentById, 
  listAppointmentsByPatient 
} from '../repositories/appointment.repository.js';
import { findProviderById } from '../repositories/provider.repository.js';
import { getLatestOutboundCallForAppointment } from '../repositories/voiceCall.repository.js';
import { getEmergencyGuidance } from '../config/emergency.js';
import { getClinicDetails } from '../config/clinic.js';
import { env } from '../config/env.js';
import { 
  getConsentRecord, 
  grantCallbackConsent, 
  optOutCallbackConsent, 
  normalizeE164Phone 
} from '../repositories/callbackConsent.repository.js';
import { getLatestCallback } from '../repositories/callbackLock.repository.js';
import { patientCareRouter } from './patientCare.routes.js';

export const patientRouter = express.Router();


// Enforce strict patient authentication on all patient routes
patientRouter.use(requirePatient);

// PlanPilot: the patient's own care plans ("My care plan")
patientRouter.use('/care', patientCareRouter);

/**
 * Helper to verify patient ownership of an appointment record.
 * Prefers the linked account ID; falls back to an exact email match for legacy records.
 */
function isPatientOwner(appointment, patientUser) {
  if (!appointment || !appointment.patient || !patientUser) return false;

  if (appointment.patientUserId) {
    return String(appointment.patientUserId) === String(patientUser._id);
  }

  const apptEmail = appointment.patient.email ? appointment.patient.email.trim().toLowerCase() : null;
  const userEmail = patientUser.email ? patientUser.email.trim().toLowerCase() : null;
  
  return Boolean(apptEmail && userEmail && apptEmail === userEmail);
}

/**
 * Helper to enrich an appointment with provider details and non-sensitive reminder status.
 */
async function enrichAppointmentForPatient(appt) {
  const provider = appt.providerId ? await findProviderById(appt.providerId) : null;
  const latestCall = await getLatestOutboundCallForAppointment(appt._id);

  let reminder = {
    status: 'not_scheduled',
    label: 'No reminder call scheduled',
    attemptedAt: null,
    isMock: false,
    durationSeconds: 0,
    callSid: null
  };

  if (latestCall) {
    const isMock = Boolean(latestCall.isMock);
    const duration = latestCall.durationSeconds || 0;
    let label = 'Automated reminder call';

    switch (latestCall.status) {
      case 'completed':
        label = isMock 
          ? `Simulated AI voice reminder completed (${duration}s)` 
          : `Live AI voice reminder completed (${duration}s)`;
        break;
      case 'in-progress':
        label = isMock 
          ? 'Simulated AI reminder call in progress' 
          : 'Live AI reminder call in progress';
        break;
      case 'ringing':
        label = isMock ? 'Simulated line ringing' : 'Patient line ringing';
        break;
      case 'queued':
      case 'initiated':
        label = 'Reminder call queued for dispatch';
        break;
      case 'no-answer':
        label = 'Reminder call: No answer from recipient';
        break;
      case 'busy':
        label = 'Reminder call: Line busy';
        break;
      case 'failed':
        label = 'Reminder call: Delivery failed';
        break;
      default:
        label = `Reminder call ${latestCall.status}`;
    }

    reminder = {
      status: latestCall.status,
      label,
      attemptedAt: latestCall.createdAt,
      isMock,
      durationSeconds: duration,
      callSid: latestCall.callSid ? `${latestCall.callSid.slice(0, 14)}...` : null
    };
  } else if (appt.outboundCallLock) {
    reminder = {
      status: appt.outboundCallLock.status,
      label: `Reminder dispatch: ${appt.outboundCallLock.status}`,
      attemptedAt: appt.outboundCallLock.lockedAt || null,
      isMock: true,
      durationSeconds: 0,
      callSid: appt.outboundCallLock.callSid || null
    };
  }

  return {
    ...appt,
    provider: provider ? {
      _id: provider._id,
      name: provider.name,
      specialty: provider.specialty
    } : null,
    reminder
  };
}

/**
 * GET /api/patient/appointments
 * Retrieves upcoming and past appointments belonging strictly to the authenticated patient.
 */
patientRouter.get('/appointments', async (req, res, next) => {
  try {
    const rawList = (await listAppointmentsByPatient({
      patientUserId: req.patient._id,
      email: req.patient.email
    })).filter(appt => isPatientOwner(appt, req.patient));

    const now = new Date();
    const enrichedList = await Promise.all(rawList.map(enrichAppointmentForPatient));

    const upcoming = [];
    const past = [];

    for (const appt of enrichedList) {
      const start = new Date(appt.startAt);
      if (appt.status === 'confirmed' && start >= now) {
        upcoming.push(appt);
      } else {
        past.push(appt);
      }
    }

    // Sort upcoming soonest-first, past most-recent-first
    upcoming.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    past.sort((a, b) => new Date(b.startAt) - new Date(a.startAt));

    res.status(200).json({
      status: 'success',
      count: enrichedList.length,
      data: {
        upcoming,
        past,
        total: enrichedList.length
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/patient/appointments/:id
 * Retrieves appointment details with follow-up information.
 * Enforces patient ownership to prevent unauthorized access or enumeration.
 */
patientRouter.get('/appointments/:id', async (req, res, next) => {
  try {
    const appt = await findAppointmentById(req.params.id);
    if (!appt || !isPatientOwner(appt, req.patient)) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Appointment not found or not accessible.',
        status: 404
      });
    }

    const enriched = await enrichAppointmentForPatient(appt);
    const emergency = getEmergencyGuidance();
    const clinic = getClinicDetails();

    const followUp = {
      appointmentConfirmation: appt.bookingReference,
      status: appt.status,
      startAt: appt.startAt,
      endAt: appt.endAt,
      provider: enriched.provider,
      clinicLocation: {
        facility: clinic.facility,
        suite: clinic.suite,
        address: clinic.address,
        checkInDesk: clinic.checkInDesk,
        isDemoData: clinic.isDemoData,
        demoNotice: clinic.demoNotice || null,
        verificationStatus: clinic.verificationStatus
      },
      clinicContact: {
        ...clinic.contact,
        isDemoData: clinic.isDemoData,
        demoNotice: clinic.demoNotice || null
      },
      administrativePreparation: [
        'Please arrive 15 minutes prior to your scheduled time for check-in.',
        'Bring a government-issued photo ID and insurance card if applicable.',
        'Have a list of your current prescriptions and any allergies ready.',
        'No fasting or special preparation is required unless specifically directed by your physician.'
      ],
      reminderStatus: enriched.reminder,
      emergencyNotice: {
        region: emergency.region,
        number: emergency.emergencyNumber,
        guidance: `If you experience a medical emergency, do not wait for an appointment. Dial ${emergency.emergencyNumber} or proceed to your ${emergency.facilityName} immediately.`
      }
    };

    res.status(200).json({
      status: 'success',
      data: {
        ...enriched,
        followUp
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/patient/appointments/:id/reschedule
 * Requests rescheduling for an appointment owned by the authenticated patient.
 * Revalidates slot availability on the server and applies transaction-level concurrency control.
 */
patientRouter.post('/appointments/:id/reschedule', async (req, res, next) => {
  try {
    const appt = await findAppointmentById(req.params.id);
    if (!appt || !isPatientOwner(appt, req.patient)) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Appointment not found or not accessible.',
        status: 404
      });
    }

    if (appt.status !== 'confirmed') {
      return res.status(400).json({
        error: 'BadRequest',
        message: `Cannot reschedule appointment with status "${appt.status}". Only confirmed appointments can be rescheduled.`,
        code: 'INVALID_STATUS_FOR_RESCHEDULE',
        status: 400
      });
    }

    const { newStartAt, newEndAt } = req.body || {};
    const idempotencyKey = req.body?.idempotencyKey || req.headers['idempotency-key'] || null;

    if (!newStartAt || !newEndAt) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'newStartAt and newEndAt are required to reschedule.',
        status: 400
      });
    }

    const result = await rescheduleBooking(appt._id, {
      newStartAt,
      newEndAt,
      idempotencyKey
    });

    const enrichedNew = await enrichAppointmentForPatient(result.appointment);

    res.status(200).json({
      status: 'success',
      message: 'Appointment rescheduled successfully.',
      originalAppointmentId: result.originalAppointmentId,
      data: enrichedNew
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.name || 'RescheduleError',
        message: err.message,
        code: err.code || 'RESCHEDULE_FAILED',
        status: err.statusCode
      });
    }
    next(err);
  }
});

/**
 * POST /api/patient/appointments/:id/cancel
 * Requests cancellation with mandatory explicit patient confirmation.
 */
patientRouter.post('/appointments/:id/cancel', async (req, res, next) => {
  try {
    const appt = await findAppointmentById(req.params.id);
    if (!appt || !isPatientOwner(appt, req.patient)) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Appointment not found or not accessible.',
        status: 404
      });
    }

    // Explicit confirmation guard: requires { confirmed: true }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Explicit patient confirmation (confirmed: true) is required to cancel this appointment.',
        code: 'CONFIRMATION_REQUIRED',
        status: 400
      });
    }

    const reason = req.body?.reason || 'Cancelled by patient via self-service portal';
    const result = await cancelBooking(appt._id, { reason, cancelledBy: 'patient' });

    const enriched = await enrichAppointmentForPatient(result.appointment);

    res.status(200).json({
      status: 'success',
      message: result.alreadyCancelled 
        ? 'Appointment was already cancelled.' 
        : 'Appointment cancelled successfully.',
      data: enriched
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.name || 'CancellationError',
        message: err.message,
        status: err.statusCode
      });
    }
    next(err);
  }
});

/**
 * GET /api/patient/slots
 * Retrieves available alternative slots for rescheduling.
 */
patientRouter.get('/slots', async (req, res, next) => {
  try {
    const { providerId, specialty, startDate, endDate, durationMinutes } = req.query;

    const slots = await getAvailableSlots({
      providerId,
      specialty,
      startDate,
      endDate,
      durationMinutes
    });

    res.status(200).json({
      status: 'success',
      count: slots.length,
      data: slots
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/patient/emergency-guidance
 * Returns configured regional emergency guidance without diagnosing.
 */
patientRouter.get('/emergency-guidance', (req, res) => {
  const guidance = getEmergencyGuidance();
  res.status(200).json({
    status: 'success',
    data: guidance
  });
});

/**
 * GET /api/patient/clinic-info
 * Returns clinic facility details with explicit demonstration data labeling.
 */
patientRouter.get('/clinic-info', (req, res) => {
  const clinic = getClinicDetails();
  res.status(200).json({
    status: 'success',
    data: clinic
  });
});

/**
 * GET /api/patient/callback-consent
 * Returns the current patient's callback consent status, policy version, and recent callback.
 */
patientRouter.get('/callback-consent', async (req, res, next) => {
  try {
    const patientPhone = req.patient?.phone;
    const normalized = normalizeE164Phone(patientPhone);
    const callbacksEnabled = Boolean(env.VOICE_CALLBACK_ENABLED);

    if (!normalized) {
      return res.status(200).json({
        status: 'success',
        data: {
          hasPhone: false,
          consentStatus: 'unconfigured',
          callbacksEnabled,
          message: 'No valid phone number associated with patient account.'
        }
      });
    }

    const record = await getConsentRecord(normalized);
    const latestCallback = await getLatestCallback(normalized);

    res.status(200).json({
      status: 'success',
      data: {
        hasPhone: true,
        phone: normalized,
        callbacksEnabled,
        consentStatus: record?.consentStatus || 'pending',
        consentSource: record?.consentSource || null,
        consentPolicyVersion: record?.consentPolicyVersion || '1.0',
        consentGrantedAt: record?.consentGrantedAt || null,
        optedOutAt: record?.optedOutAt || null,
        latestCallback: latestCallback ? {
          status: latestCallback.status,
          createdAt: latestCallback.createdAt,
          updatedAt: latestCallback.updatedAt
        } : null,
        disclaimer: 'A callback request does not guarantee an immediate response. If you are experiencing a medical emergency, please dial 112 immediately.'
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/patient/callback-consent
 * Updates the current patient's callback consent (opt-in or opt-out).
 */
patientRouter.post('/callback-consent', async (req, res, next) => {
  try {
    const patientPhone = req.patient?.phone;
    const normalized = normalizeE164Phone(patientPhone);
    if (!normalized) {
      return res.status(400).json({
        error: 'BadRequest',
        code: 'INVALID_PATIENT_PHONE',
        message: 'A valid phone number must be associated with your account to configure callback preferences.'
      });
    }

    const { consent, status } = req.body || {};
    const shouldOptOut = consent === false || status === 'opted_out';

    let record;
    if (shouldOptOut) {
      record = await optOutCallbackConsent(normalized, {
        reason: req.body?.reason || 'Patient opted out via patient portal'
      });
    } else {
      record = await grantCallbackConsent(normalized, {
        source: 'patient_portal',
        notes: `Consented by patient ${req.patient.email}`
      });
    }

    res.status(200).json({
      status: 'success',
      message: shouldOptOut
        ? 'You have opted out of automated phone callbacks.'
        : 'You have granted consent for automated healthcare coordination callbacks.',
      data: {
        phone: normalized,
        consentStatus: record.consentStatus,
        updatedAt: record.updatedAt
      }
    });
  } catch (err) {
    next(err);
  }
});


