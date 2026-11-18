import express from 'express';
import { requireClinician } from '../middleware/auth.middleware.js';
import {
  createPatientRecord,
  findPatientRecordById,
  listPatientRecords,
  updatePatientLogistics,
  PATIENT_LANGUAGES
} from '../repositories/patient.repository.js';
import { findUserById } from '../repositories/user.repository.js';
import { normalizeE164Phone } from '../repositories/callbackConsent.repository.js';
import { isSyntheticPhone } from '../utils/synthetic.js';

/**
 * Clinician-facing patient registry (/api/patients): the patients care plans are written for.
 * Not to be confused with /api/patient, the patient's own self-service portal.
 */
export const patientRegistryRouter = express.Router();

patientRegistryRouter.use(requireClinician);

/**
 * GET /api/patients
 */
patientRegistryRouter.get('/', async (req, res, next) => {
  try {
    const patients = await listPatientRecords();
    res.json({ status: 'success', count: patients.length, data: patients });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/patients/:id
 */
patientRegistryRouter.get('/:id', async (req, res, next) => {
  try {
    const patient = await findPatientRecordById(req.params.id);
    if (!patient) {
      return res.status(404).json({ error: 'NotFound', message: 'Patient record not found.', status: 404 });
    }
    res.json({ status: 'success', data: patient });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/patients/:id/logistics
 * Body: { constraints: { hasOwnTransport, maxTravelKm, documentsHeld, caregiverName }, location }
 * Updates the logistical profile PlanPilot's feasibility checks use. Never clinical data.
 */
patientRegistryRouter.patch('/:id/logistics', async (req, res, next) => {
  try {
    const existing = await findPatientRecordById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'NotFound', message: 'Patient record not found.', status: 404 });
    }

    const { constraints, location } = req.body || {};
    if (constraints?.maxTravelKm !== undefined) {
      const km = Number(constraints.maxTravelKm);
      if (!Number.isFinite(km) || km < 0 || km > 500) {
        return res.status(400).json({ error: 'BadRequest', code: 'INVALID_TRAVEL_LIMIT', message: 'maxTravelKm must be between 0 and 500.', status: 400 });
      }
    }

    const updated = await updatePatientLogistics(existing._id, {
      constraints: constraints ? { ...existing.constraints, ...constraints } : undefined,
      location
    });
    res.json({ status: 'success', data: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/patients
 * Body: { name, phone, preferredLanguage, userId, constraints, location }
 * Patients reach PlanPilot by phone, so a real E.164 number makes PlanPilot's calls real
 * (fictional +1 555 numbers are always simulated).
 */
patientRegistryRouter.post('/', async (req, res, next) => {
  try {
    const { name, phone, preferredLanguage = 'hi', userId = null, constraints = {}, location = null } = req.body || {};

    if (typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'BadRequest', code: 'INVALID_NAME', message: 'Patient name must be at least 2 characters.', status: 400 });
    }

    const normalizedPhone = phone ? normalizeE164Phone(phone) : null;
    if (phone && !normalizedPhone) {
      return res.status(400).json({ error: 'BadRequest', code: 'INVALID_PHONE_NUMBER', message: 'Phone must be in E.164 format, e.g. +919876543210.', status: 400 });
    }

    if (!PATIENT_LANGUAGES.includes(preferredLanguage)) {
      return res.status(400).json({ error: 'BadRequest', code: 'INVALID_LANGUAGE', message: `Language must be one of: ${PATIENT_LANGUAGES.join(', ')}.`, status: 400 });
    }

    if (userId) {
      const user = await findUserById(userId);
      if (!user || user.role !== 'patient') {
        return res.status(400).json({ error: 'BadRequest', code: 'INVALID_USER', message: 'userId must belong to a patient login account.', status: 400 });
      }
    }

    const patient = await createPatientRecord({
      name,
      phone: normalizedPhone,
      preferredLanguage,
      userId,
      constraints,
      location,
      isSynthetic: isSyntheticPhone(normalizedPhone)
    });
    res.status(201).json({ status: 'success', data: patient });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Conflict', code: 'LOGIN_ALREADY_LINKED', message: 'That login account already has a patient record.', status: 409 });
    }
    next(err);
  }
});
