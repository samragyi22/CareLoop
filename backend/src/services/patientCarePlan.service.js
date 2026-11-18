import { env } from '../config/env.js';
import { findPatientRecordByUserId } from '../repositories/patient.repository.js';
import { listCarePlans } from '../repositories/carePlan.repository.js';
import { listCareTasksByPlan } from '../repositories/careTask.repository.js';
import { listBarriersByPlan } from '../repositories/barrier.repository.js';
import { listApprovalsByPlan } from '../repositories/approval.repository.js';
import { listSubmissionsByPlan } from '../repositories/documentSubmission.repository.js';
import { listFacilities } from '../repositories/serviceDirectory.repository.js';
import { TASK_STATUS, TASK_TYPES } from './taskStateMachine.js';
import { BARRIER_CODES, MODALITY_LABELS, distanceKm, documentLabel } from './feasibilityRules.js';
import { formatClinicTime } from '../utils/time.js';

/**
 * The patient's own view of their care plans: what each step is, where it stands, and what, if
 * anything, is needed from them. The phone agent reads this to the patient, so the wording is plain
 * spoken language: no audit internals, no other patients.
 */

export const PATIENT_STATUS_LABELS = {
  suggested: 'Planned',
  awaiting_patient: 'Needs your answer',
  awaiting_approval: 'Your doctor is reviewing',
  requested: 'In progress',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  completed_with_evidence: 'Done',
  blocked: 'Clinic is sorting out a problem',
  escalated: 'With your doctor',
  unable_to_verify: 'Clinic is checking'
};

function nextStepFor({ task, facility, pendingForPatient, pendingForClinician, submissions, unfinishedDeps, openProblems, timeZone }) {
  const when = (date) => formatClinicTime(date, timeZone);

  if (task.status === TASK_STATUS.COMPLETED) return { text: 'Done. Your care team has the proof they need.', needsYou: false };
  if (pendingForPatient) return { text: 'An option is waiting for your yes or no.', needsYou: true };
  if (pendingForClinician) return { text: 'Your doctor is reviewing an option for this step. Nothing for you to do yet.', needsYou: false };
  if (task.status === TASK_STATUS.ESCALATED) return { text: 'Your doctor is looking at this step. The clinic will contact you.', needsYou: false };

  if (task.type === 'document_submission') {
    const waiting = submissions.some(s => s.status === 'pending_review');
    if (waiting) return { text: 'The clinic has received your document and will check it.', needsYou: false };
    const rejected = submissions.find(s => s.status === 'rejected');
    const what = documentLabel(task.serviceRequirement?.document);
    return {
      text: rejected
        ? `The clinic could not accept the last copy of your ${what} (${rejected.reviewNote}). Please bring it to the clinic.`
        : `Please bring your ${what} to the clinic, or ask the hospital for a copy. The clinic will check it.`,
      needsYou: true
    };
  }

  if (task.status === TASK_STATUS.BLOCKED && openProblems > 0) {
    return { text: 'The clinic is sorting out a problem with this step. You don\'t need to do anything yet.', needsYou: false };
  }
  if (unfinishedDeps.length && [TASK_STATUS.SUGGESTED, TASK_STATUS.BLOCKED].includes(task.status) && !task.booking) {
    return { text: `This comes after: ${unfinishedDeps.map(d => d.title).join(', ')}.`, needsYou: false };
  }

  if (task.booking) {
    const where = task.booking.facilityName || facility?.name || 'the clinic';
    if (task.type === 'follow_up_visit') {
      const how = task.booking.modality === 'teleconsult' ? 'Join your teleconsultation' : 'Attend your visit';
      return { text: `${how} on ${when(task.booking.startAt)} with ${task.booking.providerName} (${where}).`, needsYou: true };
    }
    return { text: `Booked: ${when(task.booking.startAt)} with ${task.booking.providerName} at ${where}. Reference ${task.booking.bookingReference}.`, needsYou: false };
  }

  if (task.type === 'lab_test' && [TASK_STATUS.REQUESTED, TASK_STATUS.CONFIRMED, TASK_STATUS.IN_PROGRESS].includes(task.status) && facility) {
    if (facility.modality === 'home_visit') {
      return { text: 'A sample collector will visit your home.', needsYou: false };
    }
    return { text: `Go to ${facility.name} for your test during its opening hours.`, needsYou: true };
  }

  return { text: 'The clinic will arrange this step.', needsYou: false };
}

/**
 * Care plans for the patient record linked to a patient login. Empty if the login has no record.
 */
