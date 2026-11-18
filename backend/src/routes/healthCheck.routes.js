import express from 'express';
import { requireClinician } from '../middleware/auth.middleware.js';
import { listHealthChecks, markHealthCheckReviewed, getProtocolInfo } from '../services/symptomCheck.service.js';
import { clinicianActor, sendCarePlanError } from './carePlan.routes.js';

/**
 * Phone health checks (/api/health-checks): results of symptom checks done on calls.
 */
export const healthCheckRouter = express.Router();

healthCheckRouter.use(requireClinician);

healthCheckRouter.get('/', async (req, res, next) => {
  try {
    res.json({ status: 'success', data: { checks: await listHealthChecks(), protocol: getProtocolInfo() } });
  } catch (err) {
    next(err);
  }
});

healthCheckRouter.post('/:id/review', async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await markHealthCheckReviewed(req.params.id, clinicianActor(req)) });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});
