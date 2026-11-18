import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/testServer.js';
import {
  createClinician,
  createPatientUser,
  createProviderWithSchedule,
  slotAt,
  loginClinician,
  loginPatient,
  PATIENT,
  CLINICIAN
} from './helpers/fixtures.js';
import { closeDb, connectDb } from '../src/config/db.js';

describe('PlanPilot care plans and tasks', () => {
  let ctx;
  let clinician;
  let patientRecord;
  let otherPatientRecord;
  let provider;
  let windowStart;

  before(async () => {
    ctx = await startTestServer();
    await createClinician();
    await createPatientUser();
    ({ provider, windowStart } = await createProviderWithSchedule({ hours: 4 }));
    clinician = createClient(ctx.baseUrl);
    await loginClinician(clinician);

    patientRecord = (await clinician.post('/api/patients', { name: PATIENT.name, phone: PATIENT.phone, preferredLanguage: 'hi' })).data.data;
    otherPatientRecord = (await clinician.post('/api/patients', { name: 'Ramesh Kumar', phone: '+15550100102', preferredLanguage: 'en' })).data.data;
  });

  after(async () => {
    await ctx.stop();
  });

  const createFromTemplate = (patientId = patientRecord._id) =>
    clinician.post('/api/care-plans', { patientId, templateId: 'post-discharge-chest-pain' });
  const transition = (taskId, to, reason) => clinician.post(`/api/care-tasks/${taskId}/transition`, { to, reason });
  const addEvidence = (taskId, type, extra = {}) => clinician.post(`/api/care-tasks/${taskId}/evidence`, { type, ...extra });
  const taskByKey = (detail, key) => detail.tasks.find(t => t.key === key);
  const getPlan = async (planId) => (await clinician.get(`/api/care-plans/${planId}`)).data.data;
  const bookFor = async (slotIndex, patient) => (await clinician.post('/api/appointments', {
    providerId: provider._id,
    ...slotAt(windowStart, slotIndex),
    patient
  })).data.data;

  describe('access', () => {
    it('is clinician-only', async () => {
      assert.equal((await createClient(ctx.baseUrl).get('/api/care-plans')).status, 401);

      const portal = createClient(ctx.baseUrl);
      await loginPatient(portal);
      assert.equal((await portal.get('/api/care-plans')).status, 401);
      assert.equal((await portal.get('/api/patients')).status, 401);
    });

    it('keeps the clinician patient registry separate from the patient portal routes', async () => {
      const res = await clinician.get('/api/patients');
      assert.equal(res.status, 200);
      assert.equal(res.data.count, 2);
    });
  });

  describe('creating plans', () => {
    it('creates a plan from a template with every task suggested, linked, and logged', async () => {
      const res = await createFromTemplate();
      assert.equal(res.status, 201);
      const { plan, tasks, events } = res.data.data;

      assert.equal(plan.status, 'active');
      assert.equal(plan.approvedBy.name, CLINICIAN.name);
      assert.equal(tasks.length, 4);
      assert.ok(tasks.every(t => t.status === 'suggested'));
      assert.equal(events.filter(e => e.kind === 'created').length, 4);

      const visit = tasks.find(t => t.key === 'followup_visit');
      const prerequisites = tasks.filter(t => ['book_followup', 'discharge_summary'].includes(t.key)).map(t => t._id).sort();
      assert.deepEqual([...visit.dependsOn].sort(), prerequisites);
      assert.deepEqual(visit.requiredEvidence, ['visit_attended']);
      assert.match(visit.clinicalInstruction, /General Practice within 7 days/);
    });

    it('rejects plans with dependency loops, unknown dependencies, or unknown task types', async () => {
      const base = { patientId: patientRecord._id, title: 'Custom plan' };
      const task = (key, dependsOn = [], type = 'lab_test') => ({ key, type, title: key, clinicalInstruction: 'Do it', owner: 'patient', dueInDays: 3, dependsOn });

      const loop = await clinician.post('/api/care-plans', {
        ...base,
        tasks: [task('task_a', ['task_b']), task('task_b', ['task_c']), task('task_c', ['task_a'])]
      });
      assert.equal(loop.status, 400);
      assert.equal(loop.data.code, 'DEPENDENCY_CYCLE');
      assert.deepEqual(loop.data.details.cycle, ['task_a', 'task_b', 'task_c', 'task_a']);

      const unknownDep = await clinician.post('/api/care-plans', { ...base, tasks: [task('task_a', ['missing'])] });
      assert.equal(unknownDep.status, 400);
      assert.equal(unknownDep.data.code, 'INVALID_PLAN');

      const badType = await clinician.post('/api/care-plans', { ...base, tasks: [task('task_a', [], 'surgery')] });
      assert.equal(badType.status, 400);

      const unknownPatient = await clinician.post('/api/care-plans', { patientId: '507f1f77bcf86cd799439011', templateId: 'post-discharge-chest-pain' });
      assert.equal(unknownPatient.status, 404);
    });
  });

  describe('task transitions', () => {
    let detail;

    before(async () => {
      detail = (await createFromTemplate()).data.data;
    });

    it('will not start a task before its prerequisites are completed', async () => {
      const res = await transition(taskByKey(detail, 'followup_visit')._id, 'requested');
      assert.equal(res.status, 422);
      assert.equal(res.data.code, 'DEPENDENCIES_INCOMPLETE');
    });

    it('refuses illegal jumps and requires a reason to block', async () => {
      const book = taskByKey(detail, 'book_followup');
      const jump = await transition(book._id, 'completed_with_evidence');
      assert.equal(jump.status, 409);
      assert.equal(jump.data.code, 'ILLEGAL_TRANSITION');

      const noReason = await transition(book._id, 'blocked');
      assert.equal(noReason.status, 400);
      assert.equal(noReason.data.code, 'REASON_REQUIRED');

      const blocked = await transition(book._id, 'blocked', 'Patient has no transport to the clinic');
      assert.equal(blocked.status, 200);
      assert.equal(blocked.data.data.event.reason, 'Patient has no transport to the clinic');

      const replanned = await transition(book._id, 'suggested', 'Alternative clinic found');
      assert.equal(replanned.status, 200);
    });

    it('does not count a request as done: completion needs a real, confirmed booking for this patient', async () => {
      const book = taskByKey(detail, 'book_followup');
      assert.equal((await transition(book._id, 'requested')).status, 200);

      const noEvidence = await transition(book._id, 'completed_with_evidence');
      assert.equal(noEvidence.status, 422);
      assert.equal(noEvidence.data.code, 'EVIDENCE_MISSING');

      assert.equal((await addEvidence(book._id, 'booking_confirmed')).data.code, 'REFERENCE_REQUIRED');
      assert.equal((await addEvidence(book._id, 'booking_confirmed', { reference: 'CL-NOTREAL' })).status, 422);

      const someoneElses = await bookFor(0, { name: 'Ramesh Kumar', phone: '+15550100102' });
      const wrongPatient = await addEvidence(book._id, 'booking_confirmed', { reference: someoneElses.bookingReference });
      assert.equal(wrongPatient.status, 422);
      assert.match(wrongPatient.data.message, /does not belong/);

      const wrongType = await addEvidence(book._id, 'visit_attended');
      assert.equal(wrongType.status, 400);
      assert.equal(wrongType.data.code, 'EVIDENCE_NOT_APPLICABLE');

      const theirs = await bookFor(1, { name: PATIENT.name, phone: PATIENT.phone });
      const recorded = await addEvidence(book._id, 'booking_confirmed', { reference: theirs.bookingReference });
      assert.equal(recorded.status, 201);
      assert.equal(recorded.data.data.verifiedReference.bookingReference, theirs.bookingReference);

      const duplicate = await addEvidence(book._id, 'booking_confirmed', { reference: theirs.bookingReference });
      assert.equal(duplicate.status, 409);

      const completed = await transition(book._id, 'completed_with_evidence');
      assert.equal(completed.status, 200);
      assert.equal(completed.data.data.task.status, 'completed_with_evidence');
    });

    it('lets only one of two simultaneous changes to the same task win', async () => {
      const docs = taskByKey(detail, 'discharge_summary');
      await transition(docs._id, 'requested');
      const results = await Promise.all([
        transition(docs._id, 'confirmed'),
        transition(docs._id, 'confirmed')
      ]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    });
  });

  describe('full plan lifecycle', () => {
    it('completes the plan only when every task has evidence, logs everything, and survives a restart', async () => {
      const detail = (await createFromTemplate(otherPatientRecord._id)).data.data;
      const id = (key) => taskByKey(detail, key)._id;
      const ok = async (promise) => {
        const res = await promise;
        assert.ok(res.status < 300, `${res.status} ${JSON.stringify(res.data)}`);
        return res;
      };

      // Lab test: received is not enough, a clinician must review it
      await ok(transition(id('lipid_test'), 'requested'));
      await ok(addEvidence(id('lipid_test'), 'report_received', { note: 'Uploaded by lab' }));
      assert.equal((await transition(id('lipid_test'), 'completed_with_evidence')).status, 422);
      await ok(addEvidence(id('lipid_test'), 'report_reviewed'));
      await ok(transition(id('lipid_test'), 'completed_with_evidence'));

      // Booking
      const appointment = await bookFor(2, { name: 'Ramesh Kumar', phone: '+15550100102' });
      await ok(transition(id('book_followup'), 'requested'));
      await ok(addEvidence(id('book_followup'), 'booking_confirmed', { reference: appointment.bookingReference }));
      await ok(transition(id('book_followup'), 'completed_with_evidence'));

      // Document
      await ok(transition(id('discharge_summary'), 'requested'));
      await ok(addEvidence(id('discharge_summary'), 'document_verified'));
      await ok(transition(id('discharge_summary'), 'completed_with_evidence'));

      // Visit, now that its prerequisites are done
      await ok(transition(id('followup_visit'), 'requested'));
      await ok(transition(id('followup_visit'), 'confirmed'));
      await ok(transition(id('followup_visit'), 'in_progress'));
      await ok(addEvidence(id('followup_visit'), 'visit_attended'));
      const last = await ok(transition(id('followup_visit'), 'completed_with_evidence'));
      assert.equal(last.data.data.planCompleted, true);

      const finished = await getPlan(detail.plan._id);
      assert.equal(finished.plan.status, 'completed');
      assert.equal(finished.plan.progress.completed, 4);
      assert.ok(finished.tasks.every(t => t.nextTransitions.length === 0));

      // Audit: 4 created + 10 successful transitions + 5 evidence events (refused attempts are not changes)
      assert.equal(finished.events.length, 4 + 10 + 5);
      assert.equal(finished.events.filter(e => e.kind === 'transition').length, 10);
      assert.equal(finished.events.filter(e => e.kind === 'evidence_recorded').length, 5);
      assert.ok(finished.events.every(e => e.actor.type === 'clinician' && e.actor.name === CLINICIAN.name));

      // A closed plan cannot change
      const afterClose = await transition(id('lipid_test'), 'blocked', 'late change');
      assert.equal(afterClose.status, 409);

      // Simulated restart: drop and re-open the database connection, then re-read
      await closeDb();
      await connectDb();
      const reloaded = await getPlan(detail.plan._id);
      assert.deepEqual(reloaded.tasks.map(t => t.status), finished.tasks.map(t => t.status));
      assert.equal(reloaded.events.length, finished.events.length);
    });
  });
});
