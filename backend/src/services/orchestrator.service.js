import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { findCarePlanById, listCarePlans, acquirePlanAgentLock, releasePlanAgentLock } from '../repositories/carePlan.repository.js';
import { listCareTasksByPlan, findCareTaskById } from '../repositories/careTask.repository.js';
import { findPatientRecordById } from '../repositories/patient.repository.js';
import { listEvidenceByTask } from '../repositories/evidence.repository.js';
import { listOpenBarriersByTask } from '../repositories/barrier.repository.js';
import { listOpenProposalsByPlan } from '../repositories/replanProposal.repository.js';
import { listApprovalsByTask } from '../repositories/approval.repository.js';
import { listTaskEventsByTask, insertTaskEvents } from '../repositories/taskEvent.repository.js';
import { insertAgentRun, listAgentRunsByPlan } from '../repositories/agentRun.repository.js';
import { CarePlanError, transitionTask, toStoredActor } from './carePlan.service.js';
import { runTaskFeasibilityCheck } from './feasibility.service.js';
import { chooseAlternative, proposePlannedBooking, executeApproval } from './approval.service.js';
import { generateJson, getLlmStatus } from './llmClient.js';
import { buildAllowedActions, chooseByRules, parseLlmDecision, buildDecisionPrompt, waitingReason } from './orchestratorActions.js';
import { TASK_STATUS, EVIDENCE_TYPES, missingEvidence } from './taskStateMachine.js';
import { BARRIER_CODES } from './feasibilityRules.js';
import { withRetries } from '../utils/retry.js';
import { maybeFail } from '../utils/faults.js';

/**
 * The PlanPilot agent (orchestrator). For each open task in a plan:
 *   1. the server builds the task's context and the list of actions allowed right now,
 *   2. the LLM (if configured) or the rules engine picks one, with a reason,
 *   3. the server checks the pick is on the list, logs the decision, and carries it out through the
 *      same guarded services a clinician uses. Risky changes go to the approvals queue, never straight through.
 * Tool failures are retried with backoff; if they keep failing, the task is escalated to a person.
 * Bad, slow, or missing LLM answers fall back to the rules engine. Nothing fails silently.
 */

export const AGENT_ACTOR = { type: 'agent', id: null, name: 'PlanPilot agent' };

const MAX_PASSES = 4;
const MAX_ACTIONS_PER_RUN = 12;
const MAX_ACTIONS_PER_TASK = 3;
const LLM_ATTEMPTS = 2;
const ACTION_ATTEMPTS = 3;
const LOCK_TTL_MS = 5 * 60 * 1000;
const STALE_CHECK_MS = 12 * 60 * 60 * 1000;
const REJECTION_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
// Something changed since the last feasibility check that may change its answer
const RECHECK_TRIGGERS = {
  approval_failed: 'the chosen option could not be carried out',
  approval_rejected: 'the clinician rejected the chosen option',
  patient_declined: 'the patient declined the chosen option',
  approval_cancelled: 'the chosen option was withdrawn',
  barrier_detected: 'a new barrier was reported',
  barrier_resolved: 'a barrier was resolved',
  logistics_updated: 'where or when the task happens changed'
};
// Refusals worth retrying (someone else changed the task a moment ago); other refusals are final
const TRANSIENT_REFUSALS = new Set(['CONCURRENT_UPDATE', 'DB_UNAVAILABLE', 'APPROVAL_EXECUTING']);

export function getAgentStatus() {
  const llm = getLlmStatus();
  return {
    decider: llm.configured ? `${llm.provider} (${llm.model}), rules as fallback` : 'Rules engine (no LLM configured)',
    llm,
    schedulerMinutes: env.PLANPILOT_AGENT_INTERVAL_MINUTES > 0 ? env.PLANPILOT_AGENT_INTERVAL_MINUTES : null
  };
}

