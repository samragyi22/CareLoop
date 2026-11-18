import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateTransition,
  TASK_STATUSES,
  TASK_TYPES,
  ACTOR_TYPES,
  requiredEvidenceFor
} from '../src/services/taskStateMachine.js';
import { startTestServer } from './helpers/testServer.js';
import { assertNoCompletionWithoutEvidence, assertAuditTrailsReplay } from './helpers/invariants.js';
import { seedClinician } from '../src/scripts/seedUsers.js';
import { seedProvidersAndSchedules } from '../src/scripts/seedAppointments.js';
import { seedDirectory } from '../src/scripts/seedDirectory.js';
import { seedPatients } from '../src/scripts/seedPatientUsers.js';
import { seedCarePlans } from '../src/scripts/seedCarePlans.js';
import { listCarePlans } from '../src/repositories/carePlan.repository.js';
import { listCareTasksByPlan, updateCareTaskLogistics, findCareTaskById } from '../src/repositories/careTask.repository.js';
import {
  transitionTask,
  recordEvidence,
  runInTransaction,
  completeWhenEvidenceSatisfiedInSession
} from '../src/services/carePlan.service.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

function subsets(items) {
  return items.reduce((all, item) => all.concat(all.map(set => [...set, item])), [[]]);
}

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : full.endsWith('.js') ? [full] : [];
  }));
  return files.flat();
}

describe('Evidence gate: no code path reaches "completed with evidence" without matching evidence', () => {
  it('the state machine refuses completion for every task type, starting status, and actor whenever any required evidence is missing', () => {
    let refusals = 0;
    for (const [type, definition] of Object.entries(TASK_TYPES)) {
      const partialEvidence = subsets(definition.requiredEvidence).filter(set => set.length < definition.requiredEvidence.length);
      for (const status of TASK_STATUSES) {
        for (const actorType of ACTOR_TYPES) {
          for (const evidenceTypes of partialEvidence) {
            const verdict = validateTransition({ status, type }, 'completed_with_evidence', { actorType, dependencies: [], evidenceTypes });
            assert.equal(verdict.ok, false, `${type} from ${status} by ${actorType} with [${evidenceTypes}] must be refused`);
            refusals++;
          }
        }
      }
    }
    assert.ok(refusals > 100);
  });

  it('even with full evidence, the agent and the patient can never complete a task', () => {
    for (const type of Object.keys(TASK_TYPES)) {
      for (const status of TASK_STATUSES) {
        for (const actorType of ['agent', 'patient']) {
          const verdict = validateTransition({ status, type }, 'completed_with_evidence', {
            actorType, dependencies: [], evidenceTypes: requiredEvidenceFor(type)
          });
          assert.equal(verdict.ok, false, `${actorType} completed ${type} from ${status}`);
        }
      }
    }
  });

  it('only one function writes task status, and it always asks the state machine first', async () => {
    const files = await sourceFiles(SRC);
    const writers = [];
    const directCollectionUse = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/updateCareTaskStatus\(/.test(text) && !file.endsWith('careTask.repository.js')) writers.push(path.relative(SRC, file));
      if (/collection\(\s*['"]care_tasks['"]\s*\)/.test(text) && !file.endsWith('careTask.repository.js')) directCollectionUse.push(path.relative(SRC, file));
    }
    assert.deepEqual(writers, [path.join('services', 'carePlan.service.js')], 'status writes go through one service');
    assert.deepEqual(directCollectionUse, [], 'no module bypasses the task repository');

    const service = await readFile(path.join(SRC, 'services', 'carePlan.service.js'), 'utf8');
    const body = service.slice(service.indexOf('export async function applyTransitionInSession'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    assert.equal((service.match(/updateCareTaskStatus\(/g) || []).length, 1, 'exactly one call site');
    assert.ok(fn.includes('updateCareTaskStatus('), 'the call site is inside applyTransitionInSession');
    assert.ok(fn.indexOf('validateTransition(') < fn.indexOf('updateCareTaskStatus('), 'validation happens before the write');
  });

  describe('against a real database', () => {
    let ctx;
    let tasks;
    const clinician = { type: 'clinician', id: null, name: 'Dr. Test' };

    before(async () => {
      ctx = await startTestServer();
      await seedClinician();
      await seedProvidersAndSchedules();
      await seedDirectory();
      await seedPatients();
      await seedCarePlans();
      const [plan] = await listCarePlans();
      tasks = Object.fromEntries((await listCareTasksByPlan(plan._id)).map(t => [t.key, t]));
    });

    after(async () => {
      await ctx.stop();
    });

    it('logistics updates cannot change status', async () => {
      const lab = tasks.lipid_test;
      const updated = await updateCareTaskLogistics(lab._id, { status: 'completed_with_evidence', dueAt: new Date(lab.dueAt) });
      assert.equal(updated.status, lab.status);
    });

    it('the auto-complete helper does nothing while evidence is missing', async () => {
      const lab = tasks.lipid_test;
      await transitionTask({ taskId: lab._id, to: 'requested', actor: clinician });
      await recordEvidence({ taskId: lab._id, type: 'report_received', actor: { type: 'system', id: null, name: 'Lab feed' } });

      const result = await runInTransaction(async (session) => {
        const current = await findCareTaskById(lab._id, { session });
        return completeWhenEvidenceSatisfiedInSession({ session, task: current, actor: { type: 'system', id: null, name: 'test' }, reason: 'test' });
      });
      assert.equal(result, null);
      assert.equal((await findCareTaskById(lab._id)).status, 'requested');
    });

    it('the agent cannot record clinician evidence or complete; the clinician can once the evidence is complete', async () => {
      const lab = tasks.lipid_test;
      const agent = { type: 'agent', id: null, name: 'PlanPilot agent' };
      await assert.rejects(recordEvidence({ taskId: lab._id, type: 'report_reviewed', actor: agent }), { code: 'ACTOR_NOT_ALLOWED' });
      await assert.rejects(transitionTask({ taskId: lab._id, to: 'completed_with_evidence', actor: agent }), { code: 'ACTOR_NOT_ALLOWED' });
      await assert.rejects(transitionTask({ taskId: lab._id, to: 'completed_with_evidence', actor: clinician }), { code: 'EVIDENCE_MISSING' });

      await recordEvidence({ taskId: lab._id, type: 'report_reviewed', actor: clinician });
      const done = await transitionTask({ taskId: lab._id, to: 'completed_with_evidence', actor: clinician });
      assert.equal(done.task.status, 'completed_with_evidence');
    });

    it('the database agrees: every completed task has its evidence, and every audit trail replays', async () => {
      const db = ctx.getDb();
      assert.equal(await assertNoCompletionWithoutEvidence(db), 1);
      await assertAuditTrailsReplay(db);
    });
  });
});
