import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_STATUSES,
  TASK_TYPES,
  EVIDENCE_TYPES,
  validateTransition,
  describeNextTransitions,
  missingEvidence
} from '../src/services/taskStateMachine.js';

const done = { key: 'dep', title: 'Dependency', status: 'completed_with_evidence' };
const pending = { key: 'dep', title: 'Book follow-up', status: 'requested' };

describe('task state machine', () => {
  it('allows a coordinator to request a task with no dependencies', () => {
    const result = validateTransition({ status: 'suggested', type: 'appointment_booking' }, 'requested', { actorType: 'agent' });
    assert.equal(result.ok, true);
  });

  it('refuses transitions that are not in the table', () => {
    const result = validateTransition({ status: 'suggested', type: 'appointment_booking' }, 'completed_with_evidence', { actorType: 'clinician' });
    assert.equal(result.code, 'ILLEGAL_TRANSITION');
  });

  it('refuses to complete a task without its required evidence', () => {
    const task = { status: 'requested', type: 'appointment_booking' };
    const result = validateTransition(task, 'completed_with_evidence', { actorType: 'clinician', evidenceTypes: [] });
    assert.equal(result.code, 'EVIDENCE_MISSING');
    assert.deepEqual(result.details.missing, ['booking_confirmed']);
  });

  it('treats partial evidence as missing evidence (a received lab report is not a reviewed one)', () => {
    const task = { status: 'requested', type: 'lab_test' };
    const result = validateTransition(task, 'completed_with_evidence', { actorType: 'clinician', evidenceTypes: ['report_received'] });
    assert.equal(result.code, 'EVIDENCE_MISSING');
    assert.deepEqual(result.details.missing, ['report_reviewed']);

    const complete = validateTransition(task, 'completed_with_evidence', { actorType: 'clinician', evidenceTypes: ['report_received', 'report_reviewed'] });
    assert.equal(complete.ok, true);
  });

  it('never lets the agent close a task, even with evidence', () => {
    const task = { status: 'requested', type: 'appointment_booking' };
    const result = validateTransition(task, 'completed_with_evidence', { actorType: 'agent', evidenceTypes: ['booking_confirmed'] });
    assert.equal(result.code, 'ACTOR_NOT_ALLOWED');
  });

  it('blocks starting a task until its dependencies are completed, but still allows blocking or escalating it', () => {
    const task = { status: 'suggested', type: 'follow_up_visit' };
    const start = validateTransition(task, 'requested', { actorType: 'clinician', dependencies: [done, pending] });
    assert.equal(start.code, 'DEPENDENCIES_INCOMPLETE');
    assert.match(start.message, /Book follow-up/);

    assert.equal(validateTransition(task, 'blocked', { actorType: 'patient', dependencies: [pending] }).ok, true);
    assert.equal(validateTransition(task, 'escalated', { actorType: 'agent', dependencies: [pending] }).ok, true);
    assert.equal(validateTransition(task, 'requested', { actorType: 'clinician', dependencies: [done] }).ok, true);
  });

  it('lets only a clinician resolve an escalation or grant an approval', () => {
    const escalated = { status: 'escalated', type: 'lab_test' };
    assert.equal(validateTransition(escalated, 'requested', { actorType: 'agent' }).code, 'ACTOR_NOT_ALLOWED');
    assert.equal(validateTransition(escalated, 'requested', { actorType: 'clinician' }).ok, true);

    const awaiting = { status: 'awaiting_approval', type: 'lab_test' };
    assert.equal(validateTransition(awaiting, 'requested', { actorType: 'system' }).code, 'ACTOR_NOT_ALLOWED');
    assert.equal(validateTransition(awaiting, 'requested', { actorType: 'clinician' }).ok, true);

    // Approved by the clinician, now waiting on the patient: only the clinician can hand it over
    for (const actorType of ['agent', 'system', 'patient']) {
      assert.equal(validateTransition(awaiting, 'awaiting_patient', { actorType }).code, 'ACTOR_NOT_ALLOWED');
    }
    assert.equal(validateTransition(awaiting, 'awaiting_patient', { actorType: 'clinician' }).ok, true);
  });

  it('treats a completed task as closed', () => {
    const result = validateTransition({ status: 'completed_with_evidence', type: 'lab_test' }, 'blocked', { actorType: 'clinician' });
    assert.equal(result.code, 'TASK_CLOSED');
  });

  it('rejects unknown statuses and actors', () => {
    const task = { status: 'suggested', type: 'lab_test' };
    assert.equal(validateTransition(task, 'done', { actorType: 'clinician' }).code, 'UNKNOWN_STATUS');
    assert.equal(validateTransition(task, 'requested', { actorType: 'llm' }).code, 'UNKNOWN_ACTOR');
    assert.equal(validateTransition(task, 'suggested', { actorType: 'clinician' }).code, 'NO_CHANGE');
  });

  it('describes every next move with a reason when it is not allowed', () => {
    const options = describeNextTransitions(
      { status: 'requested', type: 'appointment_booking' },
      { actorType: 'clinician', evidenceTypes: [] }
    );
    const complete = options.find(o => o.to === 'completed_with_evidence');
    assert.equal(complete.allowed, false);
    assert.equal(complete.code, 'EVIDENCE_MISSING');
    assert.ok(options.find(o => o.to === 'confirmed').allowed);
  });

  it('has a consistent vocabulary', () => {
    for (const status of TASK_STATUSES) {
      assert.ok(Array.isArray(describeNextTransitions({ status, type: 'lab_test' }, { actorType: 'clinician' })));
    }
    for (const [type, definition] of Object.entries(TASK_TYPES)) {
      assert.ok(definition.requiredEvidence.length > 0, `${type} must require evidence`);
      for (const evidenceType of definition.requiredEvidence) {
        assert.ok(EVIDENCE_TYPES[evidenceType], `${type} requires unknown evidence ${evidenceType}`);
      }
    }
    assert.deepEqual(missingEvidence('follow_up_visit', ['visit_attended']), []);
  });
});
