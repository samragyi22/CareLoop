/**
 * PlanPilot Task State Machine (pure logic, no database access)
 *
 * Decides whether a care-plan task may move from one status to another, and who may move it.
 * Three rules are enforced here so they cannot be bypassed by any caller (UI, API, or agent):
 *   1. Only transitions listed in TRANSITIONS are legal, and only for the listed actors.
 *   2. A task cannot become active (requested / confirmed / in progress / completed)
 *      until every task it depends on is completed with evidence.
 *   3. A task can only reach `completed_with_evidence` when every evidence type its task type
 *      requires has been recorded. A booking, a sent request, or an agent's claim is not evidence.
 */

export const TASK_STATUS = {
  SUGGESTED: 'suggested',
  AWAITING_PATIENT: 'awaiting_patient',
  AWAITING_APPROVAL: 'awaiting_approval',
  REQUESTED: 'requested',
  CONFIRMED: 'confirmed',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed_with_evidence',
  BLOCKED: 'blocked',
  ESCALATED: 'escalated',
  UNABLE_TO_VERIFY: 'unable_to_verify'
};

export const TASK_STATUSES = Object.values(TASK_STATUS);

// Human-readable labels shown in the UI (PROJECT_CONTEXT §10.6: honest status reporting)
export const TASK_STATUS_LABELS = {
  suggested: 'Suggested',
  awaiting_patient: 'Awaiting patient',
  awaiting_approval: 'Awaiting clinician approval',
  requested: 'Requested',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  completed_with_evidence: 'Completed with evidence',
  blocked: 'Blocked',
  escalated: 'Escalated to clinician',
  unable_to_verify: 'Unable to verify'
};

export const ACTOR_TYPES = ['clinician', 'patient', 'agent', 'system'];

const ANYONE = ['clinician', 'patient', 'agent', 'system'];
const COORDINATORS = ['clinician', 'agent', 'system'];
const CLINICIAN_ONLY = ['clinician'];
// The agent may never close a task; completion is a clinician action or an automatic system step
const COMPLETERS = ['clinician', 'system'];

// from -> { to -> actors allowed to make that move }
const TRANSITIONS = {
  suggested: {
    awaiting_patient: COORDINATORS,
    awaiting_approval: COORDINATORS,
    requested: COORDINATORS,
    blocked: ANYONE,
    escalated: ANYONE
  },
  awaiting_patient: {
    awaiting_approval: ANYONE,
    requested: ANYONE,
    blocked: ANYONE,
    escalated: ANYONE
  },
  awaiting_approval: {
    // After a clinician approves an option that the patient must also confirm
    awaiting_patient: CLINICIAN_ONLY,
    requested: CLINICIAN_ONLY,
    blocked: CLINICIAN_ONLY,
    escalated: ANYONE
  },
  requested: {
    confirmed: COORDINATORS,
    completed_with_evidence: COMPLETERS,
    blocked: ANYONE,
    escalated: ANYONE,
    unable_to_verify: COORDINATORS
  },
  confirmed: {
    in_progress: COORDINATORS,
    completed_with_evidence: COMPLETERS,
    blocked: ANYONE,
    escalated: ANYONE,
    unable_to_verify: COORDINATORS
  },
  in_progress: {
    completed_with_evidence: COMPLETERS,
    blocked: ANYONE,
    escalated: ANYONE,
    unable_to_verify: COORDINATORS
  },
  blocked: {
    suggested: COORDINATORS,
    awaiting_patient: COORDINATORS,
    awaiting_approval: COORDINATORS,
    requested: COORDINATORS,
    escalated: ANYONE
  },
  // Only a clinician can resolve an escalation
  escalated: {
    suggested: CLINICIAN_ONLY,
    requested: CLINICIAN_ONLY,
    blocked: CLINICIAN_ONLY,
    unable_to_verify: CLINICIAN_ONLY
  },
  unable_to_verify: {
    requested: COORDINATORS,
    completed_with_evidence: COMPLETERS,
    escalated: ANYONE
  },
  completed_with_evidence: {}
};

// Entering any of these means work on the task has started, so its prerequisites must be done
const ACTIVE_STATUSES = new Set(['requested', 'confirmed', 'in_progress', 'completed_with_evidence']);

/**
 * Evidence types: what each proves, and who is allowed to record it.
 */
export const EVIDENCE_TYPES = {
  booking_confirmed: {
    label: 'Appointment booking confirmed',
    recordableBy: ['clinician', 'system'],
    requiresReference: true // must reference a real confirmed booking (e.g. CL-ABC123)
  },
  visit_attended: {
    label: 'Clinician marked the visit as attended',
    recordableBy: ['clinician']
  },
  report_received: {
    label: 'Test report received',
    recordableBy: ['clinician', 'system']
  },
  report_reviewed: {
    label: 'Clinician reviewed the test report',
    recordableBy: ['clinician']
  },
  document_verified: {
    label: 'Document received and verified by staff',
    recordableBy: ['clinician']
  }
};

