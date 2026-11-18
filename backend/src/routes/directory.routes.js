import express from 'express';
import { requireClinician } from '../middleware/auth.middleware.js';
import { listFacilities } from '../repositories/serviceDirectory.repository.js';

/**
 * GET /api/directory?category=clinic|lab
 * Service directory used by PlanPilot. Every entry in this prototype is simulated.
 */
export const directoryRouter = express.Router();

directoryRouter.use(requireClinician);

directoryRouter.get('/', async (req, res, next) => {
  try {
    const facilities = await listFacilities({ category: req.query.category });
    res.json({
      status: 'success',
      count: facilities.length,
      notice: 'SIMULATED DIRECTORY: facilities, locations, and hours are synthetic demonstration data.',
      data: facilities
    });
  } catch (err) {
    next(err);
  }
});
