import { ObjectId } from 'mongodb';
import { getClient, getDb } from '../config/db.js';
import { findProviderById } from '../repositories/provider.repository.js';
import { findAvailabilityByProvider } from '../repositories/availability.repository.js';
import { findUserByEmail, findUserById, findActivePatientUsersByPhone } from '../repositories/user.repository.js';
import { normalizeE164Phone } from '../repositories/callbackConsent.repository.js';
import {
  findOverlappingAppointment,
  findAppointmentByIdempotencyKey,
  insertAppointment,
  findAppointmentById,
  findAppointmentByReference,
  updateAppointmentStatus,
  generateBookingReference
} from '../repositories/appointment.repository.js';

export class BookingConflictError extends Error {
  constructor(message = 'The requested slot is already booked or conflicts with an existing appointment.') {
    super(message);
    this.name = 'BookingConflictError';
    this.statusCode = 409;
    this.code = 'SLOT_CONFLICT';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency key has already been used with different booking parameters.') {
    super(message);
    this.name = 'IdempotencyConflictError';
    this.statusCode = 409;
    this.code = 'IDEMPOTENCY_CONFLICT';
  }
}

/**
 * Validates that an interval falls entirely within an active availability window for the provider.
 */
async function validateSlotWithinAvailability(providerId, startAt, endAt) {
  const windows = await findAvailabilityByProvider(providerId);
  const sTime = startAt.getTime();
  const eTime = endAt.getTime();

  const isCovered = windows.some(win => {
    const wStart = new Date(win.startAt).getTime();
    const wEnd = new Date(win.endAt).getTime();
    return sTime >= wStart && eTime <= wEnd;
  });

  return isCovered;
}

function namesMatch(a, b) {
  const clean = (value) => String(value || '').toLowerCase().replace(/[^a-zऀ-ॿ\s]/g, ' ').split(/\s+/).filter(Boolean);
  const first = clean(a)[0];
  return Boolean(first) && clean(b).includes(first);
}

/**
 * Resolves the patient account an appointment belongs to, so it appears in that patient's portal.
 * Order: explicit account ID, exact email match, then phone match only when exactly one
 * account uses that phone and the names agree (family phones are commonly shared).
 */
async function resolvePatientUserId({ patientUserId, patient }) {
  if (patientUserId) {
    const user = await findUserById(patientUserId);
    return user && user.role === 'patient' ? user._id : null;
  }

  const email = patient?.email ? String(patient.email).trim().toLowerCase() : '';
  if (email) {
    const user = await findUserByEmail(email);
    if (user && user.role === 'patient' && user.isActive) return user._id;
  }

  const phone = normalizeE164Phone(patient?.phone);
  if (phone) {
    const candidates = await findActivePatientUsersByPhone(phone);
    if (candidates.length === 1 && namesMatch(patient.name, candidates[0].name)) {
      return candidates[0]._id;
    }
  }

  return null;
}

/**
 * Creates an appointment with ACID transaction concurrency protection and database-enforced idempotency.
 */
