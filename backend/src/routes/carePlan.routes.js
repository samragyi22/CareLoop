import express from 'express';
import { requireClinician } from '../middleware/auth.middleware.js';
import { CARE_PLAN_TEMPLATES } from '../config/carePlanTemplates.js';
import {
  createCarePlan,
  getCarePlanDetail,
  listCarePlanSummaries,
  transitionTask,
  recordEvidence
} from '../services/carePlan.service.js';
import {
  TASK_STATUS_LABELS,
  TASK_TYPES,
  TASK_OWNERS,
  EVIDENCE_TYPES
} from '../services/taskStateMachine.js';
import { BARRIER_CODES, MODALITY_LABELS, DOCUMENT_LABELS } from '../services/feasibilityRules.js';
import {
  runTaskFeasibilityCheck,
  runPlanFeasibilityCheck,
  reportBarrier,
  resolveTaskBarrier
} from '../services/feasibility.service.js';
import { chooseAlternative, proposePlannedBooking, APPROVAL_STATUS_LABELS } from '../services/approval.service.js';
import { submitDocument } from '../services/documentSubmission.service.js';
import { runAgentForPlan, listAgentRuns, getAgentStatus } from '../services/orchestrator.service.js';

/**
 * PlanPilot care plans and tasks (clinician workspace).
 *   /api/care-plans  - templates, list, create, detail, plan-wide feasibility check
 *   /api/care-tasks  - status transitions, evidence, feasibility checks, barriers, choosing an
 *                      option for approval, documents submitted on the patient's behalf
 */
export const carePlanRouter = express.Router();
export const careTaskRouter = express.Router();

carePlanRouter.use(requireClinician);
careTaskRouter.use(requireClinician);

export function clinicianActor(req) {
  return { type: 'clinician', id: req.user._id, name: req.user.name };
}

export function sendCarePlanError(res, err, next) {
  if (err.name === 'CarePlanError') {
    return res.status(err.statusCode).json({
      error: err.name,
      code: err.code,
      message: err.message,
      details: err.details,
      status: err.statusCode
    });
  }
  return next(err);
}

/**
 * GET /api/care-plans/meta
 * Labels and vocabularies the UI needs to display plans honestly.
 */
carePlanRouter.get('/meta', (req, res) => {
  res.json({
    status: 'success',
    data: {
      statusLabels: TASK_STATUS_LABELS,
      taskTypes: TASK_TYPES,
      evidenceTypes: EVIDENCE_TYPES,
      owners: TASK_OWNERS,
      barrierCodes: BARRIER_CODES,
      modalityLabels: MODALITY_LABELS,
      documentLabels: DOCUMENT_LABELS,
      approvalStatusLabels: APPROVAL_STATUS_LABELS,
      agent: getAgentStatus()
    }
  });
});

/**
 * GET /api/care-plans/templates
 */
carePlanRouter.get('/templates', (req, res) => {
  res.json({ status: 'success', count: CARE_PLAN_TEMPLATES.length, data: CARE_PLAN_TEMPLATES });
});

/**
 * GET /api/care-plans?patientId=
 */
