import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer, createClient } from './helpers/testServer.js';
import { loginClinician, loginPatient } from './helpers/fixtures.js';
import { assertNoCompletionWithoutEvidence, assertAuditTrailsReplay } from './helpers/invariants.js';
import { seedClinician } from '../src/scripts/seedUsers.js';
import { seedProvidersAndSchedules } from '../src/scripts/seedAppointments.js';
import { seedDirectory } from '../src/scripts/seedDirectory.js';
import { seedPatients } from '../src/scripts/seedPatientUsers.js';
import { seedCarePlans } from '../src/scripts/seedCarePlans.js';
import { acquirePlanAgentLock, releasePlanAgentLock } from '../src/repositories/carePlan.repository.js';
import { runAgentTick } from '../src/services/orchestrator.service.js';
import { armFault, clearFaults } from '../src/utils/faults.js';

describe('PlanPilot agent (rules engine): recovery, retries, and escalation', () => {
  let ctx;
  let clinician;
  let sunitaPortal;
  let patients;
  let sunitaPlanId;

  const getPlan = async (planId) => (await clinician.get(`/api/care-plans/${planId}`)).data.data;
  const taskByKey = (detail, key) => detail.tasks.find(t => t.key === key);
  const runAgent = async (planId) => {
    const res = await clinician.post(`/api/care-plans/${planId}/agent-run`, {});
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.data;
  };
  const takeSlotForWalkIn = async (slot) => {
    const res = await clinician.post('/api/appointments', {
      providerId: slot.providerId,
      startAt: slot.startAt,
      endAt: slot.endAt,
      patient: { name: 'Walk-in Patient', phone: '+15550100199' }
    });
    assert.equal(res.status, 201);
  };
  const confirmAsSunita = async (approvalId) => {
    const res = await sunitaPortal.post(`/api/patient/care/approvals/${approvalId}/respond`, { decision: 'confirm' });
    assert.equal(res.status, 200);
    return res.data.data;
  };

  before(async () => {
    ctx = await startTestServer();
    await seedClinician();
    await seedProvidersAndSchedules();
    await seedDirectory();
    await seedPatients();
    await seedCarePlans();

    clinician = createClient(ctx.baseUrl);
    await loginClinician(clinician, { email: 'clinician@careloop.local', password: 'CareLoop2026!' });
    sunitaPortal = createClient(ctx.baseUrl);
    await loginPatient(sunitaPortal, { email: 'patient@careloop.local', password: 'CareLoopPatient2026!' });

    patients = (await clinician.get('/api/patients')).data.data;
    const plans = (await clinician.get('/api/care-plans')).data.data;
    sunitaPlanId = plans.find(p => p.patient.name === 'Sunita Devi')._id;
  });

  after(async () => {
    clearFaults();
    await ctx.stop();
  });

  describe('Sunita\'s plan recovers from two failures in a row without losing state', () => {
    const slotsTried = [];

    it('first run: checks every task, picks the nearby clinic, requests the missing document, and waits where it must', async () => {
      const run = await runAgent(sunitaPlanId);
      assert.equal(run.status, 'completed');
      assert.match(run.decider, /Rules engine/);

      const kinds = run.steps.map(s => s.kind);
      assert.equal(kinds.filter(k => k === 'run_feasibility_check').length, 4, 'every task checked once');
      assert.ok(run.steps.every(s => s.decidedBy === 'rules' && s.outcome === 'done'));

      const detail = await getPlan(sunitaPlanId);
      const book = taskByKey(detail, 'book_followup');
      assert.equal(book.status, 'awaiting_patient');
      assert.equal(book.openApproval.action.facility.code, 'PHC-SUNDARPUR');
      assert.equal(book.openApproval.requestedBy.type, 'agent');
      assert.equal(taskByKey(detail, 'discharge_summary').status, 'requested', 'requesting a document needs no approval');
      assert.equal(taskByKey(detail, 'lipid_test').status, 'awaiting_patient');

      const visit = taskByKey(detail, 'followup_visit');
      assert.equal(visit.status, 'blocked');
      const visitWait = run.waiting.find(w => w.taskId === visit._id);
      assert.match(visitWait.reason, /Waiting for:/);

      // Every agent decision is in the audit log, with the allowed list it chose from
      const decisions = detail.events.filter(e => e.kind === 'agent_decision');
      assert.equal(decisions.length, run.steps.length);
      assert.ok(decisions.every(e => e.actor.type === 'agent' && e.decision.allowedActions.includes(e.decision.actionId)));
      slotsTried.push(book.openApproval.action.slot);
    });

    it('failure 1: the slot is taken before the patient confirms; the agent re-checks and offers another slot', async () => {
      const book = taskByKey(await getPlan(sunitaPlanId), 'book_followup');
      await takeSlotForWalkIn(slotsTried[0]);
      const result = await confirmAsSunita(book.openApproval._id);
      assert.equal(result.executed, false);
      assert.equal(taskByKey(await getPlan(sunitaPlanId), 'book_followup').status, 'blocked');

      const run = await runAgent(sunitaPlanId);
      const bookSteps = run.steps.filter(s => s.taskId === book._id).map(s => s.kind);
      assert.deepEqual(bookSteps, ['run_feasibility_check', 'choose_alternative']);

      const retried = taskByKey(await getPlan(sunitaPlanId), 'book_followup');
      assert.equal(retried.status, 'awaiting_patient');
      assert.notEqual(retried.openApproval.action.slot.startAt, slotsTried[0].startAt, 'the taken slot is not offered again');
      slotsTried.push(retried.openApproval.action.slot);
    });

    it('failure 2: the new slot is taken too; the agent tries again', async () => {
      const book = taskByKey(await getPlan(sunitaPlanId), 'book_followup');
      await takeSlotForWalkIn(slotsTried[1]);
      assert.equal((await confirmAsSunita(book.openApproval._id)).executed, false);

      await runAgent(sunitaPlanId);
      const retried = taskByKey(await getPlan(sunitaPlanId), 'book_followup');
      assert.equal(retried.status, 'awaiting_patient');
      assert.ok(!slotsTried.some(s => s.startAt === retried.openApproval.action.slot.startAt));
      slotsTried.push(retried.openApproval.action.slot);
    });

    it('third time: the patient confirms, the slot is booked, and the booking task completes with evidence', async () => {
      const book = taskByKey(await getPlan(sunitaPlanId), 'book_followup');
      assert.equal((await confirmAsSunita(book.openApproval._id)).executed, true);

      const done = taskByKey(await getPlan(sunitaPlanId), 'book_followup');
      assert.equal(done.status, 'completed_with_evidence');
      assert.equal(done.booking.startAt, slotsTried[2].startAt);
      assert.deepEqual(
        [done.approvalHistory.map(a => a.status), done.approvalHistory.map(a => a.execution?.code || null)],
        [['executed', 'failed', 'failed'], [null, 'SLOT_TAKEN', 'SLOT_TAKEN']]
      );
    });

    it('next run: the visit follows the booking, its barrier clears, and it waits for the document', async () => {
      const run = await runAgent(sunitaPlanId);
      const visit = taskByKey(await getPlan(sunitaPlanId), 'followup_visit');
      const visitSteps = run.steps.filter(s => s.taskId === visit._id).map(s => s.kind);
      assert.deepEqual(visitSteps, ['run_feasibility_check', 'unblock_task']);
      assert.equal(visit.status, 'suggested');
      assert.equal(visit.plannedFacility.code, 'PHC-SUNDARPUR');
      assert.equal(visit.barriers.filter(b => !b.resolvedAt).length, 0);
      assert.match(run.waiting.find(w => w.taskId === visit._id).reason, /Waiting for:/);
    });

    it('no state was lost: one booking for Sunita, two walk-ins, every audit trail replays, nothing completed without evidence', async () => {
      const db = ctx.getDb();
      const planBookings = await db.collection('appointments').countDocuments({ 'patient.name': 'Sunita Devi', status: 'confirmed', idempotencyKey: /^planpilot-approval-/ });
      assert.equal(planBookings, 1);
      assert.equal(await db.collection('appointments').countDocuments({ 'patient.name': 'Walk-in Patient', status: 'confirmed' }), 2);
      assert.equal(await db.collection('approvals').countDocuments({ planId: new ObjectId(sunitaPlanId), status: 'failed' }), 2);

      await assertAuditTrailsReplay(db);
      assert.ok(await assertNoCompletionWithoutEvidence(db) >= 1);
      const agentCompletions = await db.collection('task_events').countDocuments({ kind: 'transition', to: 'completed_with_evidence', 'actor.type': 'agent' });
      assert.equal(agentCompletions, 0);
      assert.equal(await db.collection('agent_runs').countDocuments({ planId: new ObjectId(sunitaPlanId) }), 4);
    });
  });

  describe('retries, escalation, and locking', () => {
    let lakshmiPlanId;

    before(async () => {
      const lakshmi = patients.find(p => p.name === 'Lakshmi Bai');
      const res = await clinician.post('/api/care-plans', { patientId: lakshmi._id, templateId: 'post-discharge-chest-pain' });
      lakshmiPlanId = res.data.data.plan._id;
    });

    it('retries a failing step with backoff and succeeds on the third attempt', async () => {
      armFault('agent_action', { times: 2 });
      const run = await runAgent(lakshmiPlanId);
      assert.equal(run.steps[0].outcome, 'done');
      assert.equal(run.steps[0].attempts, 3, 'two injected failures, then success');
      const detail = await getPlan(lakshmiPlanId);
      assert.ok(detail.events.some(e => e.kind === 'feasibility_checked'));
    });

    it('escalates a task with no permitted option instead of leaving it stuck', async () => {
      const lab = taskByKey(await getPlan(lakshmiPlanId), 'lipid_test');
      assert.equal(lab.status, 'escalated', 'Lakshmi can reach no lab and lacks the Aadhaar needed for home collection');
      const queue = (await clinician.get('/api/review-queue')).data.data;
      assert.ok(queue.escalated.some(item => item.task._id === lab._id && /No permitted alternative/.test(item.reason)));
    });

    it('a clinical option the agent picked waits for the clinician', async () => {
      const book = taskByKey(await getPlan(lakshmiPlanId), 'book_followup');
      assert.equal(book.status, 'awaiting_approval');
      assert.equal(book.openApproval.action.kind, 'modality_change');
      assert.equal(book.openApproval.status, 'pending_clinician');
    });

    it('when a step keeps failing, the agent escalates the task with the error rather than failing silently', async () => {
      const book = taskByKey(await getPlan(lakshmiPlanId), 'book_followup');
      await clinician.post(`/api/approvals/${book.openApproval._id}/decision`, { decision: 'reject', note: 'Needs an in-person examination' });

      armFault('agent_action', { times: 3 });
      const run = await runAgent(lakshmiPlanId);
      const step = run.steps.find(s => s.taskId === book._id);
      assert.equal(step.outcome, 'failed_escalated');
      assert.equal(step.attempts, 3);

      const escalated = taskByKey(await getPlan(lakshmiPlanId), 'book_followup');
      assert.equal(escalated.status, 'escalated');
      const queue = (await clinician.get('/api/review-queue')).data.data;
      assert.match(queue.escalated.find(item => item.task._id === book._id).reason, /after 3 attempts/);
    });

    it('never runs twice on the same plan at once', async () => {
      const holder = new ObjectId();
      assert.equal(await acquirePlanAgentLock(lakshmiPlanId, holder, 60_000), true);
      assert.equal(await acquirePlanAgentLock(lakshmiPlanId, new ObjectId(), 60_000), false);

      const busy = await clinician.post(`/api/care-plans/${lakshmiPlanId}/agent-run`, {});
      assert.equal(busy.status, 409);
      assert.equal(busy.data.code, 'AGENT_BUSY');

      await releasePlanAgentLock(lakshmiPlanId, holder);
      assert.equal((await clinician.post(`/api/care-plans/${lakshmiPlanId}/agent-run`, {})).status, 200);
    });

    it('the scheduled tick runs over every active plan; run history is available', async () => {
      const results = await runAgentTick();
      assert.ok(results.length >= 2);
      assert.ok(results.every(r => r.trigger === 'scheduled' && r.status === 'completed'));

      const history = await clinician.get(`/api/care-plans/${lakshmiPlanId}/agent-runs`);
      assert.equal(history.status, 200);
      assert.ok(history.data.data.length >= 3);
      assert.equal((await createClient(ctx.baseUrl).post(`/api/care-plans/${lakshmiPlanId}/agent-run`, {})).status, 401);
    });
  });
});