/**
 * Task types and the evidence each needs before it can be completed.
 * Note the deliberate gaps: a booked appointment does not prove a visit happened,
 * and a received report is not complete until a clinician has reviewed it.
 */
export const TASK_TYPES = {
  appointment_booking: {
    label: 'Book an appointment',
    requiredEvidence: ['booking_confirmed']
  },
  follow_up_visit: {
    label: 'Attend a follow-up visit',
    requiredEvidence: ['visit_attended']
  },
  lab_test: {
    label: 'Complete a lab test',
    requiredEvidence: ['report_received', 'report_reviewed']
  },
  document_submission: {
    label: 'Submit a document',
    requiredEvidence: ['document_verified']
  }
};

export const TASK_OWNERS = ['patient', 'clinic_staff', 'clinician', 'agent'];

export function isKnownStatus(status) {
  return TASK_STATUSES.includes(status);
}

export function requiredEvidenceFor(taskType) {
  return TASK_TYPES[taskType]?.requiredEvidence || [];
}

/**
 * Evidence types the task still needs, given the evidence types already recorded for it.
 */
export function missingEvidence(taskType, recordedEvidenceTypes = []) {
  const recorded = new Set(recordedEvidenceTypes);
  return requiredEvidenceFor(taskType).filter(type => !recorded.has(type));
}

/**
 * Checks one proposed transition.
 *
 * @param {object} task - { status, type }
 * @param {string} to - target status
 * @param {object} context
 * @param {string} context.actorType - one of ACTOR_TYPES
 * @param {Array<{key?: string, title?: string, status: string}>} context.dependencies - tasks this one depends on
 * @param {string[]} context.evidenceTypes - evidence types already recorded for this task
 * @returns {{ ok: true } | { ok: false, code: string, message: string, details?: object }}
 */
export function validateTransition(task, to, { actorType, dependencies = [], evidenceTypes = [] } = {}) {
  const from = task?.status;

  if (!isKnownStatus(to)) {
    return { ok: false, code: 'UNKNOWN_STATUS', message: `"${to}" is not a task status.` };
  }
  if (!ACTOR_TYPES.includes(actorType)) {
    return { ok: false, code: 'UNKNOWN_ACTOR', message: `"${actorType}" is not a recognised actor.` };
  }
  if (from === to) {
    return { ok: false, code: 'NO_CHANGE', message: `Task is already "${TASK_STATUS_LABELS[to]}".` };
  }
  if (from === TASK_STATUS.COMPLETED) {
    return { ok: false, code: 'TASK_CLOSED', message: 'Task is already completed with evidence and cannot change.' };
  }

  const allowedActors = TRANSITIONS[from]?.[to];
  if (!allowedActors) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: `A task cannot move from "${TASK_STATUS_LABELS[from] || from}" to "${TASK_STATUS_LABELS[to]}".`
    };
  }
  if (!allowedActors.includes(actorType)) {
    return {
      ok: false,
      code: 'ACTOR_NOT_ALLOWED',
      message: `Only ${allowedActors.join(' or ')} can move a task from "${TASK_STATUS_LABELS[from]}" to "${TASK_STATUS_LABELS[to]}".`
    };
  }

  if (ACTIVE_STATUSES.has(to)) {
    const unfinished = dependencies.filter(dep => dep.status !== TASK_STATUS.COMPLETED);
    if (unfinished.length > 0) {
      return {
        ok: false,
        code: 'DEPENDENCIES_INCOMPLETE',
        message: `Finish these first: ${unfinished.map(dep => dep.title || dep.key).join(', ')}.`,
        details: { unfinished: unfinished.map(dep => dep.key || dep.title) }
      };
    }
  }

  if (to === TASK_STATUS.COMPLETED) {
    const missing = missingEvidence(task.type, evidenceTypes);
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'EVIDENCE_MISSING',
        message: `Cannot complete without evidence: ${missing.map(type => EVIDENCE_TYPES[type]?.label || type).join(', ')}.`,
        details: { missing }
      };
    }
  }

  return { ok: true };
}

/**
 * Lists every status the task could conceivably move to next, each marked allowed or not with
 * the reason, so the UI can show disabled actions honestly instead of hiding them.
 */
export function describeNextTransitions(task, context) {
  const targets = Object.keys(TRANSITIONS[task?.status] || {});
  return targets.map(to => {
    const result = validateTransition(task, to, context);
    return {
      to,
      label: TASK_STATUS_LABELS[to],
      allowed: result.ok,
      ...(result.ok ? {} : { code: result.code, reason: result.message })
    };
  });
}
