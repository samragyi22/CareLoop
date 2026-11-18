import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer, createClient } from './helpers/testServer.js';
import { loginClinician } from './helpers/fixtures.js';
import { seedClinician } from '../src/scripts/seedUsers.js';
import { seedProvidersAndSchedules } from '../src/scripts/seedAppointments.js';
import { seedDirectory } from '../src/scripts/seedDirectory.js';
import { seedPatients } from '../src/scripts/seedPatientUsers.js';
import { seedCarePlans } from '../src/scripts/seedCarePlans.js';
import { createVoiceCall } from '../src/repositories/voiceCall.repository.js';

describe('PlanPilot feasibility checks and replanning (seeded demo district)', () => {
  let ctx;
  let clinician;
  let patients;
  let sunitaPlan;

  const taskByKey = (detail, key) => detail.tasks.find(t => t.key === key);
  const getPlan = async (planId) => (await clinician.get(`/api/care-plans/${planId}`)).data.data;
  const check = (taskId) => clinician.post(`/api/care-tasks/${taskId}/feasibility-check`, {});
  const patientNamed = (name) => patients.find(p => p.name === name);

  before(async () => {
    ctx = await startTestServer();
    await seedClinician();
    await seedProvidersAndSchedules();
    await seedDirectory();
    await seedPatients();
    await seedCarePlans();

    clinician = createClient(ctx.baseUrl);
    await loginClinician(clinician, { email: 'clinician@careloop.local', password: 'CareLoop2026!' });
    patients = (await clinician.get('/api/patients')).data.data;
    const plans = (await clinician.get('/api/care-plans')).data.data;
    sunitaPlan = await getPlan(plans.find(p => p.patient.name === 'Sunita Devi')._id);
  });

  after(async () => {
    await ctx.stop();
  });

  it('serves a clearly labelled simulated directory to clinicians only', async () => {
    assert.equal((await createClient(ctx.baseUrl).get('/api/directory')).status, 401);

    const res = await clinician.get('/api/directory');
    assert.equal(res.status, 200);
    assert.equal(res.data.count, 7);
    assert.ok(res.data.data.every(f => f.isSimulated === true));
    assert.match(res.data.notice, /SIMULATED/);
  });

  it('transport barrier: blocks the booking task and proposes the nearby health centre with real slots before the deadline', async () => {
    const book = taskByKey(sunitaPlan, 'book_followup');
    const res = await check(book._id);
    assert.equal(res.status, 200);
    const result = res.data.data;

    assert.equal(result.feasible, false);
    assert.deepEqual(result.barriers.map(b => b.code), ['TRANSPORT']);
    assert.match(result.barriers[0].detail, /15\.2 km away/);
    assert.equal(result.blocked, true);
    assert.equal(result.task.status, 'blocked');

    const proposal = result.proposal;
    assert.equal(proposal.recommendation, 'choose_alternative');
    const [nearby, teleconsult] = proposal.alternatives;

    assert.equal(nearby.kind, 'facility_change');
    assert.equal(nearby.facility.code, 'PHC-SUNDARPUR');
    assert.ok(nearby.facility.distanceKm <= 5);
    assert.ok(nearby.times.length > 0);
    assert.ok(nearby.times.every(s => s.providerName === 'Dr. Farhan Qureshi'));
    assert.ok(nearby.times.every(s => new Date(s.endAt) <= new Date(book.dueAt)), 'slots must be before the deadline');
    assert.equal(nearby.requiresClinicianApproval, false);

    assert.equal(teleconsult.kind, 'modality_change');
    assert.equal(teleconsult.facility.code, 'TELE-GP');
    assert.equal(teleconsult.requiresClinicianApproval, true);

    const proposedCodes = proposal.alternatives.map(a => a.facility?.code);
    assert.ok(!proposedCodes.includes('PHC-KESHAVGANJ'), 'too far for Sunita');
  });

  it('records the check, the barrier, the block, and the proposal in the audit log', async () => {
    const detail = await getPlan(sunitaPlan.plan._id);
    const book = taskByKey(detail, 'book_followup');
    const kinds = detail.events.filter(e => e.taskId === book._id).map(e => e.kind);
    assert.deepEqual(kinds.slice(-4), ['feasibility_checked', 'barrier_detected', 'transition', 'replan_proposed']);

    const block = detail.events.find(e => e.taskId === book._id && e.kind === 'transition');
    assert.equal(block.actor.type, 'system');
    assert.equal(block.to, 'blocked');

    assert.equal(book.barriers.filter(b => !b.resolvedAt).length, 1);
    assert.equal(book.latestProposal.alternatives[0].facility.code, 'PHC-SUNDARPUR');
    assert.equal(book.plannedFacility.code, 'CARELOOP-DISTRICT');
  });

  it('does not duplicate barriers or proposals when re-checked', async () => {
    const book = taskByKey(sunitaPlan, 'book_followup');
    const taskId = new ObjectId(book._id);
    await check(book._id);
    await check(book._id);

    const db = ctx.getDb();
    assert.equal(await db.collection('barriers').countDocuments({ taskId, code: 'TRANSPORT', resolvedAt: null }), 1);
    assert.equal(await db.collection('replan_proposals').countDocuments({ taskId, status: 'proposed' }), 1);
    assert.ok(await db.collection('replan_proposals').countDocuments({ taskId, status: 'superseded' }) >= 2);
  });

  it('checks the whole plan: lab alternatives, a missing document, and a visit too far away', async () => {
    const res = await clinician.post(`/api/care-plans/${sunitaPlan.plan._id}/feasibility-check`, {});
    assert.equal(res.status, 200);
    assert.equal(res.data.data.checked, 4);

    const detail = await getPlan(sunitaPlan.plan._id);
    const lab = taskByKey(detail, 'lipid_test');
    assert.deepEqual(lab.barriers.filter(b => !b.resolvedAt).map(b => b.code), ['TRANSPORT']);
    const labOptions = lab.latestProposal.alternatives.map(a => a.facility.code);
    assert.ok(labOptions.includes('LAB-SUNDARPUR'));
    assert.ok(labOptions.includes('HOME-COLLECTION'));
    assert.ok(lab.latestProposal.alternatives.every(a => a.requiresClinicianApproval === false), 'same test elsewhere is logistics, not a clinical change');

    const docs = taskByKey(detail, 'discharge_summary');
    assert.equal(docs.barriers[0].code, 'MISSING_DOCUMENT');
    assert.equal(docs.latestProposal.alternatives[0].kind, 'request_document');

    const visit = taskByKey(detail, 'followup_visit');
    assert.equal(visit.status, 'blocked');
    assert.equal(visit.barriers[0].code, 'TRANSPORT');
  });

  it('auto-resolves a rule-found barrier once it no longer applies, without unblocking the task by itself', async () => {
    const sunita = patientNamed('Sunita Devi');
    const update = await clinician.patch(`/api/patients/${sunita._id}/logistics`, { constraints: { hasOwnTransport: true, maxTravelKm: 20 } });
    assert.equal(update.status, 200);

    const book = taskByKey(sunitaPlan, 'book_followup');
    const res = await check(book._id);
    assert.equal(res.data.data.feasible, true);
    assert.equal(res.data.data.task.status, 'blocked', 'moving forward stays an explicit decision');

    const detail = await getPlan(sunitaPlan.plan._id);
    const barrier = taskByKey(detail, 'book_followup').barriers.find(b => b.code === 'TRANSPORT');
    assert.ok(barrier.resolvedAt);
    assert.equal(barrier.resolution, 'No longer detected on re-check');
    assert.equal(taskByKey(detail, 'book_followup').latestProposal, null, 'old proposal superseded');

    await clinician.patch(`/api/patients/${sunita._id}/logistics`, { constraints: { hasOwnTransport: false, maxTravelKm: 5 } });
  });

  it('phone-only patient without documents: only a teleconsult is possible, and it needs clinician approval', async () => {
    const lakshmi = patientNamed('Lakshmi Bai');
    const created = await clinician.post('/api/care-plans', { patientId: lakshmi._id, templateId: 'post-discharge-chest-pain' });
    const book = taskByKey(created.data.data, 'book_followup');

    const result = (await check(book._id)).data.data;
    assert.deepEqual(result.barriers.map(b => b.code), ['TRANSPORT']);
    assert.deepEqual(result.proposal.alternatives.map(a => a.facility.code), ['TELE-GP']);
    assert.equal(result.proposal.alternatives[0].requiresClinicianApproval, true);
  });

  it('detects an unreachable patient from unanswered calls and proposes the caregiver, with consent', async () => {
    const sunita = patientNamed('Sunita Devi');
    for (const [i, status] of ['no-answer', 'busy'].entries()) {
      await createVoiceCall({ callSid: `CA-TEST-MISSED-${i}`, from: '+15550000999', to: sunita.phone, direction: 'outbound', status, isMock: true });
    }

    const visit = taskByKey(sunitaPlan, 'followup_visit');
    const result = (await check(visit._id)).data.data;
    assert.ok(result.barriers.some(b => b.code === 'NO_RESPONSE'));
    const caregiver = result.proposal.alternatives.find(a => a.kind === 'contact_caregiver');
    assert.equal(caregiver.caregiverName, 'Ravi (son)');
    assert.equal(caregiver.requiresClinicianApproval, true);
  });

  describe('reported barriers', () => {
    let detail;

    before(async () => {
      const ramesh = patientNamed('Ramesh Kumar');
      detail = (await clinician.post('/api/care-plans', { patientId: ramesh._id, templateId: 'diabetes-quarterly-review' })).data.data;
    });

    it('validates the code and the description', async () => {
      const task = taskByKey(detail, 'hba1c_test');
      assert.equal((await clinician.post(`/api/care-tasks/${task._id}/barriers`, { code: 'BAD', detail: 'x' })).status, 400);
      assert.equal((await clinician.post(`/api/care-tasks/${task._id}/barriers`, { code: 'OTHER', detail: '' })).status, 400);
    });

    it('blocks the task and logs who reported it', async () => {
      const task = taskByKey(detail, 'hba1c_test');
      const res = await clinician.post(`/api/care-tasks/${task._id}/barriers`, { code: 'TRANSPORT', detail: 'Bus service suspended this week' });
      assert.equal(res.status, 201);
      assert.equal(res.data.data.task.status, 'blocked');
      assert.equal(res.data.data.emergency, null);
      assert.equal(res.data.data.barrier.source, 'reported');

      const resolved = await clinician.post(`/api/care-tasks/${task._id}/barriers/${res.data.data.barrier._id}/resolve`, { resolution: 'Neighbour will drive him' });
      assert.equal(resolved.status, 200);
      assert.ok(resolved.data.data.resolvedAt);
      const again = await clinician.post(`/api/care-tasks/${task._id}/barriers/${res.data.data.barrier._id}/resolve`, { resolution: 'twice' });
      assert.equal(again.status, 409);
    });

    it('escalates immediately and returns emergency guidance when the report describes an emergency', async () => {
      const task = taskByKey(detail, 'book_review');
      const res = await clinician.post(`/api/care-tasks/${task._id}/barriers`, {
        code: 'OTHER',
        detail: 'Patient called to cancel, said he has chest pain and cannot breathe properly'
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.data.task.status, 'escalated');
      assert.equal(res.data.data.barrier.emergencyFlag, true);
      assert.equal(res.data.data.emergency.emergencyNumber, '112');
    });
  });
});
