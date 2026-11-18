import { env } from '../config/env.js';
import { findProviders, findProviderById, listActiveSpecialties } from '../repositories/provider.repository.js';
import { getAvailableSlots } from './slot.service.js';
import {
  createBooking,
  cancelBooking,
  rescheduleBooking,
  getAppointmentStatus,
  BookingConflictError
} from './booking.service.js';
import { maskPhoneNumber, findVoiceCallBySession } from '../repositories/voiceCall.repository.js';
import { normalizeE164Phone } from '../repositories/callbackConsent.repository.js';
import {
  prepareConfirmation,
  transitionToConfirmed,
  transitionToCompleted,
  transitionToFailed,
  cancelActiveConfirmation,
  ConfirmationError
} from './confirmation.service.js';

/**
 * Normalizes and formats a date/time string for spoken telephone clarity.
 */
export function formatSpokenDateTime(isoString, timezone = env.DEFAULT_TIMEZONE) {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
      timeZoneName: 'short'
    });
  } catch (_) {
    return isoString;
  }
}

/**
 * Validates whether an input string is a valid MongoDB ObjectId.
 */
function isValidObjectId(id) {
  return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id.trim());
}

/**
 * Validates caller verification details against an appointment record.
 * Protects patient privacy by requiring matching name or phone on file.
 */
function verifyCallerForAppointment(appointment, { verificationPhone, verificationName } = {}) {
  if (!appointment || !appointment.patient) return false;

  const apptPhone = appointment.patient.phone ? appointment.patient.phone.replace(/\D/g, '') : '';
  const apptName = appointment.patient.name ? appointment.patient.name.toLowerCase().trim() : '';

  if (verificationPhone) {
    const cleanPhone = String(verificationPhone).replace(/\D/g, '');
    if (cleanPhone.length >= 4 && apptPhone.endsWith(cleanPhone)) {
      return true;
    }
  }

  if (verificationName) {
    const cleanName = String(verificationName).toLowerCase().trim();
    if (cleanName.length >= 2 && (apptName.includes(cleanName) || cleanName.includes(apptName))) {
      return true;
    }
  }

  return false;
}

/**
 * Resolves the patient's real phone number from the active call record
 * (caller ID for inbound calls, dialed number for outbound calls).
 * Returns '' when unknown, never a placeholder number.
 */
async function resolveCallPhone(callSid) {
  const call = await findVoiceCallBySession(callSid).catch(() => null);
  if (!call) return '';
  const raw = call.direction === 'outbound' ? call.to : call.from;
  return normalizeE164Phone(raw) || '';
}

// ============================================================================
// Tool A: find_providers
// ============================================================================
export async function handleFindProviders({ specialty, name } = {}) {
  const filter = { isActive: true };

  if (specialty && typeof specialty === 'string' && specialty.trim()) {
    filter.specialty = specialty.trim();
  }
  if (name && typeof name === 'string' && name.trim()) {
    filter.name = name.trim();
  }

  const providers = await findProviders(filter);

  if (providers.length === 0) {
    const specialties = await listActiveSpecialties();
    const offered = specialties.length > 0 ? specialties.join(', ') : 'none currently available';
    return {
      status: 'not_found',
      count: 0,
      providers: [],
      message: `No active clinic providers found matching those criteria. Specialties currently offered: ${offered}.`
    };
  }

  const sanitized = providers.map(p => ({
    providerId: String(p._id),
    name: p.name,
    specialty: p.specialty,
    qualifications: p.qualifications || '',
    languages: Array.isArray(p.languages) ? p.languages.join(', ') : 'English',
    location: p.location || 'Main Outpatient Clinic'
  }));

  return {
    status: 'success',
    count: sanitized.length,
    providers: sanitized,
    message: `Found ${sanitized.length} provider(s). Let the caller know their names and specialties.`
  };
}

