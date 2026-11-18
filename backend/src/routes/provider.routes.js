import express from 'express';
import { requireClinician } from '../middleware/auth.middleware.js';
import { 
  createProvider, 
  findProviders, 
  findProviderById, 
  updateProvider 
} from '../repositories/provider.repository.js';
import { 
  createAvailability, 
  findAvailabilityByProvider 
} from '../repositories/availability.repository.js';

export const providerRouter = express.Router();

// Require clinician authentication on all provider and schedule operations
providerRouter.use(requireClinician);

/**
 * POST /api/providers
 * Creates a new healthcare provider.
 */
providerRouter.post('/', async (req, res, next) => {
  try {
    const { name, specialty, isActive } = req.body || {};
    if (!name || !specialty) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Name and specialty are required.',
        status: 400
      });
    }

    const provider = await createProvider({ name, specialty, isActive });
    res.status(201).json({
      status: 'success',
      data: provider
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/providers
 * Lists all providers with optional filters.
 */
providerRouter.get('/', async (req, res, next) => {
  try {
    const { specialty, isActive } = req.query;
    const filter = {};
    if (specialty) filter.specialty = specialty;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const list = await findProviders(filter);
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
 * GET /api/providers/:id
 * Retrieves a single provider by ID.
 */
providerRouter.get('/:id', async (req, res, next) => {
  try {
    const provider = await findProviderById(req.params.id);
    if (!provider) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Provider not found.',
        status: 404
      });
    }

    res.status(200).json({
      status: 'success',
      data: provider
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/providers/:id
 * Updates provider name, specialty, or active status.
 */
providerRouter.patch('/:id', async (req, res, next) => {
  try {
    const existing = await findProviderById(req.params.id);
    if (!existing) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Provider not found.',
        status: 404
      });
    }

    const updated = await updateProvider(req.params.id, req.body || {});
    res.status(200).json({
      status: 'success',
      data: updated
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/providers/:id/availability
 * Adds an availability window for the provider.
 */
providerRouter.post('/:id/availability', async (req, res, next) => {
  try {
    const provider = await findProviderById(req.params.id);
    if (!provider) {
      return res.status(404).json({
        error: 'NotFound',
        message: 'Provider not found.',
        status: 404
      });
    }
    if (!provider.isActive) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'Cannot add availability to an inactive provider.',
        status: 400
      });
    }

    const { startAt, endAt, timezone } = req.body || {};
    if (!startAt || !endAt) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'startAt and endAt are required.',
        status: 400
      });
    }

    const availability = await createAvailability({
      providerId: provider._id,
      startAt,
      endAt,
      timezone
    });

    res.status(201).json({
      status: 'success',
      data: availability
    });
  } catch (err) {
    if (err.code === 'OVERLAPPING_AVAILABILITY') {
      return res.status(409).json({
        error: 'Conflict',
        message: err.message,
        status: 409
      });
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.name || 'BadRequest',
        message: err.message,
        code: err.code,
        status: err.statusCode
      });
    }
    next(err);
  }
});

/**
 * GET /api/providers/:id/availability
 * Lists availability windows for the specified provider.
 */
providerRouter.get('/:id/availability', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const windows = await findAvailabilityByProvider(req.params.id, { startDate, endDate });
    res.status(200).json({
      status: 'success',
      count: windows.length,
      data: windows
    });
  } catch (err) {
    next(err);
  }
});