async function buildTaskContext(task, { tasksById, patient, proposals, now }) {
  const [events, evidence, openBarriers, approvals] = await Promise.all([
    listTaskEventsByTask(task._id),
    listEvidenceByTask(task._id),
    listOpenBarriersByTask(task._id),
    listApprovalsByTask(task._id)
  ]);

  const dependencies = task.dependsOn.map(id => tasksById.get(id)).filter(Boolean).map(d => ({ title: d.title, status: d.status }));
  const missing = missingEvidence(task.type, evidence.map(e => e.type));

  const lastCheck = [...events].reverse().find(e => e.kind === 'feasibility_checked') || null;
  let recheckReason = null;
  if (!lastCheck) {
    recheckReason = 'never checked';
  } else {
    const checkedAt = new Date(lastCheck.at).getTime();
    const trigger = events.find(e => RECHECK_TRIGGERS[e.kind] && new Date(e.at).getTime() > checkedAt);
    if (trigger) recheckReason = RECHECK_TRIGGERS[trigger.kind];
    else if (patient?.updatedAt && new Date(patient.updatedAt).getTime() > checkedAt) recheckReason = 'the patient\'s logistics changed';
    else if (now - checkedAt > STALE_CHECK_MS) recheckReason = 'the last check is over 12 hours old';
  }

  // Consecutive options that could not be carried out since the last one that worked
  let consecutiveFailures = 0;
  for (const approval of approvals) { // newest first
    if (approval.status === 'failed') consecutiveFailures++;
    else if (approval.status === 'executed') break;
  }

  const open = approvals.find(a => a.isOpen) || null;
  return {
    now,
    task: {
      _id: task._id,
      title: task.title,
      type: task.type,
      status: task.status,
      dueAt: task.dueAt,
      hasBooking: Boolean(task.booking)
    },
    dependencies,
    depsComplete: dependencies.every(d => d.status === TASK_STATUS.COMPLETED),
    missingEvidence: missing,
    missingEvidenceLabels: missing.map(type => EVIDENCE_TYPES[type]?.label || type),
    openBarriers: openBarriers.map(b => ({ code: b.code, label: BARRIER_CODES[b.code]?.label || b.code, detail: b.detail, source: b.source })),
    lastCheckAt: lastCheck?.at || null,
    needsRecheck: Boolean(recheckReason),
    recheckReason,
    proposal: proposals.find(p => p.taskId === task._id) || null,
    openApproval: open ? {
      _id: open._id,
      status: open.status,
      description: open.description,
      createdAt: open.createdAt,
      executionStartedAt: open.execution?.startedAt || null
    } : null,
    rejectedOptions: approvals
      .filter(a => ['rejected', 'declined'].includes(a.status) && now - new Date(a.updatedAt).getTime() < REJECTION_MEMORY_MS)
      .map(a => ({ kind: a.action.kind, facilityCode: a.action.facility?.code || null })),
    consecutiveFailures
  };
}

/**
 * Picks one allowed action: the LLM if configured (its answer must name an allowed action), else
 * or on failure the rules engine. Returns { actionId, reason, decidedBy, fallbackReason, llmAttempts }.
 */
async function decide(ctx, actions, { patientName, rulesOnly = false }) {
  const rules = chooseByRules(ctx, actions);
  if (actions.length === 1 || rulesOnly) return { ...rules, decidedBy: 'rules', fallbackReason: null, llmAttempts: 0 };

  const llm = getLlmStatus();
  if (!llm.configured) return { ...rules, decidedBy: 'rules', fallbackReason: null, llmAttempts: 0 };

  let feedback = null;
  let lastProblem = null;
  for (let attempt = 1; attempt <= LLM_ATTEMPTS; attempt++) {
    try {
      const { system, prompt } = buildDecisionPrompt(ctx, actions, { feedback, patientName });
      const parsed = parseLlmDecision(await generateJson({ system, prompt }), actions);
      if (parsed.ok) {
        return { actionId: parsed.actionId, reason: parsed.reason, decidedBy: `llm:${llm.provider}/${llm.model}`, fallbackReason: null, llmAttempts: attempt };
      }
      lastProblem = parsed.error;
      feedback = parsed.error;
    } catch (err) {
      lastProblem = err.message;
      if (attempt < LLM_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 200 * attempt));
    }
  }
  return {
    ...rules,
    decidedBy: 'rules',
    fallbackReason: `LLM answer unusable after ${LLM_ATTEMPTS} attempts (${lastProblem}); rules engine decided`,
    llmAttempts: LLM_ATTEMPTS
  };
}