// ============================================================================
// Tool B: get_available_slots
// ============================================================================
export async function handleGetAvailableSlots({ providerId, specialty, startDate, endDate } = {}) {
  if (providerId && !isValidObjectId(providerId)) {
    return {
      status: 'validation_error',
      error: 'Invalid providerId format. Must be a valid 24-character hexadecimal ID.',
      code: 'INVALID_PROVIDER_ID'
    };
  }

  let validStartDate = startDate;
  if (startDate) {
    const d = new Date(startDate);
    if (isNaN(d.getTime())) {
      return {
        status: 'validation_error',
        error: 'Invalid startDate format. Please provide an ISO-8601 date string (e.g. YYYY-MM-DD).',
        code: 'INVALID_DATE'
      };
    }
  }

  const slots = await getAvailableSlots({
    providerId: providerId ? providerId.trim() : undefined,
    specialty: specialty ? specialty.trim() : undefined,
    startDate: validStartDate,
    endDate
  });

  if (slots.length === 0) {
    return {
      status: 'not_found',
      count: 0,
      slots: [],
      message: 'No available appointment slots found for the requested schedule. Please check a different date or ask about another provider.'
    };
  }

  // Return up to 6 next available slots formatted for natural speech
  const spokenSlots = slots.slice(0, 6).map(s => ({
    providerId: String(s.providerId),
    providerName: s.providerName,
    specialty: s.specialty,
    startAt: s.startAt,
    endAt: s.endAt,
    spokenTime: formatSpokenDateTime(s.startAt, s.timezone)
  }));

  return {
    status: 'success',
    count: spokenSlots.length,
    slots: spokenSlots,
    message: `Found ${spokenSlots.length} available slot(s). Present 2 or 3 options clearly to the caller.`
  };
}

// ============================================================================
// Tool C: get_appointment_status
// ============================================================================
export async function handleGetAppointmentStatus({ identifier, verificationPhone, verificationName } = {}) {
  if (!identifier || typeof identifier !== 'string' || !identifier.trim()) {
    return {
      status: 'validation_error',
      error: 'An appointment reference or appointment ID is required.',
      code: 'MISSING_IDENTIFIER'
    };
  }

  const appointment = await getAppointmentStatus(identifier.trim());

  if (!appointment) {
    return {
      status: 'not_found',
      message: 'Appointment not found. Please verify the booking reference or appointment number.',
      code: 'APPOINTMENT_NOT_FOUND'
    };
  }

  // Caller privacy verification check
  const isVerified = verifyCallerForAppointment(appointment, { verificationPhone, verificationName });
  if (!isVerified) {
    return {
      status: 'unauthorized',
      error: 'Verification required',
      message: 'To protect patient privacy, please verify the patient name or the phone number associated with this booking.',
      code: 'VERIFICATION_REQUIRED'
    };
  }

  const provider = await findProviderById(appointment.providerId);

  return {
    status: 'success',
    appointment: {
      bookingReference: appointment.bookingReference,
      status: appointment.status,
      providerName: provider?.name || 'Clinic Physician',
      specialty: provider?.specialty || 'General Practice',
      spokenTime: formatSpokenDateTime(appointment.startAt),
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      patientFirstName: appointment.patient?.name?.split(' ')[0] || 'Patient',
      patientMaskedPhone: maskPhoneNumber(appointment.patient?.phone)
    },
    message: `Appointment ${appointment.bookingReference} is currently ${appointment.status}.`
  };
}

// ============================================================================
// Tool D: prepare_booking
// ============================================================================
export async function handlePrepareBooking({
  callSid,
  providerId,
  startAt,
  endAt,
  patientName,
  patientPhone,
  patientEmail
} = {}) {
  if (!callSid) {
    return { status: 'validation_error', error: 'Missing active callSid.', code: 'MISSING_CALL_SID' };
  }
  if (!providerId || !isValidObjectId(providerId)) {
    return { status: 'validation_error', error: 'Valid providerId is required.', code: 'INVALID_PROVIDER_ID' };
  }
  if (!startAt || !endAt) {
    return { status: 'validation_error', error: 'startAt and endAt are required.', code: 'MISSING_SLOT_INTERVAL' };
  }
  if (!patientName || typeof patientName !== 'string' || patientName.trim().length < 2) {
    return { status: 'validation_error', error: 'Patient name must be at least 2 characters.', code: 'INVALID_PATIENT_NAME' };
  }

  const startDate = new Date(startAt);
  const endDate = new Date(endAt);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) {
    return { status: 'validation_error', error: 'Invalid startAt or endAt interval.', code: 'INVALID_DATE_INTERVAL' };
  }

  if (startDate <= new Date()) {
    return { status: 'validation_error', error: 'Cannot book appointments in the past.', code: 'PAST_SLOT' };
  }

  const provider = await findProviderById(providerId);
  if (!provider || !provider.isActive) {
    return { status: 'not_found', error: 'Provider not found or inactive.', code: 'PROVIDER_INACTIVE' };
  }

  // Verify availability before preparing
  const availableSlots = await getAvailableSlots({
    providerId: provider._id,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString()
  });

  const matchingSlot = availableSlots.find(
    s => new Date(s.startAt).getTime() === startDate.getTime() && new Date(s.endAt).getTime() === endDate.getTime()
  );

  if (!matchingSlot) {
    return {
      status: 'slot_conflict',
      message: 'The requested appointment slot is no longer available. Please offer alternative slots to the caller.',
      code: 'SLOT_UNAVAILABLE'
    };
  }

  const spokenTime = formatSpokenDateTime(startDate.toISOString(), matchingSlot.timezone);
  const phone = patientPhone ? String(patientPhone).trim() : await resolveCallPhone(callSid);

  // Create pending confirmation context bound to the active voice session
  const prepared = await prepareConfirmation({
    callSid,
    action: 'BOOKING',
    payload: {
      providerId: String(provider._id),
      providerName: provider.name,
      specialty: provider.specialty,
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      patient: {
        name: patientName.trim(),
        phone,
        email: patientEmail ? String(patientEmail).trim() : ''
      }
    },
    summary: {
      providerName: provider.name,
      specialty: provider.specialty,
      appointmentTime: spokenTime,
      patientName: patientName.trim()
    }
  });

  return {
    status: 'needs_confirmation',
    confirmationId: prepared.confirmationId,
    action: 'BOOKING',
    summary: prepared.summary,
    message: `Proposed booking prepared for ${provider.name} on ${spokenTime}. Read back these exact details to the caller and obtain explicit confirmation before calling confirm_booking.`
  };
}

