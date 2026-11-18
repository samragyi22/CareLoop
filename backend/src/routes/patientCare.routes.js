import express from 'express';
import { findPatientRecordByUserId } from '../repositories/patient.repository.js';
import { reportProblemAsPatient } from '../services/patientActions.service.js';
import { getPatientCarePlans } from '../services/patientCarePlan.service.js';
import { respondAsPatient } from '../services/approval.service.js';
import { submitDocument } from '../services/documentSubmission.service.js';
import { sendCarePlanError } from './carePlan.routes.js';

/**
 * The patient's own care plans ("My care plan"), mounted at /api/patient/care behind patient login.
 * Every action is limited to the patient record linked to the logged-in account.
 */
export const patientCareRouter = express.Router();

function patientActor(req) {
  return { type: 'patient', id: req.patient._id, name: req.patient.name };
}

async function patientRecordFor(req, res) {
  const record = await findPatientRecordByUserId(req.patient._id);
  if (!record) {
    res.status(404).json({ error: 'NotFound', code: 'NO_PATIENT_RECORD', message: 'No care plan is linked to this account yet.', status: 404 });
    return null;
  }
  return record;
}

/**
 * GET /api/patient/care/plans
 */
patientCareRouter.get('/plans', async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await getPatientCarePlans(req.patient._id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/patient/care/approvals/:id/respond
 * Body: { decision: 'confirm' | 'decline', note }
 */
patientCareRouter.post('/approvals/:id/respond', async (req, res, next) => {
  try {
    const record = await patientRecordFor(req, res);
    if (!record) return;
    const { decision, note } = req.body || {};
    const result = await respondAsPatient({
      approvalId: req.params.id,
      decision,
      note,
      actor: patientActor(req),
      patientRecordId: record._id
    });
    res.json({
      status: 'success',
      data: {
        executed: Boolean(result.executed),
        status: result.approval?.status || null,
        failure: result.failure ? { message: 'That time could not be booked. The clinic will offer another option.' } : null,
        emergency: result.emergency || null
      }
    });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/patient/care/tasks/:id/documents
 * Body: { fileName, mimeType, contentBase64 }
 */
patientCareRouter.post('/tasks/:id/documents', async (req, res, next) => {
  try {
    const record = await patientRecordFor(req, res);
    if (!record) return;
    const { fileName, mimeType, contentBase64 } = req.body || {};
    const submission = await submitDocument({
      taskId: req.params.id,
      fileName,
      mimeType,
      contentBase64,
      actor: patientActor(req),
      patientRecordId: record._id
    });
    res.status(201).json({ status: 'success', data: { _id: submission._id, fileName: submission.fileName, status: submission.status } });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/patient/care/tasks/:id/barriers
 * Body: { problem: 'cant_get_there' | 'no_document' | 'timing' | 'other', detail, maxTravelKm?, hasOwnTransport? }
 */
patientCareRouter.post('/tasks/:id/barriers', async (req, res, next) => {
  try {
    const record = await patientRecordFor(req, res);
    if (!record) return;
    const { problem, detail, maxTravelKm, hasOwnTransport } = req.body || {};
    const result = await reportProblemAsPatient({
      patient: record,
      taskId: req.params.id,
      problem,
      detail,
      maxTravelKm,
      hasOwnTransport,
      actor: patientActor(req)
    });
    res.status(201).json({ status: 'success', data: { recorded: true, emergency: result.emergency, sentToDoctor: result.sentToDoctor } });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});