async function performAction(action, { taskId, reason }) {
  maybeFail('agent_action');
  const { params } = action;
  switch (action.kind) {
    case 'run_feasibility_check': {
      const result = await runTaskFeasibilityCheck({ taskId, actor: AGENT_ACTOR });
      if (result.feasible) return 'No barriers found.';
      const found = result.barriers.map(b => b.label).join(', ');
      const options = result.proposal ? ` ${result.proposal.alternatives.length} option(s) proposed.` : '';
      return `Found: ${found}.${result.blocked ? ' Task blocked.' : ''}${options}`;
    }
    case 'choose_alternative': {
      const result = await chooseAlternative({ taskId, proposalId: params.proposalId, alternativeId: params.alternativeId, actor: AGENT_ACTOR });
      if (result.failure) return `Option could not be carried out: ${result.failure.message}`;
      if (result.executed) return result.booking ? `Carried out; booked ${result.booking.bookingReference}.` : 'Carried out (no approval needed).';
      return result.approval.status === 'pending_clinician' ? 'Sent to a clinician for approval.' : 'Sent to the patient to confirm.';
    }
    case 'propose_planned_booking': {
      const result = await proposePlannedBooking({ taskId, actor: AGENT_ACTOR });
      return `Offered to the patient: ${result.approval.description}.`;
    }
    case 'execute_approval': {
      const result = await executeApproval({ approvalId: params.approvalId, actor: AGENT_ACTOR });
      return result.failure ? `Could not be carried out: ${result.failure.message}` : 'Carried out.';
    }
    case 'request_task':
      await transitionTask({ taskId, to: TASK_STATUS.REQUESTED, actor: AGENT_ACTOR, reason });
      return 'Moved to Requested.';
    case 'unblock_task':
      await transitionTask({ taskId, to: TASK_STATUS.SUGGESTED, actor: AGENT_ACTOR, reason });
      return 'Moved back to Suggested.';
    case 'mark_unable_to_verify':
      await transitionTask({ taskId, to: TASK_STATUS.UNABLE_TO_VERIFY, actor: AGENT_ACTOR, reason });
      return 'Marked Unable to verify; it is in the clinician review queue.';
    case 'escalate_task':
      await transitionTask({ taskId, to: TASK_STATUS.ESCALATED, actor: AGENT_ACTOR, reason });
      return 'Escalated to a clinician.';
    default:
      throw new CarePlanError(`Unknown agent action "${action.kind}".`, 'UNKNOWN_ACTION', 400);
  }
}

/**
 * Carries out an action, retrying transient failures with backoff. If it still fails, the task is
 * escalated to a person with the error, so nothing fails silently.
 */
async function executeDecision(action, { task, reason }) {
  let attempts = 0;
  try {
    const detail = await withRetries(
      (attempt) => {
        attempts = attempt;
        return performAction(action, { taskId: task._id, reason });
      },
      {
        attempts: ACTION_ATTEMPTS,
        baseDelayMs: 150,
        isRetryable: err => err.name !== 'CarePlanError' || TRANSIENT_REFUSALS.has(err.code)
      }
    );
    return { outcome: 'done', detail, attempts };
  } catch (err) {
    if (err.name === 'CarePlanError' && !TRANSIENT_REFUSALS.has(err.code)) {
      // The guarded services refused (e.g. the state machine); nothing changed
      return { outcome: 'refused', detail: err.message, attempts: err.attempts };
    }
    const message = `PlanPilot agent could not "${action.label}" after ${err.attempts || ACTION_ATTEMPTS} attempts (${err.message}). A person needs to look at this.`;
    try {
      const current = await findCareTaskById(task._id);
      if (current && ![TASK_STATUS.ESCALATED, TASK_STATUS.COMPLETED].includes(current.status)) {
        await transitionTask({ taskId: task._id, to: TASK_STATUS.ESCALATED, actor: AGENT_ACTOR, reason: message });
      }
      return { outcome: 'failed_escalated', detail: message, attempts: err.attempts };
    } catch (escalationErr) {
      return { outcome: 'failed', detail: `${message} Escalation also failed: ${escalationErr.message}`, attempts: err.attempts };
    }
  }
}

async function logDecision(task, action, decision, actions) {
  await insertTaskEvents([{
    taskId: new ObjectId(task._id),
    planId: new ObjectId(task.planId),
    kind: 'agent_decision',
    from: task.status,
    to: task.status,
    actor: toStoredActor(AGENT_ACTOR),
    reason: `${action.label}. ${decision.reason}`,
    decision: {
      actionId: action.id,
      kind: action.kind,
      decidedBy: decision.decidedBy,
      fallbackReason: decision.fallbackReason,
      llmAttempts: decision.llmAttempts,
      allowedActions: actions.map(a => a.id)
    },
    at: new Date()
  }]);
}

/**
 * Runs the agent over one care plan until nothing more can be done right now (bounded).
 * rulesOnly: decide with the rules engine even if an LLM is configured (used mid-phone-call,
 * where the patient is waiting on the line for the next option).
 */
