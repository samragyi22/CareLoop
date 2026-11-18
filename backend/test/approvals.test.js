import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/testServer.js';
import { loginClinician, loginPatient } from './helpers/fixtures.js';
import { assertNoCompletionWithoutEvidence, assertAuditTrailsReplay } from './helpers/invariants.js';
import { seedClinician } from '../src/scripts/seedUsers.js';
import { seedProvidersAndSchedules } from '../src/scripts/seedAppointments.js';
import { seedDirectory } from '../src/scripts/seedDirectory.js';
import { seedPatients } from '../src/scripts/seedPatientUsers.js';
import { seedCarePlans } from '../src/scripts/seedCarePlans.js';
import { decideAsClinician, respondAsPatient } from '../src/services/approval.service.js';

const SUNITA = { email: 'patient@careloop.local', password: 'CareLoopPatient2026!' };
const RAMESH = { email: 'patient2@careloop.local', password: 'CareLoopPatient2026!' };
// 1x1 transparent PNG
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const AGENT = { type: 'agent', id: null, name: 'PlanPilot agent' };

describe('PlanPilot approvals, evidence capture, and the review queue', () => {
  let ctx;
  let clinician;
  let sunitaPortal;
  let rameshPortal;
  let patients;
  let sunitaPlanId;

  const getPlan = async (planId) => (await clinician.get(`/api/care-plans/${planId}`)).data.data;
  const taskByKey = (detail, key) => detail.tasks.find(t => t.key === key);
  const patientNamed = (name) => patients.find(p => p.name === name);
  const check = (taskId) => clinician.post(`/api/care-tasks/${taskId}/feasibility-check`, {});
  const choose = (task, alternativeId, slotStartAt) => clinician.post(`/api/care-tasks/${task._id}/approvals`, {
    proposalId: task.latestProposal._id,
    alternativeId,
    slotStartAt
  });
  const createPlanFor = async (name) => {
    const res = await clinician.post('/api/care-plans', { patientId: patientNamed(name)._id, templateId: 'post-discharge-chest-pain' });
    assert.equal(res.status, 201);
    return res.data.data.plan._id;
  };
  // Seeded demo appointments are excluded: only bookings PlanPilot made from an approval count here
  const appointmentsFor = (name) => ctx.getDb().collection('appointments')
    .find({ 'patient.name': name, status: 'confirmed', idempotencyKey: /^planpilot-approval-/ }).toArray();

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
    await loginPatient(sunitaPortal, SUNITA);
    rameshPortal = createClient(ctx.baseUrl);
    await loginPatient(rameshPortal, RAMESH);

    patients = (await clinician.get('/api/patients')).data.data;
    const plans = (await clinician.get('/api/care-plans')).data.data;
    sunitaPlanId = plans.find(p => p.patient.name === 'Sunita Devi')._id;
    assert.equal((await clinician.post(`/api/care-plans/${sunitaPlanId}/feasibility-check`, {})).status, 200);
  });

  after(async () => {
    await ctx.stop();
  });

  describe('Sunita: transport barrier → nearby clinic → patient confirms in the portal', () => {
    let approvalId;
    let chosenSlot;

    it('choosing an option books nothing; the task waits for the patient', async () => {
      const book = taskByKey(await getPlan(sunitaPlanId), 'book_followup');
      const nearby = book.latestProposal.alternatives[0];
      assert.equal(nearby.facility.code, 'PHC-SUNDARPUR');
      chosenSlot = nearby.times[1];

      const res = await choose(book, nearby.id, chosenSlot.startAt);
      assert.equal(res.status, 201);
      assert.equal(res.data.data.executed, false);
      assert.equal(res.data.data.approval.status, 'pending_patient');
      approvalId = res.data.data.approval._id;

      const after = taskByKey(await getPlan(sunitaPlanId), 'book_followup');
      assert.equal(after.status, 'awaiting_patient');
      assert.equal(after.openApproval._id, approvalId);
      assert.equal(after.openApproval.action.slot.startAt, chosenSlot.startAt);
      assert.equal(after.latestProposal, null, 'the chosen proposal is no longer open');
      assert.equal((await appointmentsFor('Sunita Devi')).length, 0, 'nothing is booked before the patient confirms');
    });

    it('the approval cannot be bypassed: no second option, no manual move to Requested', async () => {
      const book = taskByKey(await getPlan(sunitaPlanId), 'book_followup');
      const again = await clinician.post(`/api/care-tasks/${book._id}/approvals`, { proposalId: book.openApproval.proposalId, alternativeId: 'alt-1' });
      assert.equal(again.status, 409);

      const manual = await clinician.post(`/api/care-tasks/${book._id}/transition`, { to: 'requested' });
      assert.equal(manual.status, 409);
      assert.equal(manual.data.code, 'APPROVAL_OPEN');
    });

    it('only Sunita can answer, from her own portal; she sees what is needed from her', async () => {
      const stranger = await rameshPortal.post(`/api/patient/care/approvals/${approvalId}/respond`, { decision: 'confirm' });
      assert.equal(stranger.status, 404);
      assert.equal((await createClient(ctx.baseUrl).get('/api/patient/care/plans')).status, 401);

      const view = (await sunitaPortal.get('/api/patient/care/plans')).data.data;
      const book = view.plans[0].tasks.find(t => t.type === 'appointment_booking');
      assert.equal(book.statusLabel, 'Needs your answer');
      assert.equal(book.needsYou, true);
      assert.equal(book.pendingConfirmation.approvalId, approvalId);
      assert.match(book.pendingConfirmation.description, /Sundarpur/);
      assert.ok(view.plans[0].needsYouCount >= 1);
    });

    it('once she confirms, the slot is booked and the booking engine\'s confirmation completes the booking task', async () => {
      const res = await sunitaPortal.post(`/api/patient/care/approvals/${approvalId}/respond`, { decision: 'confirm' });
      assert.equal(res.status, 200);
      assert.equal(res.data.data.executed, true);

      const detail = await getPlan(sunitaPlanId);
      const book = taskByKey(detail, 'book_followup');
      assert.equal(book.status, 'completed_with_evidence');
      assert.equal(book.plannedFacility.code, 'PHC-SUNDARPUR');
      assert.match(book.plannedFacility.changedFrom, /District/);
      assert.equal(book.barriers.filter(b => !b.resolvedAt).length, 0, 'the transport barrier for the old clinic is resolved');
      assert.equal(book.booking.providerName, 'Dr. Farhan Qureshi');
      assert.equal(book.booking.startAt, chosenSlot.startAt);

      assert.equal(book.evidence.length, 1);
      const [evidence] = book.evidence;
      assert.equal(evidence.type, 'booking_confirmed');
      assert.equal(evidence.recordedBy.type, 'system');
      assert.equal(evidence.verifiedReference.bookingReference, book.booking.bookingReference);

      const [appointment] = await appointmentsFor('Sunita Devi');
      assert.equal(appointment.bookingReference, book.booking.bookingReference);
      const sunitaUser = await ctx.getDb().collection('users').findOne({ email: SUNITA.email });
      assert.equal(String(appointment.patientUserId), String(sunitaUser._id), 'the booking shows up in her portal');

      // The visit now happens where it was booked, but still waits for its other prerequisite
      const visit = taskByKey(detail, 'followup_visit');
      assert.equal(visit.plannedFacility.code, 'PHC-SUNDARPUR');
      assert.equal(visit.booking.bookingReference, book.booking.bookingReference);
      assert.equal(visit.barriers.filter(b => !b.resolvedAt).length, 0, 'its transport barrier was about the old clinic');
      assert.notEqual(visit.status, 'completed_with_evidence');

      const kinds = detail.events.filter(e => e.taskId === book._id).map(e => e.kind);
      for (const kind of ['approval_requested', 'patient_confirmed', 'approval_executed', 'logistics_updated', 'barrier_resolved', 'evidence_recorded']) {
        assert.ok(kinds.includes(kind), `audit log has ${kind}`);
      }
      const completion = detail.events.find(e => e.taskId === book._id && e.to === 'completed_with_evidence');
      assert.equal(completion.actor.type, 'system');
    });

    it('her portal shows the booking task done and the visit details', async () => {
      const view = (await sunitaPortal.get('/api/patient/care/plans')).data.data;
      const tasks = view.plans[0].tasks;
      const book = tasks.find(t => t.type === 'appointment_booking');
      assert.equal(book.statusLabel, 'Done');
      const visit = tasks.find(t => t.type === 'follow_up_visit');
      assert.equal(visit.booking.providerName, 'Dr. Farhan Qureshi');
      assert.match(visit.facility.name, /Sundarpur/);
      assert.equal(visit.problems.length, 0);
      assert.match(visit.nextStep, /Attend your visit on .* with Dr\. Farhan Qureshi/);
    });
  });

  describe('Lakshmi (phone only): a teleconsult needs the clinician first', () => {
    let planId;

    it('the clinician can reject the option, with a reason, and the task goes back to Blocked', async () => {
      planId = await createPlanFor('Lakshmi Bai');
      const initial = taskByKey(await getPlan(planId), 'book_followup');
      await check(initial._id);

      const book = taskByKey(await getPlan(planId), 'book_followup');
      const teleconsult = book.latestProposal.alternatives.find(a => a.kind === 'modality_change');
      assert.ok(teleconsult.requiresClinicianApproval);

      const res = await choose(book, teleconsult.id);
      assert.equal(res.status, 201);
      assert.equal(res.data.data.approval.status, 'pending_clinician');
      const approvalId = res.data.data.approval._id;
      assert.equal(taskByKey(await getPlan(planId), 'book_followup').status, 'awaiting_approval');

      // Nobody can answer for the patient before the clinician decides
      assert.equal((await clinician.post(`/api/approvals/${approvalId}/patient-response`, { decision: 'confirm', note: 'by phone' })).status, 409);

      assert.equal((await clinician.post(`/api/approvals/${approvalId}/decision`, { decision: 'reject' })).status, 400);
      const reject = await clinician.post(`/api/approvals/${approvalId}/decision`, { decision: 'reject', note: 'Wants to examine in person first' });
      assert.equal(reject.status, 200);

      const after = taskByKey(await getPlan(planId), 'book_followup');
      assert.equal(after.status, 'blocked');
      assert.equal(after.approvalHistory[0].status, 'rejected');
      assert.ok(after.approvalHistory[0].clinicianDecision.note.includes('in person'));
    });

    it('the agent can never approve or answer for the patient', async () => {
      await check(taskByKey(await getPlan(planId), 'book_followup')._id);
      const book = taskByKey(await getPlan(planId), 'book_followup');
      const res = await choose(book, book.latestProposal.alternatives.find(a => a.kind === 'modality_change').id);
      const approvalId = res.data.data.approval._id;

      await assert.rejects(decideAsClinician({ approvalId, decision: 'approve', actor: AGENT }), { code: 'ACTOR_NOT_ALLOWED' });
      await assert.rejects(respondAsPatient({ approvalId, decision: 'confirm', actor: AGENT }), { code: 'ACTOR_NOT_ALLOWED' });
    });

    it('after approval, staff record her phone confirmation (with a note) and the teleconsult is booked', async () => {
      const book = taskByKey(await getPlan(planId), 'book_followup');
      const approvalId = book.openApproval._id;

      const approve = await clinician.post(`/api/approvals/${approvalId}/decision`, { decision: 'approve', note: 'Teleconsult is fine for this review' });
      assert.equal(approve.status, 200);
      assert.equal(approve.data.data.approval.status, 'pending_patient');
      assert.equal(taskByKey(await getPlan(planId), 'book_followup').status, 'awaiting_patient');

      assert.equal((await clinician.post(`/api/approvals/${approvalId}/patient-response`, { decision: 'confirm' })).status, 400, 'staff must say how she answered');
      const confirm = await clinician.post(`/api/approvals/${approvalId}/patient-response`, { decision: 'confirm', note: 'Confirmed by phone' });
      assert.equal(confirm.status, 200);
      assert.equal(confirm.data.data.executed, true);

      const detail = await getPlan(planId);
      const done = taskByKey(detail, 'book_followup');
      assert.equal(done.status, 'completed_with_evidence');
      assert.equal(done.plannedFacility.code, 'TELE-GP');
      assert.equal(done.plannedFacility.modality, 'teleconsult');
      assert.equal(taskByKey(detail, 'followup_visit').plannedFacility.code, 'TELE-GP');

      const confirmed = detail.events.find(e => e.kind === 'patient_confirmed' && e.taskId === done._id);
      assert.equal(confirmed.actor.type, 'clinician');
      assert.match(confirmed.reason, /recorded by .*Confirmed by phone/);
    });
  });

  describe('Ramesh: the chosen slot is taken before the booking completes', () => {
    it('fails safely: nothing is booked for him, the approval is marked failed, and the task is Blocked with the reason', async () => {
      const planId = await createPlanFor('Ramesh Kumar');
      const initial = taskByKey(await getPlan(planId), 'book_followup');
      const feasibility = await check(initial._id);
      assert.equal(feasibility.data.data.feasible, true, 'Ramesh can reach the planned clinic');

      const proposed = await clinician.post(`/api/care-tasks/${initial._id}/planned-booking`, {});
      assert.equal(proposed.status, 201);
      const approval = proposed.data.data.approval;
      assert.equal(approval.status, 'pending_patient');
      assert.equal(approval.action.kind, 'book_planned');

      // Someone else takes the slot at the clinic desk
      const { slot } = approval.action;
      const walkIn = await clinician.post('/api/appointments', {
        providerId: slot.providerId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        patient: { name: 'Walk-in Patient', phone: '+15550100199' }
      });
      assert.equal(walkIn.status, 201);

      const confirm = await rameshPortal.post(`/api/patient/care/approvals/${approval._id}/respond`, { decision: 'confirm' });
      assert.equal(confirm.status, 200);
      assert.equal(confirm.data.data.executed, false);
      assert.ok(confirm.data.data.failure);

      const book = taskByKey(await getPlan(planId), 'book_followup');
      assert.equal(book.status, 'blocked');
      assert.equal(book.openApproval, null);
      assert.equal(book.approvalHistory[0].status, 'failed');
      assert.equal(book.approvalHistory[0].execution.code, 'SLOT_TAKEN');
      assert.equal(book.evidence.length, 0);
      assert.equal((await appointmentsFor('Ramesh Kumar')).length, 0);
    });
  });

  describe('documents: an upload is not evidence until a clinician verifies it', () => {
    let submissionId;
    let docsTask;

    it('Sunita uploads her discharge summary; bad or oversized files and other patients are refused', async () => {
      docsTask = taskByKey(await getPlan(sunitaPlanId), 'discharge_summary');
      const url = `/api/patient/care/tasks/${docsTask._id}/documents`;

      assert.equal((await sunitaPortal.post(url, { fileName: 'a.txt', mimeType: 'text/plain', contentBase64: 'aGVsbG8=' })).status, 415);
      assert.equal((await sunitaPortal.post(url, { fileName: 'fake.png', mimeType: 'image/png', contentBase64: Buffer.from('%PDF-1.4 not a png').toString('base64') })).status, 415);
      const big = Buffer.concat([Buffer.from(PNG_BASE64, 'base64'), Buffer.alloc(2.6 * 1024 * 1024)]).toString('base64');
      assert.equal((await sunitaPortal.post(url, { fileName: 'big.png', mimeType: 'image/png', contentBase64: big })).status, 413);
      assert.equal((await rameshPortal.post(url, { fileName: 'x.png', mimeType: 'image/png', contentBase64: PNG_BASE64 })).status, 404);

      const res = await sunitaPortal.post(url, { fileName: '../../discharge summary.png', mimeType: 'image/png', contentBase64: PNG_BASE64 });
      assert.equal(res.status, 201);
      assert.equal(res.data.data.fileName, 'discharge summary.png');
      submissionId = res.data.data._id;

      const after = taskByKey(await getPlan(sunitaPlanId), 'discharge_summary');
      assert.equal(after.status, docsTask.status, 'an upload does not move the task');
      assert.equal(after.evidence.length, 0);
      assert.equal(after.documentSubmissions[0].status, 'pending_review');
    });

    it('the clinician sees it in the review queue and can open the file safely', async () => {
      const queue = (await clinician.get('/api/review-queue')).data.data;
      assert.ok(queue.documents.some(d => d.submissionId === submissionId && d.patient.name === 'Sunita Devi'));

      const res = await fetch(`${ctx.baseUrl}/api/document-submissions/${submissionId}/file`, {
        headers: { Cookie: (await clinicianCookie()) }
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.match(res.headers.get('content-security-policy'), /sandbox/);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(PNG_BASE64, 'base64'));
    });

    it('verifying records the evidence, clears the missing-document barrier, and completes the task', async () => {
      assert.equal((await clinician.post(`/api/document-submissions/${submissionId}/review`, { decision: 'reject' })).status, 400);
      const res = await clinician.post(`/api/document-submissions/${submissionId}/review`, { decision: 'verify', note: 'Legible copy' });
      assert.equal(res.status, 200);
      assert.equal(res.data.data.completed, true);

      const done = taskByKey(await getPlan(sunitaPlanId), 'discharge_summary');
      assert.equal(done.status, 'completed_with_evidence');
      assert.equal(done.evidence[0].type, 'document_verified');
      assert.equal(done.evidence[0].recordedBy.type, 'clinician');
      assert.equal(done.barriers.filter(b => !b.resolvedAt).length, 0);

      assert.equal((await clinician.post(`/api/document-submissions/${submissionId}/review`, { decision: 'verify' })).status, 409);
    });
  });

  describe('review queue', () => {
    it('needs a clinician login', async () => {
      assert.equal((await createClient(ctx.baseUrl).get('/api/review-queue')).status, 401);
      assert.equal((await sunitaPortal.get('/api/review-queue')).status, 401);
    });

    it('shows escalations with their reason and pending clinician approvals, and nothing invented', async () => {
      const lab = taskByKey(await getPlan(sunitaPlanId), 'lipid_test');
      await clinician.post(`/api/care-tasks/${lab._id}/transition`, { to: 'escalated', reason: 'Patient reports new chest discomfort' });

      const queue = (await clinician.get('/api/review-queue')).data.data;
      const escalated = queue.escalated.find(item => item.task._id === lab._id);
      assert.match(escalated.reason, /chest discomfort/);
      assert.equal(queue.counts.escalated, queue.escalated.length);
      assert.equal(queue.counts.needsClinician, 0);
      assert.equal(queue.recentFailures.length, 1, 'Ramesh\'s failed booking is visible');
      assert.equal(queue.actionRequired, queue.counts.needsClinician + queue.counts.documents + queue.counts.escalated + queue.counts.unableToVerify + queue.counts.evidenceToRecord);
    });
  });

  it('no completed task anywhere lacks its evidence, and every task\'s audit trail replays to its status', async () => {
    const db = ctx.getDb();
    assert.ok(await assertNoCompletionWithoutEvidence(db) >= 3);
    assert.ok(await assertAuditTrailsReplay(db) >= 12);
  });

  async function clinicianCookie() {
    const res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'clinician@careloop.local', password: 'CareLoop2026!' })
    });
    return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  }
});