// ============================================================================
// Tool E: confirm_booking
// ============================================================================
export async function handleConfirmBooking({ callSid, confirmationId, confirmed } = {}) {
  if (!callSid || !confirmationId) {
    return { status: 'validation_error', error: 'Missing callSid or confirmationId.', code: 'MISSING_PARAMS' };
  }
  if (confirmed !== true && confirmed !== 'true') {
    await cancelActiveConfirmation(callSid, 'caller_declined');
    return {
      status: 'cancelled',
      message: 'The proposed booking was not confirmed and has been cancelled. No appointment was created.'
    };
  }

  try {
    const { context, alreadyCompleted } = await transitionToConfirmed(confirmationId, callSid, 'BOOKING');

    if (alreadyCompleted && context.result) {
      return {
        status: 'success',
        idempotentReplay: true,
        bookingReference: context.result.bookingReference,
        appointment: context.result.appointment,
        message: 'This booking was already confirmed.'
      };
    }

    // Deterministic idempotency key bound to the confirmationId
    const idempotencyKey = `voice-booking-${confirmationId}`;

    const bookingResult = await createBooking({
      providerId: context.payload.providerId,
      startAt: context.payload.startAt,
      endAt: context.payload.endAt,
      patient: context.payload.patient,
      idempotencyKey
    });

    const completedResult = {
      bookingReference: bookingResult.appointment.bookingReference,
      appointmentId: String(bookingResult.appointment._id),
      providerName: context.summary.providerName,
      appointmentTime: context.summary.appointmentTime
    };

    await transitionToCompleted(confirmationId, completedResult);

    return {
      status: 'success',
      bookingReference: bookingResult.appointment.bookingReference,
      providerName: context.summary.providerName,
      appointmentTime: context.summary.appointmentTime,
      idempotentReplay: bookingResult.idempotentReplay,
      message: `Appointment successfully booked! Booking reference is ${bookingResult.appointment.bookingReference} with ${context.summary.providerName} for ${context.summary.appointmentTime}.`
    };
  } catch (err) {
    if (err instanceof ConfirmationError) {
      return {
        status: 'validation_error',
        error: err.message,
        code: err.code
      };
    }
    if (err instanceof BookingConflictError || err.code === 'SLOT_CONFLICT') {
      await transitionToFailed(confirmationId, 'SLOT_CONFLICT', 'conflicted');
      return {
        status: 'slot_conflict',
        error: 'Slot conflict',
        message: 'The requested slot was taken by another reservation just now. Please offer fresh slots to the caller.',
        code: 'SLOT_CONFLICT'
      };
    }
    await transitionToFailed(confirmationId, err.message, 'failed');
    return {
      status: 'failed',
      error: 'Booking failed',
      message: 'An error occurred while booking the appointment. Please try selecting another slot.',
      code: err.code || 'BOOKING_FAILED'
    };
  }
}

