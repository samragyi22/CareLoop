/**
 * PlanPilot agent: what it may do next for one task (pure logic, no database access).
 *
 * buildAllowedActions() lists the only actions the agent may take right now, given the task's
 *   state. Nothing on the list completes a task, approves an option, records clinician evidence, or
 *   answers for the patient; those stay with people.
 * chooseByRules() picks one deterministically (used when no LLM is configured, and as the fallback
 *   when the LLM's answer is unusable).
 * parseLlmDecision() accepts an LLM's answer only if it names an action from the list.
 */

const HOUR_MS = 60 * 60 * 1000;
export const STALE_EXECUTION_MS = 2 * 60 * 1000;
// The patient has had this long to answer before the agent hands the task to a clinician
export const PATIENT_REPLY_ESCALATE_HOURS = 48;
// Past the due date by this much with evidence still missing: "unable to verify", not silently pending
export const UNVERIFIED_AFTER_MS = 48 * HOUR_MS;
// This many options in a row that could not be carried out: stop retrying, ask a person
export const MAX_CONSECUTIVE_FAILURES = 3;

export const AGENT_ACTION_KINDS = [
  'run_feasibility_check',
  'choose_alternative',
  'propose_planned_booking',
  'request_task',
  'unblock_task',
  'mark_unable_to_verify',
  'escalate_task',
  'execute_approval',
  'wait'
];

const RECHECKABLE = new Set(['suggested', 'blocked', 'requested', 'confirmed', 'in_progress']);
const ACTIVE = new Set(['requested', 'confirmed', 'in_progress']);

function describeAlternative(alt) {
  const where = alt.facility ? `${alt.facility.name}${alt.facility.modality === 'in_person' ? ` (${alt.facility.distanceKm} km)` : ` (${alt.facility.modality.replace('_', ' ')})`}` : alt.kind.replace(/_/g, ' ');
  const approvals = [
    alt.requiresClinicianApproval && 'clinician approval',
    alt.requiresPatientConfirmation && 'patient confirmation'
  ].filter(Boolean);
  return `${where}; needs ${approvals.length ? approvals.join(' + ') : 'no approval'}`;
}

function isRejected(alt, rejectedOptions = []) {
  return rejectedOptions.some(r => r.kind === alt.kind && (r.facilityCode || null) === (alt.facility?.code || null));
}

/**
 * What the task is waiting for, in one line, for "wait" decisions and the run summary.
 */
export function waitingReason(ctx) {
  const { task } = ctx;
  if (task.status === 'escalated') return 'Escalated; only a clinician can resolve it.';
  if (ctx.openApproval?.status === 'pending_clinician') return 'Waiting for a clinician to approve the chosen option.';
  if (ctx.openApproval?.status === 'pending_patient') return 'Waiting for the patient to confirm the chosen option.';
  if (ctx.openApproval) return 'The chosen option is being carried out.';
  if (task.status === 'unable_to_verify') return 'Marked unable to verify; in the clinician review queue.';
  const unfinished = ctx.dependencies.filter(d => d.status !== 'completed_with_evidence');
  if (unfinished.length) return `Waiting for: ${unfinished.map(d => d.title).join(', ')}.`;
  if (ACTIVE.has(task.status) && ctx.missingEvidence.length) return `Waiting for evidence: ${ctx.missingEvidenceLabels.join(', ')}.`;
  if (task.status === 'blocked') return 'Blocked, and no permitted option is available.';
  return 'Nothing to do right now.';
}

/**
 * @param {object} ctx  built by the orchestrator service:
 *   { now, task: { _id, title, type, status, dueAt, hasBooking }, dependencies, depsComplete,
 *     missingEvidence, missingEvidenceLabels, openBarriers, lastCheckAt, needsRecheck, recheckReason,
 *     proposal, openApproval, rejectedOptions, consecutiveFailures }
 * @returns {Array<{ id, kind, label, params }>}
 */
