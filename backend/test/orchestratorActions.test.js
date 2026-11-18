import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAllowedActions,
  chooseByRules,
  parseLlmDecision,
  buildDecisionPrompt,
  AGENT_ACTION_KINDS,
  MAX_CONSECUTIVE_FAILURES
} from '../src/services/orchestratorActions.js';
import { TASK_STATUSES, TASK_TYPES } from '../src/services/taskStateMachine.js';

const NOW = Date.parse('2026-10-20T06:00:00Z');
const HOUR = 60 * 60 * 1000;

function context(overrides = {}) {
  const { task: taskOverrides, ...rest } = overrides;
  return {
    now: NOW,
    task: { _id: 't1', title: 'Book follow-up', type: 'appointment_booking', status: 'suggested', dueAt: new Date(NOW + 72 * HOUR).toISOString(), hasBooking: false, ...taskOverrides },
    dependencies: [],
    depsComplete: true,
    missingEvidence: ['booking_confirmed'],
    missingEvidenceLabels: ['Appointment booking confirmed'],
    openBarriers: [],
    lastCheckAt: new Date(NOW - HOUR).toISOString(),
    needsRecheck: false,
    recheckReason: null,
    proposal: null,
    openApproval: null,
    rejectedOptions: [],
    consecutiveFailures: 0,
    ...rest
  };
}

const PROPOSAL = {
  _id: 'p1',
  recommendation: 'choose_alternative',
  alternatives: [
    { id: 'alt-1', kind: 'facility_change', facility: { code: 'PHC-SUNDARPUR', name: 'Sundarpur PHC', modality: 'in_person', distanceKm: 1.4 }, requiresPatientConfirmation: true, requiresClinicianApproval: false, rationale: 'Near Sunita Devi.' },
    { id: 'alt-2', kind: 'modality_change', facility: { code: 'TELE-GP', name: 'Teleconsult', modality: 'teleconsult', distanceKm: 0 }, requiresPatientConfirmation: true, requiresClinicianApproval: true, rationale: 'No travel.' },
    { id: 'alt-3', kind: 'escalate', requiresClinicianApproval: true, rationale: 'x' }
  ]
};

const blocked = (extra = {}) => context({
  task: { status: 'blocked' },
  openBarriers: [{ code: 'TRANSPORT', label: 'Cannot reach the facility', detail: 'Sunita Devi can travel up to 5 km' }],
  proposal: PROPOSAL,
  ...extra
});

const decide = (ctx) => {
  const actions = buildAllowedActions(ctx);
  const choice = chooseByRules(ctx, actions);
  return { actions, choice, action: actions.find(a => a.id === choice.actionId) };
};