// ============================================================================
// Tool F: prepare_cancellation
// ============================================================================
export async function handlePrepareCancellation({
  callSid,
  identifier,
  verificationPhone,
  verificationName,
  reason = 'Caller requested cancellation'
} = {}) {
  if (!callSid || !identifier) {
    return { status: 'validation_error', error: 'Missing callSid or identifier.', code: 'MISSING_PARAMS' };
  }

  const appointment = await getAppointmentStatus(identifier.trim());
  if (!appointment) {
    return { status: 'not_found', error: 'Appointment not found.', code: 'APPOINTMENT_NOT_FOUND' };
  }

  if (appointment.status === 'cancelled') {
    return {
      status: 'validation_error',
      error: 'This appointment is already cancelled.',
      code: 'ALREADY_CANCELLED'
    };
  }

  // Verification check
  const isVerified = verifyCallerForAppointment(appointment, { verificationPhone, verificationName });
  if (!isVerified) {
    return {
      status: 'unauthorized',
      error: 'Verification required to cancel this appointment.',
      code: 'VERIFICATION_REQUIRED'
    };
  }

  const provider = await findProviderById(appointment.providerId);
  const spokenTime = formatSpokenDateTime(appointment.startAt);

  const prepared = await prepareConfirmation({
    callSid,
    action: 'CANCELLATION',
    payload: {
      appointmentId: String(appointment._id),
      bookingReference: appointment.bookingReference,
      reason: String(reason).trim()
    },
    summary: {
      bookingReference: appointment.bookingReference,
      providerName: provider?.name || 'Clinic Physician',
      appointmentTime: spokenTime,
      patientName: appointment.patient?.name || 'Patient'
    }
  });

  return {
    status: 'needs_confirmation',
    confirmationId: prepared.confirmationId,
    action: 'CANCELLATION',
    summary: prepared.summary,
    message: `Cancellation prepared for appointment ${appointment.bookingReference} with ${prepared.summary.providerName} on ${spokenTime}. Read back these details to the caller and obtain explicit approval before calling confirm_cancellation.`
  };
}

// ============================================================================
// Tool G: confirm_cancellation
// ============================================================================
export async function handleConfirmCancellation({ callSid, confirmationId, confirmed } = {}) {
  if (!callSid || !confirmationId) {
    return { status: 'validation_error', error: 'Missing callSid or confirmationId.', code: 'MISSING_PARAMS' };
  }
  if (confirmed !== true && confirmed !== 'true') {
    await cancelActiveConfirmation(callSid, 'caller_declined');
    return {
      status: 'cancelled',
      message: 'Cancellation was declined. The appointment remains confirmed.'
    };
  }

  try {
    const { context, alreadyCompleted } = await transitionToConfirmed(confirmationId, callSid, 'CANCELLATION');

    if (alreadyCompleted) {
      return {
        status: 'success',
        bookingReference: context.payload.bookingReference,
        message: 'This appointment was already cancelled.'
      };
    }

    await cancelBooking(context.payload.appointmentId, {
      reason: context.payload.reason,
      cancelledBy: 'voice_agent'
    });

    await transitionToCompleted(confirmationId, {
      bookingReference: context.payload.bookingReference,
      status: 'cancelled'
    });

    return {
      status: 'success',
      bookingReference: context.payload.bookingReference,
      message: `Appointment ${context.payload.bookingReference} has been successfully cancelled.`
    };
  } catch (err) {
    if (err instanceof ConfirmationError) {
      return { status: 'validation_error', error: err.message, code: err.code };
    }
    await transitionToFailed(confirmationId, err.message, 'failed');
    return { status: 'failed', error: err.message, code: err.code || 'CANCELLATION_FAILED' };
  }
}

