import express from 'express';
import { requireClinician } from '../middleware/auth.middleware.js';
import { getAvailableSlots } from '../services/slot.service.js';
import { 
  createBooking, 
  cancelBooking, 
  rescheduleBooking, 
  getAppointmentStatus 
} from '../services/booking.service.js';
import { listAppointments } from '../repositories/appointment.repository.js';

export const appointmentRouter = express.Router();

appointmentRouter.use(requireClinician);

/**
 * GET /api/appointments/slots
 * Generates valid, available appointment slots within a date range.
 */
appointmentRouter.get('/slots', async (req, res, next) => {
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
 * POST /api/appointments
 * Creates an appointment booking with concurrency protection and idempotency handling.
 */
appointmentRouter.post('/', async (req, res, next) => {
  try {
    const { providerId, startAt, endAt, patient } = req.body || {};
    // Extract idempotency key from request body or HTTP header
    const idempotencyKey = req.body?.idempotencyKey || req.headers['idempotency-key'] || null;

    if (!providerId || !startAt || !endAt || !patient) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'providerId, startAt, endAt, and patient details are required.',
        status: 400
      });
    }

    const result = await createBooking({
      providerId,
      startAt,
      endAt,
      patient,
      idempotencyKey
    });

    const statusCode = result.idempotentReplay ? 200 : 201;

    res.status(statusCode).json({
      status: 'success',
      message: result.idempotentReplay 
        ? 'Idempotent request: returning existing confirmed booking.' 
        : 'Appointment confirmed successfully.',
      data: result.appointment,
      idempotentReplay: result.idempotentReplay
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.name || 'BookingError',
        message: err.message,
        code: err.code || 'BOOKING_FAILED',
        status: err.statusCode
      });
    }
    next(err);
  }
});

/**
 * GET /api/appointments
 * Lists appointments with optional filters.
 */
appointmentRouter.get('/', async (req, res, next) => {
  try {
    const { providerId, status, startDate, endDate } = req.query;
    const list = await listAppointments({
      providerId,
      status,
      startDate,
      endDate
    });

    res.status(200).json({
      status: 'success',
      count: list.length,
      data: list
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/appointments/:id
 * Retrieves appointment details by ID or booking reference.
 */
appointmentRouter.get('/:id', async (req, res, next) => {
  try {
    const appt = await getAppointmentStatus(req.params.id);
    if (!appt) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Appointment not found.',
        status: 404
      });
    }

    res.status(200).json({
      status: 'success',
      data: appt
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/appointments/:id/cancel
 * Cancels a confirmed booking.
 */
appointmentRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const result = await cancelBooking(req.params.id, { reason, cancelledBy: 'clinician' });

    res.status(200).json({
      status: 'success',
      message: result.alreadyCancelled 
        ? 'Appointment was already cancelled.' 
        : 'Appointment cancelled successfully.',
      data: result.appointment
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
 * POST /api/appointments/:id/reschedule
 * Reschedules an appointment to a new time slot with transactional conflict protection.
 */
appointmentRouter.post('/:id/reschedule', async (req, res, next) => {
  try {
    const { newStartAt, newEndAt } = req.body || {};
    const idempotencyKey = req.body?.idempotencyKey || req.headers['idempotency-key'] || null;

    if (!newStartAt || !newEndAt) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'newStartAt and newEndAt are required.',
        status: 400
      });
    }

    const result = await rescheduleBooking(req.params.id, {
      newStartAt,
      newEndAt,
      idempotencyKey
    });

    res.status(200).json({
      status: 'success',
      message: 'Appointment successfully rescheduled.',
      originalAppointmentId: result.originalAppointmentId,
      data: result.appointment
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