export async function runAgentForPlan({ planId, trigger = 'manual', requestedBy = null, rulesOnly = false }) {
  const plan = await findCarePlanById(planId);
  if (!plan) throw new CarePlanError('Care plan not found.', 'PLAN_NOT_FOUND', 404);
  if (plan.status !== 'active') throw new CarePlanError('This care plan is no longer active.', 'PLAN_NOT_ACTIVE', 409);

  const runId = new ObjectId();
  if (!(await acquirePlanAgentLock(plan._id, runId, LOCK_TTL_MS))) {
    throw new CarePlanError('The PlanPilot agent is already working on this plan. Try again in a moment.', 'AGENT_BUSY', 409);
  }

  const status = getAgentStatus();
  const run = {
    _id: runId,
    planId: new ObjectId(plan._id),
    trigger,
    requestedBy: requestedBy ? toStoredActor(requestedBy) : null,
    decider: rulesOnly ? 'Rules engine (fast, during a phone call)' : status.decider,
    startedAt: new Date(),
    finishedAt: null,
    status: 'running',
    steps: [],
    waiting: [],
    error: null
  };

  try {
    const patient = await findPatientRecordById(plan.patientId);
    const actionsPerTask = new Map();
    const lastWait = new Map();
    let total = 0;

    for (let pass = 0; pass < MAX_PASSES && total < MAX_ACTIONS_PER_RUN; pass++) {
      const [tasks, proposals] = await Promise.all([listCareTasksByPlan(plan._id), listOpenProposalsByPlan(plan._id)]);
      const tasksById = new Map(tasks.map(t => [t._id, t]));
      let acted = false;

      for (const task of tasks) {
        if (task.status === TASK_STATUS.COMPLETED || total >= MAX_ACTIONS_PER_RUN) continue;
        if ((actionsPerTask.get(task._id) || 0) >= MAX_ACTIONS_PER_TASK) continue;

        // Re-read: an earlier action in this pass may have changed this task (e.g. a booking it follows)
        const current = await findCareTaskById(task._id);
        tasksById.set(current._id, current);
        const ctx = await buildTaskContext(current, { tasksById, patient, proposals, now: Date.now() });
        const actions = buildAllowedActions(ctx);
        if (actions.length === 0) continue;

        const decision = await decide(ctx, actions, { patientName: patient?.name, rulesOnly });
        const action = actions.find(a => a.id === decision.actionId);
        if (action.kind === 'wait') {
          lastWait.set(current._id, { taskId: current._id, taskTitle: current.title, status: current.status, reason: waitingReason(ctx), decidedBy: decision.decidedBy });
          continue;
        }

        await logDecision(current, action, decision, actions);
        const result = await executeDecision(action, { task: current, reason: decision.reason });
        run.steps.push({
          taskId: current._id,
          taskTitle: current.title,
          actionId: action.id,
          kind: action.kind,
          label: action.label,
          reason: decision.reason,
          decidedBy: decision.decidedBy,
          fallbackReason: decision.fallbackReason,
          outcome: result.outcome,
          detail: result.detail,
          attempts: result.attempts || 1,
          at: new Date().toISOString()
        });
        lastWait.delete(current._id);
        // A refused or failed task is left alone for the rest of this run instead of retrying the same thing
        actionsPerTask.set(current._id, result.outcome === 'done' ? (actionsPerTask.get(current._id) || 0) + 1 : MAX_ACTIONS_PER_TASK);
        total++;
        // Only count real progress; a refusal changed nothing and would just repeat
        if (result.outcome === 'done') acted = true;
      }

      if (!acted) break;
    }

    run.waiting = [...lastWait.values()];
    run.status = 'completed';
  } catch (err) {
    run.status = 'failed';
    run.error = err.message;
  } finally {
    run.finishedAt = new Date();
    await releasePlanAgentLock(plan._id, runId);
    await insertAgentRun(run);
  }

  return {
    ...run,
    _id: String(run._id),
    planId: String(run.planId),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    summary: run.status === 'failed'
      ? `Run stopped: ${run.error}`
      : `${run.steps.length} action(s) taken; ${run.waiting.length} task(s) waiting.`
  };
}

export async function listAgentRuns(planId) {
  return listAgentRunsByPlan(planId);
}

/**
 * One scheduled pass over every active plan (re-evaluates overdue, blocked, and stale tasks).
 */
export async function runAgentTick() {
  const plans = await listCarePlans({ status: 'active' });
  const results = [];
  for (const plan of plans) {
    try {
      results.push(await runAgentForPlan({ planId: plan._id, trigger: 'scheduled' }));
    } catch (err) {
      if (err.code !== 'AGENT_BUSY') console.error(`[PlanPilot] Agent run failed for plan ${plan._id}: ${err.message}`);
    }
  }
  return results;
}

/**
 * Starts the periodic re-evaluation if PLANPILOT_AGENT_INTERVAL_MINUTES > 0. Returns the timer or null.
 */
export function startAgentScheduler(minutes = env.PLANPILOT_AGENT_INTERVAL_MINUTES) {
  if (!minutes || minutes <= 0) return null;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const results = await runAgentTick();
      const actions = results.reduce((sum, r) => sum + r.steps.length, 0);
      if (actions > 0) console.log(`[PlanPilot] Scheduled run: ${actions} action(s) across ${results.length} plan(s).`);
    } catch (err) {
      console.error(`[PlanPilot] Scheduled run failed: ${err.message}`);
    } finally {
      running = false;
    }
  }, minutes * 60 * 1000);
  timer.unref();
  console.log(`[PlanPilot] Agent re-evaluates active plans every ${minutes} minute(s).`);
  return timer;
}