// ============================================================================
// Tool H: prepare_reschedule
// ============================================================================
export async function handlePrepareReschedule({
  callSid,
  identifier,
  newStartAt,
  newEndAt,
  verificationPhone,
  verificationName
} = {}) {
  if (!callSid || !identifier || !newStartAt || !newEndAt) {
    return { status: 'validation_error', error: 'Missing callSid, identifier, or new slot interval.', code: 'MISSING_PARAMS' };
  }

  const appointment = await getAppointmentStatus(identifier.trim());
  if (!appointment) {
    return { status: 'not_found', error: 'Original appointment not found.', code: 'APPOINTMENT_NOT_FOUND' };
  }

  if (appointment.status !== 'confirmed') {
    return {
      status: 'validation_error',
      error: `Cannot reschedule appointment with status: "${appointment.status}".`,
      code: 'INVALID_STATUS'
    };
  }

  const isVerified = verifyCallerForAppointment(appointment, { verificationPhone, verificationName });
  if (!isVerified) {
    return {
      status: 'unauthorized',
      error: 'Verification required to reschedule this appointment.',
      code: 'VERIFICATION_REQUIRED'
    };
  }

  const startDate = new Date(newStartAt);
  const endDate = new Date(newEndAt);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) {
    return { status: 'validation_error', error: 'Invalid newStartAt or newEndAt interval.', code: 'INVALID_DATE_INTERVAL' };
  }

  if (startDate <= new Date()) {
    return { status: 'validation_error', error: 'Cannot reschedule to a past time slot.', code: 'PAST_SLOT' };
  }

  const provider = await findProviderById(appointment.providerId);
  const oldSpokenTime = formatSpokenDateTime(appointment.startAt);
  const newSpokenTime = formatSpokenDateTime(startDate.toISOString());

  // Check if proposed new slot is genuinely available
  const availableSlots = await getAvailableSlots({
    providerId: appointment.providerId,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString()
  });

  const matchingSlot = availableSlots.find(
    s => new Date(s.startAt).getTime() === startDate.getTime() && new Date(s.endAt).getTime() === endDate.getTime()
  );

  if (!matchingSlot) {
    return {
      status: 'slot_conflict',
      message: 'The proposed new slot is not available. Please suggest an alternative slot to the caller.',
      code: 'SLOT_UNAVAILABLE'
    };
  }

  const prepared = await prepareConfirmation({
    callSid,
    action: 'RESCHEDULE',
    payload: {
      appointmentId: String(appointment._id),
      bookingReference: appointment.bookingReference,
      newStartAt: startDate.toISOString(),
      newEndAt: endDate.toISOString(),
      providerId: String(appointment.providerId)
    },
    summary: {
      bookingReference: appointment.bookingReference,
      providerName: provider?.name || 'Clinic Physician',
      currentAppointmentTime: oldSpokenTime,
      newAppointmentTime: newSpokenTime
    }
  });

  return {
    status: 'needs_confirmation',
    confirmationId: prepared.confirmationId,
    action: 'RESCHEDULE',
    summary: prepared.summary,
    message: `Reschedule prepared for appointment ${appointment.bookingReference} from ${oldSpokenTime} to ${newSpokenTime}. Read back these details to the caller and obtain explicit approval before calling confirm_reschedule.`
  };
}

// ============================================================================
// Tool I: confirm_reschedule
// ============================================================================
export async function handleConfirmReschedule({ callSid, confirmationId, confirmed } = {}) {
  if (!callSid || !confirmationId) {
    return { status: 'validation_error', error: 'Missing callSid or confirmationId.', code: 'MISSING_PARAMS' };
  }
  if (confirmed !== true && confirmed !== 'true') {
    await cancelActiveConfirmation(callSid, 'caller_declined');
    return {
      status: 'cancelled',
      message: 'Reschedule request was declined. The existing appointment remains unchanged.'
    };
  }

  try {
    const { context, alreadyCompleted } = await transitionToConfirmed(confirmationId, callSid, 'RESCHEDULE');

    if (alreadyCompleted && context.result) {
      return {
        status: 'success',
        bookingReference: context.result.bookingReference,
        newAppointment: context.result.newAppointment,
        message: 'This reschedule was already completed.'
      };
    }

    const idempotencyKey = `voice-reschedule-${confirmationId}`;

    const result = await rescheduleBooking(context.payload.appointmentId, {
      newStartAt: context.payload.newStartAt,
      newEndAt: context.payload.newEndAt,
      idempotencyKey
    });

    const completedResult = {
      bookingReference: result.appointment.bookingReference,
      newAppointmentTime: context.summary.newAppointmentTime,
      providerName: context.summary.providerName
    };

    await transitionToCompleted(confirmationId, completedResult);

    return {
      status: 'success',
      bookingReference: result.appointment.bookingReference,
      newAppointmentTime: context.summary.newAppointmentTime,
      providerName: context.summary.providerName,
      message: `Appointment successfully rescheduled to ${context.summary.newAppointmentTime} with ${context.summary.providerName}. Booking reference is ${result.appointment.bookingReference}.`
    };
  } catch (err) {
    if (err instanceof ConfirmationError) {
      return { status: 'validation_error', error: err.message, code: err.code };
    }
    if (err instanceof BookingConflictError || err.code === 'SLOT_CONFLICT') {
      await transitionToFailed(confirmationId, 'SLOT_CONFLICT', 'conflicted');
      return {
        status: 'slot_conflict',
        error: 'Slot conflict',
        message: 'The new slot was taken by another patient during confirmation. Please select a different slot.',
        code: 'SLOT_CONFLICT'
      };
    }
    await transitionToFailed(confirmationId, err.message, 'failed');
    return { status: 'failed', error: err.message, code: err.code || 'RESCHEDULE_FAILED' };
  }
}
