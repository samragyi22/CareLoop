import express from 'express';
import { requireClinician } from '../middleware/auth.middleware.js';
import { getReviewQueue } from '../services/reviewQueue.service.js';
import { decideAsClinician, respondAsPatient, cancelApproval } from '../services/approval.service.js';
import { reviewDocumentSubmission } from '../services/documentSubmission.service.js';
import { findSubmissionFile } from '../repositories/documentSubmission.repository.js';
import { clinicianActor, sendCarePlanError } from './carePlan.routes.js';

/**
 * PlanPilot review and approvals (clinician workspace).
 *   /api/review-queue          - everything waiting on a person
 *   /api/approvals             - clinician decisions, patient answers recorded by staff, withdrawals
 *   /api/document-submissions  - view and verify documents patients submitted
 */
export const reviewQueueRouter = express.Router();
export const approvalRouter = express.Router();
export const documentSubmissionRouter = express.Router();

reviewQueueRouter.use(requireClinician);
approvalRouter.use(requireClinician);
documentSubmissionRouter.use(requireClinician);

/**
 * GET /api/review-queue
 */
reviewQueueRouter.get('/', async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await getReviewQueue() });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/approvals/:id/decision
 * Body: { decision: 'approve' | 'reject', note }
 */
approvalRouter.post('/:id/decision', async (req, res, next) => {
  try {
    const { decision, note } = req.body || {};
    const result = await decideAsClinician({ approvalId: req.params.id, decision, note, actor: clinicianActor(req) });
    res.json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/approvals/:id/patient-response
 * Body: { decision: 'confirm' | 'decline', note }. Staff recording what the patient said (e.g. on
 * the phone); the note is required and the answer is logged as recorded by this clinician.
 */
approvalRouter.post('/:id/patient-response', async (req, res, next) => {
  try {
    const { decision, note } = req.body || {};
    const result = await respondAsPatient({ approvalId: req.params.id, decision, note, actor: clinicianActor(req) });
    res.json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/approvals/:id/cancel
 * Body: { reason }
 */
approvalRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const result = await cancelApproval({ approvalId: req.params.id, reason: req.body?.reason, actor: clinicianActor(req) });
    res.json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/document-submissions/:id/review
 * Body: { decision: 'verify' | 'reject', note }
 */
documentSubmissionRouter.post('/:id/review', async (req, res, next) => {
  try {
    const { decision, note } = req.body || {};
    const result = await reviewDocumentSubmission({ submissionId: req.params.id, decision, note, actor: clinicianActor(req) });
    res.json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * GET /api/document-submissions/:id/file
 * Streams the submitted file for review, sandboxed so it can never run scripts in the app's origin.
 */
documentSubmissionRouter.get('/:id/file', async (req, res, next) => {
  try {
    const file = await findSubmissionFile(req.params.id);
    if (!file) {
      return res.status(404).json({ error: 'NotFound', message: 'Document not found.', status: 404 });
    }
    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': String(file.content.length),
      'Content-Disposition': `inline; filename="${file.fileName.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, no-store'
    });
    res.send(file.content);
  } catch (err) {
    next(err);
  }
});