carePlanRouter.get('/', async (req, res, next) => {
  try {
    const plans = await listCarePlanSummaries({ patientId: req.query.patientId });
    res.json({ status: 'success', count: plans.length, data: plans });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-plans
 * Body: { patientId, templateId } or { patientId, title, sourceText, tasks: [...] }
 * The creating clinician is recorded as the plan's approver.
 */
carePlanRouter.post('/', async (req, res, next) => {
  try {
    const { patientId, templateId, title, sourceText, tasks } = req.body || {};
    if (!patientId) {
      return res.status(400).json({ error: 'BadRequest', code: 'PATIENT_REQUIRED', message: 'patientId is required.', status: 400 });
    }
    const detail = await createCarePlan({ patientId, templateId, title, sourceText, tasks, actor: clinicianActor(req) });
    res.status(201).json({ status: 'success', data: detail });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * GET /api/care-plans/:id
 */
carePlanRouter.get('/:id', async (req, res, next) => {
  try {
    const detail = await getCarePlanDetail(req.params.id, { actorType: 'clinician' });
    res.json({ status: 'success', data: detail });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-plans/:id/feasibility-check
 * Checks every task in the plan that is not yet completed.
 */
carePlanRouter.post('/:id/feasibility-check', async (req, res, next) => {
  try {
    const result = await runPlanFeasibilityCheck({ planId: req.params.id, actor: clinicianActor(req) });
    res.json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-plans/:id/agent-run
 * Runs the PlanPilot agent over the plan now (the demo's "Run" button). Returns what it did and why.
 */
carePlanRouter.post('/:id/agent-run', async (req, res, next) => {
  try {
    const run = await runAgentForPlan({ planId: req.params.id, trigger: 'manual', requestedBy: clinicianActor(req) });
    res.json({ status: 'success', data: run });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * GET /api/care-plans/:id/agent-runs
 */
carePlanRouter.get('/:id/agent-runs', async (req, res, next) => {
  try {
    const runs = await listAgentRuns(req.params.id);
    res.json({ status: 'success', count: runs.length, data: runs });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/care-tasks/:id/feasibility-check
 * Returns barriers found, the checks performed, and any proposed alternatives.
 */
careTaskRouter.post('/:id/feasibility-check', async (req, res, next) => {
  try {
    const result = await runTaskFeasibilityCheck({ taskId: req.params.id, actor: clinicianActor(req) });
    res.json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-tasks/:id/barriers
 * Body: { code, detail }. Screened for emergency red flags.
 */
careTaskRouter.post('/:id/barriers', async (req, res, next) => {
  try {
    const { code, detail } = req.body || {};
    const result = await reportBarrier({ taskId: req.params.id, code, detail, actor: clinicianActor(req) });
    res.status(201).json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-tasks/:id/barriers/:barrierId/resolve
 * Body: { resolution }
 */
careTaskRouter.post('/:id/barriers/:barrierId/resolve', async (req, res, next) => {
  try {
    const { resolution } = req.body || {};
    const barrier = await resolveTaskBarrier({
      taskId: req.params.id,
      barrierId: req.params.barrierId,
      resolution,
      actor: clinicianActor(req)
    });
    res.json({ status: 'success', data: barrier });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-tasks/:id/transition
 * Body: { to, reason }
 */
careTaskRouter.post('/:id/transition', async (req, res, next) => {
  try {
    const { to, reason } = req.body || {};
    const result = await transitionTask({ taskId: req.params.id, to, reason, actor: clinicianActor(req) });
    res.json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-tasks/:id/evidence
 * Body: { type, reference, note }
 */
careTaskRouter.post('/:id/evidence', async (req, res, next) => {
  try {
    const { type, reference, note } = req.body || {};
    const evidence = await recordEvidence({ taskId: req.params.id, type, reference, note, actor: clinicianActor(req) });
    res.status(201).json({ status: 'success', data: evidence });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-tasks/:id/approvals
 * Body: { proposalId, alternativeId, slotStartAt? }
 * Chooses one proposed alternative. It waits for the approvals it needs; nothing is booked before then.
 */
careTaskRouter.post('/:id/approvals', async (req, res, next) => {
  try {
    const { proposalId, alternativeId, slotStartAt } = req.body || {};
    const result = await chooseAlternative({ taskId: req.params.id, proposalId, alternativeId, slotStartAt, actor: clinicianActor(req) });
    res.status(201).json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-tasks/:id/planned-booking
 * Body: { slotStartAt? }
 * Proposes the earliest (or the given) slot at the planned clinic; the patient must confirm it.
 */
careTaskRouter.post('/:id/planned-booking', async (req, res, next) => {
  try {
    const result = await proposePlannedBooking({ taskId: req.params.id, slotStartAt: req.body?.slotStartAt || null, actor: clinicianActor(req) });
    res.status(201).json({ status: 'success', data: result });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});

/**
 * POST /api/care-tasks/:id/documents
 * Body: { fileName, mimeType, contentBase64 }. Staff uploading a document on the patient's behalf
 * (e.g. a paper copy scanned at the desk). Not evidence until a clinician verifies it.
 */
careTaskRouter.post('/:id/documents', async (req, res, next) => {
  try {
    const { fileName, mimeType, contentBase64 } = req.body || {};
    const submission = await submitDocument({ taskId: req.params.id, fileName, mimeType, contentBase64, actor: clinicianActor(req) });
    res.status(201).json({ status: 'success', data: submission });
  } catch (err) {
    sendCarePlanError(res, err, next);
  }
});