export function buildAllowedActions(ctx) {
  const { task, now } = ctx;
  if (task.status === 'completed_with_evidence') return [];

  const actions = [];
  const add = (id, kind, label, params = {}) => actions.push({ id, kind, label, params });
  const addWait = () => add('wait', 'wait', `Do nothing now. ${waitingReason(ctx)}`);

  if (task.status === 'escalated') {
    addWait();
    return actions;
  }

  const approval = ctx.openApproval;
  if (approval) {
    const stuck = approval.status === 'executing'
      && now - new Date(approval.executionStartedAt || approval.createdAt).getTime() > STALE_EXECUTION_MS;
    if (approval.status === 'approved' || stuck) {
      add('execute_approval', 'execute_approval', `Carry out the fully approved option: ${approval.description}`, { approvalId: approval._id });
    }
    const waitedHours = Math.floor((now - new Date(approval.createdAt).getTime()) / HOUR_MS);
    if (approval.status === 'pending_patient' && waitedHours >= PATIENT_REPLY_ESCALATE_HOURS) {
      add('escalate_task', 'escalate_task', 'Escalate to a clinician', { reason: `The patient has not answered the proposed option for ${waitedHours} hours.` });
    }
    addWait();
    return actions;
  }

  if (ctx.needsRecheck && RECHECKABLE.has(task.status)) {
    add('run_feasibility_check', 'run_feasibility_check', `Check whether this task can happen for this patient (${ctx.recheckReason})`);
  }

  if (task.status === 'blocked' && ctx.depsComplete && ctx.proposal && ctx.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
    for (const alt of ctx.proposal.alternatives || []) {
      if (alt.kind === 'escalate' || isRejected(alt, ctx.rejectedOptions)) continue;
      add(`choose_alternative:${alt.id}`, 'choose_alternative', `Choose option ${alt.id}: ${describeAlternative(alt)}`, {
        proposalId: ctx.proposal._id,
        alternativeId: alt.id,
        optionKind: alt.kind,
        requiresClinicianApproval: Boolean(alt.requiresClinicianApproval),
        requiresPatientConfirmation: Boolean(alt.requiresPatientConfirmation)
      });
    }
  }

  if (task.status === 'blocked' && ctx.openBarriers.length === 0 && !ctx.needsRecheck) {
    add('unblock_task', 'unblock_task', 'Move back to Suggested: no open barriers remain');
  }

  const readyToStart = task.status === 'suggested' && ctx.depsComplete && ctx.lastCheckAt && !ctx.needsRecheck && ctx.openBarriers.length === 0;
  if (readyToStart && task.type === 'appointment_booking' && !task.hasBooking) {
    add('propose_planned_booking', 'propose_planned_booking', 'Offer the patient the earliest slot at the planned clinic (the patient must confirm)');
  } else if (readyToStart && task.type !== 'appointment_booking') {
    add('request_task', 'request_task', 'Move to Requested: prerequisites done and no barriers');
  }

  if (ACTIVE.has(task.status) && ctx.missingEvidence.length && now - new Date(task.dueAt).getTime() > UNVERIFIED_AFTER_MS) {
    add('mark_unable_to_verify', 'mark_unable_to_verify', 'Mark Unable to verify: well past due and evidence is still missing', {
      reason: `More than ${UNVERIFIED_AFTER_MS / HOUR_MS} hours past due with no evidence of: ${ctx.missingEvidenceLabels.join(', ')}.`
    });
  }

  add('escalate_task', 'escalate_task', 'Escalate to a clinician');
  addWait();
  return actions;
}

/**
 * Deterministic choice among the allowed actions, with the reason recorded in the audit log.
 */
export function chooseByRules(ctx, actions) {
  const find = (kind) => actions.find(a => a.kind === kind);
  const pick = (action, reason) => ({ actionId: action.id, reason });

  const execute = find('execute_approval');
  if (execute) return pick(execute, 'Every approval this option needs has been given.');

  const escalateWithReason = actions.find(a => a.kind === 'escalate_task' && a.params.reason);
  if (escalateWithReason) return pick(escalateWithReason, escalateWithReason.params.reason);

  if (ctx.openApproval) return pick(find('wait'), waitingReason(ctx));

  const recheck = find('run_feasibility_check');
  if (recheck) return pick(recheck, `Feasibility needs checking: ${ctx.recheckReason}.`);

  if (ctx.task.status === 'blocked' && ctx.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return pick(find('escalate_task'), `${ctx.consecutiveFailures} options in a row could not be carried out; a person should take over.`);
  }

  const options = actions.filter(a => a.kind === 'choose_alternative');
  if (options.length) {
    const easiest = options.find(a => !a.params.requiresClinicianApproval) || options[0];
    return pick(easiest, easiest.params.requiresClinicianApproval
      ? 'Only options needing clinician approval remain; sending the first for approval.'
      : 'Nearest same-service option that needs no clinical decision.');
  }

  const unblock = find('unblock_task');
  if (unblock) return pick(unblock, 'Every barrier on this task has been resolved.');

  const book = find('propose_planned_booking');
  if (book) return pick(book, 'Prerequisites are done and the planned clinic is reachable; offering its earliest slot.');

  const request = find('request_task');
  if (request) return pick(request, 'Prerequisites are done and no barriers were found.');

  const unverified = find('mark_unable_to_verify');
  if (unverified) return pick(unverified, unverified.params.reason);

  if (ctx.task.status === 'blocked' && ctx.depsComplete && ctx.openBarriers.length > 0 && find('escalate_task')) {
    return pick(find('escalate_task'), ctx.proposal?.recommendation === 'escalate' && ctx.proposal.note
      ? ctx.proposal.note
      : 'Blocked and no permitted alternative is available.');
  }

  return pick(find('wait'), waitingReason(ctx));
}

