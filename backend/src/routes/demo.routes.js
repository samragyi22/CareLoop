import express from 'express';
import { requireClinician } from '../middleware/auth.middleware.js';
import {
  assertDemoAllowed,
  getDemoStatus,
  armDemoFault,
  clearDemoFaults,
  simulatePatientReply,
  simulateMissedCalls,
  simulateDocumentUpload,
  simulatePatientReport,
  resetDemoData
} from '../services/demo.service.js';
import { sendCarePlanError } from './carePlan.routes.js';

/**
 * Demo Lab (/api/demo): simulated patient behaviour, failure switches, and reset.
 * Clinician only, and refused outright in production.
 */
export const demoRouter = express.Router();

demoRouter.use(requireClinician);
demoRouter.use((req, res, next) => {
  try {
    assertDemoAllowed();
    next();
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

const handle = (work) => async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await work(req) });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
};

demoRouter.get('/status', handle(() => getDemoStatus()));
demoRouter.post('/faults', handle(req => armDemoFault(req.body?.name, req.body?.times)));
demoRouter.post('/faults/clear', handle(() => clearDemoFaults()));
demoRouter.post('/approvals/:id/reply', handle(req => simulatePatientReply(req.params.id, req.body?.decision)));
demoRouter.post('/patients/:id/missed-calls', handle(req => simulateMissedCalls(req.params.id, req.body?.count)));
demoRouter.post('/tasks/:id/upload', handle(req => simulateDocumentUpload(req.params.id)));
demoRouter.post('/tasks/:id/report', handle(req => simulatePatientReport(req.params.id, req.body || {})));
demoRouter.post('/reset', handle(() => resetDemoData()));