export async function getPatientCarePlans(userId) {
  const record = await findPatientRecordByUserId(userId);
  if (!record) return { patient: null, plans: [] };
  return getCarePlansForPatientRecord(record);
}

/**
 * Same view for a patient record directly (used by the phone agent, which knows the caller by phone).
 */
export async function getCarePlansForPatientRecord(record) {
  const timeZone = env.DEFAULT_TIMEZONE;
  const [plans, facilities] = await Promise.all([listCarePlans({ patientId: record._id }), listFacilities()]);
  const facilitiesByCode = new Map(facilities.map(f => [f.code, f]));
  const now = Date.now();

  const views = await Promise.all(plans.map(async (plan) => {
    const [tasks, barriers, approvals, submissions] = await Promise.all([
      listCareTasksByPlan(plan._id),
      listBarriersByPlan(plan._id),
      listApprovalsByPlan(plan._id),
      listSubmissionsByPlan(plan._id)
    ]);
    const tasksById = new Map(tasks.map(t => [t._id, t]));

    const taskViews = tasks.map(task => {
      const facility = facilitiesByCode.get(task.serviceRequirement?.facilityCode) || null;
      const open = approvals.find(a => a.taskId === task._id && a.isOpen) || null;
      const pendingForPatient = open?.status === 'pending_patient' ? open : null;
      const pendingForClinician = open?.status === 'pending_clinician' ? open : null;
      const taskSubmissions = submissions.filter(s => s.taskId === task._id);
      const unfinishedDeps = task.dependsOn.map(id => tasksById.get(id)).filter(dep => dep && dep.status !== TASK_STATUS.COMPLETED);
      const problems = barriers
        .filter(b => b.taskId === task._id && !b.resolvedAt)
        .map(b => ({ label: BARRIER_CODES[b.code]?.label || b.code, detail: b.detail }));
      const nextStep = nextStepFor({
        task, facility, pendingForPatient, pendingForClinician, submissions: taskSubmissions, unfinishedDeps, openProblems: problems.length, timeZone
      });

      return {
        _id: task._id,
        title: task.title,
        type: task.type,
        typeLabel: TASK_TYPES[task.type]?.label || task.type,
        status: task.status,
        statusLabel: PATIENT_STATUS_LABELS[task.status],
        done: task.status === TASK_STATUS.COMPLETED,
        dueAt: task.dueAt,
        isOverdue: task.status !== TASK_STATUS.COMPLETED && new Date(task.dueAt).getTime() < now,
        doctorsInstruction: task.clinicalInstruction,
        facility: facility ? {
          name: facility.name,
          modality: facility.modality,
          modalityLabel: MODALITY_LABELS[facility.modality],
          distanceKm: facility.modality === 'in_person' ? distanceKm(record.location, facility.location) : 0,
          isSimulated: Boolean(facility.isSimulated)
        } : null,
        booking: task.booking ? {
          bookingReference: task.booking.bookingReference,
          startAt: task.booking.startAt,
          providerName: task.booking.providerName,
          facilityName: task.booking.facilityName,
          modality: task.booking.modality
        } : null,
        problems,
        pendingConfirmation: pendingForPatient ? {
          approvalId: pendingForPatient._id,
          description: pendingForPatient.description,
          why: pendingForPatient.action.rationale,
          approvedByDoctor: Boolean(pendingForPatient.clinicianDecision),
          facility: pendingForPatient.action.facility,
          slot: pendingForPatient.action.slot
        } : null,
        documents: taskSubmissions.map(s => ({
          _id: s._id,
          fileName: s.fileName,
          status: s.status,
          submittedAt: s.submittedAt,
          reviewNote: s.status === 'rejected' ? s.reviewNote : null
        })),
        canUploadDocument: task.type === 'document_submission' && task.status !== TASK_STATUS.COMPLETED,
        documentName: task.type === 'document_submission' ? documentLabel(task.serviceRequirement?.document) : null,
        nextStep: nextStep.text,
        needsYou: nextStep.needsYou
      };
    });

    return {
      _id: plan._id,
      title: plan.title,
      status: plan.status,
      approvedBy: plan.approvedBy?.name || null,
      approvedAt: plan.approvedAt,
      progress: { total: tasks.length, done: tasks.filter(t => t.status === TASK_STATUS.COMPLETED).length },
      needsYouCount: taskViews.filter(t => t.needsYou).length,
      tasks: taskViews
    };
  }));

  return { patient: { _id: record._id, name: record.name }, plans: views };
}