export async function createBooking({
  providerId,
  startAt,
  endAt,
  patient,
  patientUserId = null,
  idempotencyKey = null
}) {
  if (!providerId) {
    const err = new Error('Provider ID is required');
    err.statusCode = 400;
    err.code = 'INVALID_PROVIDER_ID';
    throw err;
  }
  if (!startAt || !endAt) {
    const err = new Error('startAt and endAt are required');
    err.statusCode = 400;
    err.code = 'MISSING_SLOT_INTERVAL';
    throw err;
  }
  if (!patient || !patient.name || !patient.name.trim()) {
    const err = new Error('Patient name is required');
    err.statusCode = 400;
    err.code = 'MISSING_PATIENT_INFO';
    throw err;
  }

  const startDate = new Date(startAt);
  const endDate = new Date(endAt);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    const err = new Error('Invalid startAt or endAt date format');
    err.statusCode = 400;
    err.code = 'INVALID_DATE_FORMAT';
    throw err;
  }

  if (endDate <= startDate) {
    const err = new Error('endAt must be strictly after startAt');
    err.statusCode = 400;
    err.code = 'INVALID_TIME_INTERVAL';
    throw err;
  }

  const now = new Date();
  if (startDate <= now) {
    const err = new Error('Cannot book an appointment in the past');
    err.statusCode = 400;
    err.code = 'PAST_SLOT_NOT_ALLOWED';
    throw err;
  }

  // The four lookups below are independent, so they run at the same time (on a distant database this
  // saves several round trips per booking); their checks are still applied in the original order
  const trimmedKey = idempotencyKey && typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;
  const [provider, isAvailable, existingForKey, linkedPatientUserId] = await Promise.all([
    findProviderById(providerId),
    validateSlotWithinAvailability(providerId, startDate, endDate),
    trimmedKey ? findAppointmentByIdempotencyKey(trimmedKey) : null,
    resolvePatientUserId({ patientUserId, patient })
  ]);

  // 1. Verify provider existence and active status
  if (!provider) {
    const err = new Error('Provider not found');
    err.statusCode = 404;
    err.code = 'PROVIDER_NOT_FOUND';
    throw err;
  }
  if (!provider.isActive) {
    const err = new Error('Provider is currently inactive and cannot accept bookings');
    err.statusCode = 400;
    err.code = 'PROVIDER_INACTIVE';
    throw err;
  }

  // 2. Verify slot falls within active availability window
  if (!isAvailable) {
    const err = new Error('Requested appointment interval is outside of the provider available schedule');
    err.statusCode = 400;
    err.code = 'OUTSIDE_AVAILABILITY';
    throw err;
  }

  // 3. Upfront Idempotency Check
  if (trimmedKey) {
    const existing = existingForKey;
    if (existing) {
      const sameProvider = String(existing.providerId) === String(provider._id);
      const sameStart = new Date(existing.startAt).getTime() === startDate.getTime();
      const sameEnd = new Date(existing.endAt).getTime() === endDate.getTime();
      const samePatientName = existing.patient?.name?.toLowerCase().trim() === patient.name?.toLowerCase().trim();

      if (sameProvider && sameStart && sameEnd && samePatientName) {
        // Enforce safe replay: do not replay cancelled or rescheduled appointments as confirmed
        if (existing.status !== 'confirmed') {
          const inactiveErr = new Error('Idempotency key has already been used for an appointment that is no longer active.');
          inactiveErr.statusCode = 409;
          inactiveErr.code = 'IDEMPOTENCY_INACTIVE';
          throw inactiveErr;
        }
        return {
          appointment: existing,
          idempotentReplay: true
        };
      } else {
        throw new IdempotencyConflictError();
      }
    }
  }

  // 4. Link to the patient's account when it can be identified unambiguously (looked up above)

  // 5. Concurrency-Safe Transactional Reservation
  const client = getClient();
  let session = null;

  try {
    session = client.startSession();
  } catch (sessErr) {
    console.warn('[Booking] Could not start session, falling back to atomic check:', sessErr.message);
  }

  const bookingRef = generateBookingReference();
  let createdAppointment = null;
  let concurrentReplayResult = null;

  const executeBookingOperation = async (sess) => {
    // Check for conflicting confirmed appointment
    const conflict = await findOverlappingAppointment(provider._id, startDate, endDate, { session: sess });
    if (conflict) {
      if (idempotencyKey && conflict.idempotencyKey === idempotencyKey.trim()) {
        const sameProvider = String(conflict.providerId) === String(provider._id);
        const sameStart = new Date(conflict.startAt).getTime() === startDate.getTime();
        const sameEnd = new Date(conflict.endAt).getTime() === endDate.getTime();
        const samePatientName = conflict.patient?.name?.toLowerCase().trim() === patient.name?.toLowerCase().trim();

        if (sameProvider && sameStart && sameEnd && samePatientName) {
          if (conflict.status !== 'confirmed') {
            const inactiveErr = new Error('Idempotency key has already been used for an appointment that is no longer active.');
            inactiveErr.statusCode = 409;
            inactiveErr.code = 'IDEMPOTENCY_INACTIVE';
            throw inactiveErr;
          }
          concurrentReplayResult = {
            appointment: conflict,
            idempotentReplay: true
          };
          return;
        } else {
          throw new IdempotencyConflictError();
        }
      }
      throw new BookingConflictError();
    }

    // Insert new confirmed appointment
    const newDoc = {
      bookingReference: bookingRef,
      providerId: new ObjectId(provider._id),
      patientUserId: linkedPatientUserId,
      patient: {
        name: patient.name.trim(),
        phone: (patient.phone || '').trim(),
        email: (patient.email || '').trim().toLowerCase(),
        ...(patient.isSynthetic === true ? { isSynthetic: true } : {})
      },
      startAt: startDate,
      endAt: endDate,
      status: 'confirmed',
      idempotencyKey: idempotencyKey ? idempotencyKey.trim() : null
    };

    createdAppointment = await insertAppointment(newDoc, { session: sess });
  };

  if (session) {
    try {
      await session.withTransaction(async () => {
        await executeBookingOperation(session);
      });
    } catch (txnErr) {
      // Prioritize idempotency recovery for concurrent duplicate requests
      if (idempotencyKey) {
        const existing = await findAppointmentByIdempotencyKey(idempotencyKey.trim());
        if (existing) {
          const sameProvider = String(existing.providerId) === String(provider._id);
          const sameStart = new Date(existing.startAt).getTime() === startDate.getTime();
          const sameEnd = new Date(existing.endAt).getTime() === endDate.getTime();
          const samePatientName = existing.patient?.name?.toLowerCase().trim() === patient.name?.toLowerCase().trim();

          if (sameProvider && sameStart && sameEnd && samePatientName) {
            if (existing.status !== 'confirmed') {
              const inactiveErr = new Error('Idempotency key has already been used for an appointment that is no longer active.');
              inactiveErr.statusCode = 409;
              inactiveErr.code = 'IDEMPOTENCY_INACTIVE';
              throw inactiveErr;
            }
            concurrentReplayResult = {
              appointment: existing,
              idempotentReplay: true
            };
          } else {
            throw new IdempotencyConflictError();
          }
        }
      }

      if (concurrentReplayResult) {
        // Idempotency replay successfully recovered
      } else if (txnErr.name === 'BookingConflictError' || txnErr.code === 'SLOT_CONFLICT') {
        throw txnErr;
      } else if (txnErr.message && (txnErr.message.includes('WriteConflict') || txnErr.code === 112)) {
        throw new BookingConflictError();
      } else if (
        txnErr.code === 11000 || (txnErr.message && txnErr.message.includes('E11000'))
      ) {
        throw new BookingConflictError();
      } else {
        throw txnErr;
      }
    } finally {
      await session.endSession();
    }
  } else {
    try {
      await executeBookingOperation(null);
    } catch (err) {
      if (
        (err.code === 11000 || (err.message && err.message.includes('E11000'))) &&
        idempotencyKey
      ) {
        const existing = await findAppointmentByIdempotencyKey(idempotencyKey.trim());
        if (existing) {
          const sameProvider = String(existing.providerId) === String(provider._id);
          const sameStart = new Date(existing.startAt).getTime() === startDate.getTime();
          const sameEnd = new Date(existing.endAt).getTime() === endDate.getTime();
          const samePatientName = existing.patient?.name?.toLowerCase().trim() === patient.name?.toLowerCase().trim();

          if (sameProvider && sameStart && sameEnd && samePatientName) {
            if (existing.status !== 'confirmed') {
              const inactiveErr = new Error('Idempotency key has already been used for an appointment that is no longer active.');
              inactiveErr.statusCode = 409;
              inactiveErr.code = 'IDEMPOTENCY_INACTIVE';
              throw inactiveErr;
            }
            return {
              appointment: existing,
              idempotentReplay: true
            };
          } else {
            throw new IdempotencyConflictError();
          }
        }
      } else if (
        err.code === 11000 || (err.message && err.message.includes('E11000'))
      ) {
        throw new BookingConflictError();
      }
      throw err;
    }
  }

  if (concurrentReplayResult) {
    return concurrentReplayResult;
  }

  return {
    appointment: createdAppointment,
    idempotentReplay: false
  };
}

