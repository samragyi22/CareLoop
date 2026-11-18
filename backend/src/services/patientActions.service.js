import { updatePatientLogistics } from '../repositories/patient.repository.js';
import { findCareTaskById } from '../repositories/careTask.repository.js';
import { reportBarrier } from './feasibility.service.js';
import { CarePlanError } from './carePlan.service.js';

/**
 * What a patient can report about a care-plan step, in their words, mapped to PlanPilot's
 * barrier codes. Shared by the phone agent and the patient API.
 */
export const PATIENT_PROBLEM_CODES = {
  cant_get_there: 'TRANSPORT',
  no_document: 'MISSING_DOCUMENT',
  timing: 'NO_SLOT',
  other: 'OTHER'
};

/**
 * Records a problem the patient reports on one of their own tasks. For "can't get there" the
 * patient can also say how far they can travel / whether they have transport, which updates their
 * logistics so the next check finds options they can reach. Text is screened for emergencies and
 * clinical content (inside reportBarrier).
 */
export async function reportProblemAsPatient({ patient, taskId, problem, detail, maxTravelKm, hasOwnTransport, actor }) {
  const task = await findCareTaskById(taskId);
  if (!task || task.patientId !== patient._id) {
    throw new CarePlanError('Task not found.', 'TASK_NOT_FOUND', 404);
  }
  const code = PATIENT_PROBLEM_CODES[problem];
  if (!code) {
    throw new CarePlanError(`Problem must be one of: ${Object.keys(PATIENT_PROBLEM_CODES).join(', ')}.`, 'UNKNOWN_PROBLEM', 400);
  }

  if (code === 'TRANSPORT' && (maxTravelKm !== undefined || hasOwnTransport !== undefined)) {
    const km = Number(maxTravelKm);
    await updatePatientLogistics(patient._id, {
      constraints: {
        ...patient.constraints,
        ...(maxTravelKm !== undefined && maxTravelKm !== null && Number.isFinite(km) && km >= 0 && km <= 500 ? { maxTravelKm: km } : {}),
        ...(typeof hasOwnTransport === 'boolean' ? { hasOwnTransport } : {})
      }
    });
  }

  const result = await reportBarrier({ taskId: task._id, code, detail, actor });
  return {
    task,
    recorded: true,
    emergency: result.emergency,
    sentToDoctor: Boolean(result.clinicalReview) || Boolean(result.emergency),
    clinicalReview: result.clinicalReview
  };
}
