import express from 'express';
import { requireClinician } from '../middleware/auth.middleware.js';
import { 
  findAvailabilityById, 
  deleteAvailability 
} from '../repositories/availability.repository.js';
import { listAppointments } from '../repositories/appointment.repository.js';

export const availabilityRouter = express.Router();

availabilityRouter.use(requireClinician);

/**
 * DELETE /api/availability/:id
 * Removes an availability window if no confirmed appointments are booked in it.
 */
availabilityRouter.delete('/:id', async (req, res, next) => {
  try {
    const window = await findAvailabilityById(req.params.id);
    if (!window) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Availability window not found.',
        status: 404
      });
    }

    // Safety check: Ensure no confirmed appointments are scheduled within this window
    const existingBookings = await listAppointments({
      providerId: window.providerId,
      status: 'confirmed',
      startDate: window.startAt,
      endDate: window.endAt
    });

    if (existingBookings.length > 0) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Cannot remove availability window that contains confirmed patient appointments.',
        status: 400
      });
    }

    await deleteAvailability(window._id);

    res.status(200).json({
      status: 'success',
      message: 'Availability window successfully deleted.'
    });
  } catch (err) {
    next(err);
  }
});