/**
 * Accepts an LLM answer only if it is JSON naming one allowed action, with a short reason.
 * Returns { ok: true, actionId, reason } or { ok: false, error }.
 */
export function parseLlmDecision(text, actions) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: 'the answer was not valid JSON' };
  }
  if (!parsed || typeof parsed.actionId !== 'string') return { ok: false, error: 'the answer had no actionId' };
  const action = actions.find(a => a.id === parsed.actionId);
  if (!action) return { ok: false, error: `"${parsed.actionId.slice(0, 60)}" is not one of the allowed actions` };
  const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (reason.length < 3) return { ok: false, error: 'the answer gave no reason' };
  return { ok: true, actionId: action.id, reason };
}

const SYSTEM_PROMPT = [
  'You are PlanPilot, the care-coordination agent of a clinic in India. You handle logistics only.',
  'For the care-plan task below, choose exactly ONE action from "allowedActions".',
  'Rules:',
  '- Never give medical advice and never change or second-guess the clinician\'s instruction.',
  '- You cannot complete tasks, approve options, or answer for the patient. Those actions do not exist for you.',
  '- Prefer keeping the plan as the clinician wrote it; otherwise the nearest same-service option needing the fewest approvals.',
  '- If nothing safe and useful can be done now, choose "wait" or "escalate_task".',
  'Reply with JSON only: {"actionId": "<an id from allowedActions>", "reason": "<one short sentence for the clinic\'s audit log>"}'
].join('\n');

/**
 * The prompt sent to the LLM. Patient names are replaced with "the patient" (data minimisation).
 */
export function buildDecisionPrompt(ctx, actions, { feedback = null, patientName = null } = {}) {
  const redact = (text) => (patientName && typeof text === 'string' ? text.split(patientName).join('the patient') : text);
  const context = {
    now: new Date(ctx.now).toISOString(),
    task: {
      title: ctx.task.title,
      type: ctx.task.type,
      status: ctx.task.status,
      dueAt: ctx.task.dueAt,
      hasBooking: Boolean(ctx.task.hasBooking)
    },
    prerequisites: ctx.dependencies.map(d => ({ title: d.title, status: d.status })),
    evidenceStillMissing: ctx.missingEvidenceLabels,
    openBarriers: ctx.openBarriers.map(b => ({ label: b.label, detail: redact(b.detail) })),
    lastFeasibilityCheck: ctx.lastCheckAt,
    proposal: ctx.proposal ? {
      recommendation: ctx.proposal.recommendation,
      alternatives: (ctx.proposal.alternatives || []).map(a => ({
        id: a.id,
        kind: a.kind,
        facility: a.facility ? { name: a.facility.name, modality: a.facility.modality, distanceKm: a.facility.distanceKm } : null,
        rationale: redact(a.rationale),
        needsClinicianApproval: Boolean(a.requiresClinicianApproval),
        needsPatientConfirmation: Boolean(a.requiresPatientConfirmation)
      }))
    } : null,
    optionsThatFailedInARow: ctx.consecutiveFailures,
    allowedActions: actions.map(a => ({ id: a.id, description: a.label }))
  };
  const prompt = `${JSON.stringify(context, null, 2)}${feedback ? `\n\nYour previous answer was rejected: ${feedback}. Answer again with JSON naming one allowed action id.` : ''}`;
  return { system: SYSTEM_PROMPT, prompt };
}
