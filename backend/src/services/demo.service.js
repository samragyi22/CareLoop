import { randomUUID } from 'crypto';
import { getDb } from '../config/db.js';
import { env } from '../config/env.js';
import { listPatientRecords, findPatientRecordById } from '../repositories/patient.repository.js';
import { listCarePlans } from '../repositories/carePlan.repository.js';
import { listCareTasksByPlan, findCareTaskById } from '../repositories/careTask.repository.js';
import { listOpenApprovalsByPatient, findApprovalById } from '../repositories/approval.repository.js';
import { createVoiceCall } from '../repositories/voiceCall.repository.js';
import { respondAsPatient } from './approval.service.js';
import { submitDocument } from './documentSubmission.service.js';
import { reportBarrier } from './feasibility.service.js';
import { CarePlanError } from './carePlan.service.js';
import { getAgentStatus } from './orchestrator.service.js';
import { TASK_STATUS, TASK_STATUS_LABELS } from './taskStateMachine.js';
import { FAULT_POINTS, armFault, clearFaults, listArmedFaults } from '../utils/faults.js';
import { seedClinician } from '../scripts/seedUsers.js';
import { seedProvidersAndSchedules } from '../scripts/seedAppointments.js';
import { seedDirectory } from '../scripts/seedDirectory.js';
import { seedPatients } from '../scripts/seedPatientUsers.js';
import { seedCarePlans } from '../scripts/seedCarePlans.js';

/**
 * Demo Lab (development only): stand-ins for things that happen outside the app during a live demo
 * (a patient replying, a patient not answering the phone, a document arriving), failure switches,
 * and a one-click reset. Everything done here is labelled as simulated in the audit log.
 */

// Logins survive a reset, so nobody is signed out mid-demo
const KEEP_ON_RESET = new Set(['users', 'revoked_tokens']);

// A one-page PDF reading "SYNTHETIC DEMO DOCUMENT"
const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 420 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n'
  + '4 0 obj<</Length 84>>stream\nBT /F1 16 Tf 30 90 Td (SYNTHETIC DEMO DOCUMENT - discharge summary) Tj ET\nendstream endobj\n'
  + '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
).toString('base64');

export function assertDemoAllowed() {
  if (env.NODE_ENV === 'production') {
    throw new CarePlanError('The Demo Lab is not available in production.', 'NOT_FOUND', 404);
  }
}

function simulatedPatient(patient) {
  return { type: 'patient', id: patient.userId || null, name: `${patient.name} (simulated in Demo Lab)` };
}

export async function getDemoStatus() {
  const patients = await listPatientRecords();
  const people = await Promise.all(patients.map(async (patient) => {
    const [plans, approvals] = await Promise.all([listCarePlans({ patientId: patient._id }), listOpenApprovalsByPatient(patient._id)]);
    const tasks = (await Promise.all(plans.filter(p => p.status === 'active').map(p => listCareTasksByPlan(p._id)))).flat();
    return {
      _id: patient._id,
      name: patient.name,
      phone: patient.phone,
      hasPortalLogin: Boolean(patient.userId),
      pendingConfirmations: approvals
        .filter(a => a.status === 'pending_patient')
        .map(a => ({ approvalId: a._id, description: a.description, taskTitle: tasks.find(t => t._id === a.taskId)?.title || 'Task' })),
      openTasks: tasks
        .filter(t => t.status !== TASK_STATUS.COMPLETED)
        .map(t => ({ taskId: t._id, title: t.title, type: t.type, status: t.status, statusLabel: TASK_STATUS_LABELS[t.status] }))
    };
  }));

  return {
    faultPoints: FAULT_POINTS,
    armedFaults: listArmedFaults(),
    agent: getAgentStatus(),
    patients: people
  };
}

export function armDemoFault(name, times = 1) {
  if (!FAULT_POINTS[name]) throw new CarePlanError(`Unknown failure "${name}".`, 'UNKNOWN_FAULT', 400);
  const count = Math.min(Math.max(Number(times) || 1, 1), 5);
  armFault(name, { times: count });
  return listArmedFaults();
}

export function clearDemoFaults() {
  clearFaults();
  return listArmedFaults();
}

/**
 * Simulates the patient answering a suggested option (as if they used the portal).
 */
export async function simulatePatientReply(approvalId, decision) {
  const approval = await findApprovalById(approvalId);
  if (!approval) throw new CarePlanError('Approval not found.', 'APPROVAL_NOT_FOUND', 404);
  const patient = await findPatientRecordById(approval.patientId);
  return respondAsPatient({
    approvalId,
    decision,
    note: decision === 'decline' ? 'That time does not work for me (simulated reply).' : '',
    actor: simulatedPatient(patient),
    patientRecordId: patient._id
  });
}

/**
 * Records outbound calls to the patient that nobody answered (simulated), so the next feasibility
 * check finds the patient unreachable.
 */
export async function simulateMissedCalls(patientId, count = 2) {
  const patient = await findPatientRecordById(patientId);
  if (!patient) throw new CarePlanError('Patient not found.', 'PATIENT_NOT_FOUND', 404);
  if (!patient.phone) throw new CarePlanError('This patient has no phone number.', 'NO_PHONE', 400);

  const calls = [];
  for (let i = 0; i < Math.min(Math.max(Number(count) || 2, 1), 5); i++) {
    calls.push(await createVoiceCall({
      callSid: `DEMO-MISSED-${randomUUID()}`,
      from: env.TWILIO_PHONE_NUMBER || 'CareLoop Clinic',
      to: patient.phone,
      direction: 'outbound',
      status: 'no-answer',
      callIntent: 'planpilot_follow_up',
      errorNote: 'Simulated in Demo Lab',
      isMock: true
    }));
  }
  return { patient: patient.name, missedCalls: calls.length };
}

export async function simulateDocumentUpload(taskId) {
  const task = await findCareTaskById(taskId);
  if (!task) throw new CarePlanError('Task not found.', 'TASK_NOT_FOUND', 404);
  const patient = await findPatientRecordById(task.patientId);
  return submitDocument({
    taskId,
    fileName: 'discharge-summary-SYNTHETIC.pdf',
    mimeType: 'application/pdf',
    contentBase64: SAMPLE_PDF,
    actor: simulatedPatient(patient),
    patientRecordId: patient._id
  });
}

export async function simulatePatientReport(taskId, { code, detail }) {
  const task = await findCareTaskById(taskId);
  if (!task) throw new CarePlanError('Task not found.', 'TASK_NOT_FOUND', 404);
  const patient = await findPatientRecordById(task.patientId);
  return reportBarrier({ taskId, code, detail, actor: simulatedPatient(patient) });
}

/**
 * Wipes demo data (keeping logins) and reloads the synthetic dataset.
 */
export async function resetDemoData() {
  const db = getDb();
  if (!db) throw new CarePlanError('Database not connected.', 'DB_UNAVAILABLE', 503);

  clearFaults();
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) {
    if (KEEP_ON_RESET.has(name) || name.startsWith('system.')) continue;
    await db.collection(name).deleteMany({});
  }
  for (const step of [seedClinician, seedProvidersAndSchedules, seedDirectory, seedPatients, seedCarePlans]) {
    await step();
  }
  return { reset: true, at: new Date().toISOString() };
}