/**
 * Cancels an existing appointment, recording who cancelled it and why.
 * cancelledBy: 'clinician' | 'patient' | 'voice_agent' | 'system'
 */
export async function cancelBooking(id, { reason = '', cancelledBy = null } = {}) {
  const appointment = await findAppointmentById(id);
  if (!appointment) {
    const err = new Error('Appointment not found');
    err.statusCode = 404;
    err.code = 'APPOINTMENT_NOT_FOUND';
    throw err;
  }

  if (appointment.status === 'cancelled') {
    return { appointment, alreadyCancelled: true };
  }

  const updated = await updateAppointmentStatus(appointment._id, 'cancelled', {
    cancelledAt: new Date(),
    cancellationReason: reason || null,
    cancelledBy
  });

  return { appointment: updated, alreadyCancelled: false };
}

/**
 * Reschedules an appointment to a new slot with transaction conflict prevention.
 */
export async function rescheduleBooking(id, { newStartAt, newEndAt, idempotencyKey = null }) {
  const existing = await findAppointmentById(id);
  if (!existing) {
    const err = new Error('Original appointment not found');
    err.statusCode = 404;
    err.code = 'ORIGINAL_APPOINTMENT_NOT_FOUND';
    throw err;
  }

  if (existing.status !== 'confirmed') {
    const err = new Error(`Cannot reschedule an appointment with status: "${existing.status}"`);
    err.statusCode = 400;
    err.code = 'INVALID_STATUS_FOR_RESCHEDULE';
    throw err;
  }

  const startDate = new Date(newStartAt);
  const endDate = new Date(newEndAt);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    const err = new Error('Invalid newStartAt or newEndAt date format');
    err.statusCode = 400;
    err.code = 'INVALID_DATE_FORMAT';
    throw err;
  }

  if (endDate <= startDate) {
    const err = new Error('newEndAt must be strictly after newStartAt');
    err.statusCode = 400;
    err.code = 'INVALID_TIME_INTERVAL';
    throw err;
  }

  const now = new Date();
  if (startDate <= now) {
    const err = new Error('Cannot reschedule to a past time slot');
    err.statusCode = 400;
    err.code = 'PAST_SLOT_NOT_ALLOWED';
    throw err;
  }

  // Validate provider and availability for new slot
  const provider = await findProviderById(existing.providerId);
  if (!provider || !provider.isActive) {
    const err = new Error('Provider is no longer active');
    err.statusCode = 400;
    err.code = 'PROVIDER_INACTIVE';
    throw err;
  }

  const isAvailable = await validateSlotWithinAvailability(provider._id, startDate, endDate);
  if (!isAvailable) {
    const err = new Error('New slot is outside provider available schedule');
    err.statusCode = 400;
    err.code = 'OUTSIDE_AVAILABILITY';
    throw err;
  }

  const client = getClient();
  let session = null;
  try {
    session = client.startSession();
  } catch (_) {}

  let newAppointment = null;
  const newRef = generateBookingReference();

  const executeReschedule = async (sess) => {
    // Check conflict at new time (excluding old appointment)
    const conflict = await findOverlappingAppointment(provider._id, startDate, endDate, {
      excludeId: existing._id,
      session: sess
    });

    if (conflict) {
      throw new BookingConflictError('New time slot is already booked');
    }

    // Cancel old appointment
    await updateAppointmentStatus(existing._id, 'cancelled', {
      cancelledAt: new Date(),
      cancellationReason: 'Rescheduled to a new slot',
      cancelledBy: 'system',
      session: sess
    });

    // Create new appointment referencing old
    const newDoc = {
      bookingReference: newRef,
      providerId: new ObjectId(provider._id),
      patientUserId: existing.patientUserId ? new ObjectId(existing.patientUserId) : null,
      patient: existing.patient,
      startAt: startDate,
      endAt: endDate,
      status: 'confirmed',
      rescheduledFrom: new ObjectId(existing._id),
      idempotencyKey: idempotencyKey ? idempotencyKey.trim() : null
    };

    // Serialize provider transaction writes by touching provider document
    const db = getDb();
    if (db && sess) {
      await db.collection('providers').updateOne(
        { _id: new ObjectId(provider._id) },
        { $set: { updatedAt: new Date() } },
        { session: sess }
      );
    }

    newAppointment = await insertAppointment(newDoc, { session: sess });
  };

  if (session) {
    try {
      await session.withTransaction(async () => {
        await executeReschedule(session);
      });
    } catch (txnErr) {
      if (txnErr.name === 'BookingConflictError' || txnErr.code === 'SLOT_CONFLICT') {
        throw txnErr;
      }
      if (txnErr.message && (txnErr.message.includes('WriteConflict') || txnErr.code === 112)) {
        throw new BookingConflictError('New time slot is already booked');
      }
      if (txnErr.code === 11000 || (txnErr.message && txnErr.message.includes('E11000'))) {
        throw new BookingConflictError('New time slot is already booked');
      }
      if (txnErr.statusCode) {
        throw txnErr;
      }
      throw txnErr;
    } finally {
      await session.endSession();
    }
  } else {
    try {
      await executeReschedule(null);
    } catch (err) {
      if (err.name === 'BookingConflictError' || err.code === 'SLOT_CONFLICT') {
        throw err;
      }
      if (err.code === 11000 || (err.message && err.message.includes('E11000'))) {
        throw new BookingConflictError('New time slot is already booked');
      }
      throw err;
    }
  }

  return {
    originalAppointmentId: existing._id,
    appointment: newAppointment
  };
}

/**
 * Retrieves appointment by ID or booking reference.
 */
export async function getAppointmentStatus(identifier) {
  if (!identifier) return null;
  let appt = null;

  try {
    appt = await findAppointmentById(identifier);
  } catch (_) {}

  if (!appt) {
    appt = await findAppointmentByReference(identifier);
  }

  return appt;
}