describe('PlanPilot agent: allowed actions and the rules engine', () => {
  it('never offers the agent a way to complete, approve, verify, or answer for the patient, in any state', () => {
    for (const type of Object.keys(TASK_TYPES)) {
      for (const status of TASK_STATUSES) {
        for (const approvalStatus of [null, 'pending_clinician', 'pending_patient', 'approved', 'executing']) {
          const ctx = context({
            task: { type, status },
            proposal: PROPOSAL,
            needsRecheck: true,
            recheckReason: 'test',
            openApproval: approvalStatus ? { _id: 'a1', status: approvalStatus, description: 'x', createdAt: new Date(NOW - 100 * HOUR).toISOString() } : null
          });
          for (const action of buildAllowedActions(ctx)) {
            assert.ok(AGENT_ACTION_KINDS.includes(action.kind), `unexpected action ${action.kind}`);
            assert.doesNotMatch(action.id, /complete|approve|verify|confirm|evidence/i);
          }
        }
      }
    }
  });

  it('does nothing on completed tasks and only waits on escalated ones', () => {
    assert.deepEqual(buildAllowedActions(context({ task: { status: 'completed_with_evidence' } })), []);
    const escalated = buildAllowedActions(context({ task: { status: 'escalated' } }));
    assert.deepEqual(escalated.map(a => a.kind), ['wait']);
  });

  it('checks feasibility first when the task was never checked or something changed', () => {
    const { action, choice } = decide(context({ lastCheckAt: null, needsRecheck: true, recheckReason: 'never checked' }));
    assert.equal(action.kind, 'run_feasibility_check');
    assert.match(choice.reason, /never checked/);
  });

  it('for a blocked task, picks the nearest option that needs no clinical decision, never the escalate pseudo-option', () => {
    const { actions, action } = decide(blocked());
    assert.equal(action.id, 'choose_alternative:alt-1');
    assert.ok(!actions.some(a => a.id === 'choose_alternative:alt-3'));
  });

  it('skips options the clinician rejected or the patient declined, and escalates once none are left', () => {
    const { action } = decide(blocked({ rejectedOptions: [{ kind: 'facility_change', facilityCode: 'PHC-SUNDARPUR' }] }));
    assert.equal(action.id, 'choose_alternative:alt-2', 'the remaining option goes to the clinician');

    const none = decide(blocked({ rejectedOptions: [
      { kind: 'facility_change', facilityCode: 'PHC-SUNDARPUR' },
      { kind: 'modality_change', facilityCode: 'TELE-GP' }
    ] }));
    assert.equal(none.action.kind, 'escalate_task');
  });

  it(`stops retrying after ${MAX_CONSECUTIVE_FAILURES} options in a row could not be carried out`, () => {
    const { action, choice } = decide(blocked({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES }));
    assert.equal(action.kind, 'escalate_task');
    assert.match(choice.reason, /in a row/);
    assert.equal(decide(blocked({ consecutiveFailures: 2 })).action.kind, 'choose_alternative');
  });

  it('waits on a blocked task whose prerequisites are unfinished instead of escalating it', () => {
    const { action, choice } = decide(blocked({
      dependencies: [{ title: 'Bring discharge summary', status: 'blocked' }],
      depsComplete: false
    }));
    assert.equal(action.kind, 'wait');
    assert.match(choice.reason, /discharge summary/);
  });

  it('unblocks a task once every barrier is resolved, then offers the planned slot or requests the task', () => {
    assert.equal(decide(context({ task: { status: 'blocked' } })).action.kind, 'unblock_task');
    assert.equal(decide(context()).action.kind, 'propose_planned_booking');
    assert.equal(decide(context({ task: { type: 'lab_test' }, missingEvidence: ['report_received', 'report_reviewed'] })).action.kind, 'request_task');
    assert.equal(decide(context({ task: { hasBooking: true } })).action.kind, 'wait');
  });

  it('while an option awaits approval, only waits, unless it is fully approved or the patient has not answered for 48 hours', () => {
    const pending = (status, hoursAgo) => context({ task: { status: 'awaiting_patient' }, openApproval: { _id: 'a1', status, description: 'x', createdAt: new Date(NOW - hoursAgo * HOUR).toISOString() } });
    assert.equal(decide(pending('pending_patient', 3)).action.kind, 'wait');
    assert.equal(decide(pending('pending_clinician', 100)).action.kind, 'wait');
    assert.equal(decide(pending('approved', 0)).action.kind, 'execute_approval');
    const late = decide(pending('pending_patient', 50));
    assert.equal(late.action.kind, 'escalate_task');
    assert.match(late.choice.reason, /50 hours/);
  });

  it('marks a requested task Unable to verify when it is well past due with no evidence', () => {
    const overdue = context({ task: { type: 'lab_test', status: 'requested', dueAt: new Date(NOW - 72 * HOUR).toISOString() }, missingEvidence: ['report_received'], missingEvidenceLabels: ['Test report received'] });
    assert.equal(decide(overdue).action.kind, 'mark_unable_to_verify');
    const recent = context({ task: { type: 'lab_test', status: 'requested', dueAt: new Date(NOW - 2 * HOUR).toISOString() }, missingEvidence: ['report_received'], missingEvidenceLabels: ['x'] });
    assert.equal(decide(recent).action.kind, 'wait');
  });

  it('accepts an LLM answer only if it is JSON naming an allowed action, with a reason', () => {
    const actions = buildAllowedActions(blocked());
    assert.equal(parseLlmDecision('I would book the nearby clinic', actions).ok, false);
    assert.match(parseLlmDecision('{"actionId":"complete_task","reason":"done"}', actions).error, /not one of the allowed actions/);
    assert.match(parseLlmDecision('{"actionId":"wait"}', actions).error, /no reason/);
    const ok = parseLlmDecision('```json\n{"actionId":"choose_alternative:alt-2","reason":"Patient prefers no travel."}\n```', actions);
    assert.deepEqual(ok, { ok: true, actionId: 'choose_alternative:alt-2', reason: 'Patient prefers no travel.' });
  });

  it('sends the LLM the allowed actions and no patient name', () => {
    const ctx = blocked();
    const { system, prompt } = buildDecisionPrompt(ctx, buildAllowedActions(ctx), { patientName: 'Sunita Devi' });
    assert.match(system, /exactly ONE action/);
    assert.ok(prompt.includes('choose_alternative:alt-1'));
    assert.ok(!prompt.includes('Sunita'));
  });
});
