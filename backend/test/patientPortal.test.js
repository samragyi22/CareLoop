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
  PATIENT
} from './helpers/fixtures.js';

describe('patient portal appointment ownership', () => {
  let ctx;
  let clinician;
  let provider;
  let windowStart;
  const OTHER_PATIENT = { email: 'other@test.local', password: 'Other-Pass-1!', name: 'Ramesh Kumar', phone: '+15550100102' };

  before(async () => {
    ctx = await startTestServer();
    await createClinician();
    await createPatientUser();
    await createPatientUser(OTHER_PATIENT);
    ({ provider, windowStart } = await createProviderWithSchedule({ hours: 4 }));
    clinician = createClient(ctx.baseUrl);
    await loginClinician(clinician);
  });

  after(async () => {
    await ctx.stop();
  });

  const bookFor = (slotIndex, patient) => clinician.post('/api/appointments', {
    providerId: provider._id,
    ...slotAt(windowStart, slotIndex),
    patient
  });

  it('shows a clinician booking with no email to the patient whose phone and name match', async () => {
    const created = await bookFor(0, { name: 'Sunita Devi', phone: PATIENT.phone, email: '' });
    assert.equal(created.status, 201);
    assert.ok(created.data.data.patientUserId, 'appointment should be linked to the patient account');

    const portal = createClient(ctx.baseUrl);
    await loginPatient(portal);
    const list = await portal.get('/api/patient/appointments');
    assert.equal(list.status, 200);
    assert.ok(list.data.data.upcoming.some(a => a._id === created.data.data._id));
  });

  it('does not link a booking when a shared phone belongs to someone with a different name', async () => {
    const created = await bookFor(1, { name: 'Geeta Devi', phone: PATIENT.phone, email: '' });
    assert.equal(created.status, 201);
    assert.equal(created.data.data.patientUserId, null);

    const portal = createClient(ctx.baseUrl);
    await loginPatient(portal);
    const list = await portal.get('/api/patient/appointments');
    assert.ok(!list.data.data.upcoming.some(a => a._id === created.data.data._id));

    const direct = await portal.get(`/api/patient/appointments/${created.data.data._id}`);
    assert.equal(direct.status, 404);
  });

  it("hides another patient's appointment even by direct ID", async () => {
    const created = await bookFor(2, { name: OTHER_PATIENT.name, phone: OTHER_PATIENT.phone, email: OTHER_PATIENT.email });
    assert.equal(created.status, 201);

    const portal = createClient(ctx.baseUrl);
    await loginPatient(portal);
    const direct = await portal.get(`/api/patient/appointments/${created.data.data._id}`);
    assert.equal(direct.status, 404);
  });

  it('keeps the account link through a patient reschedule, and records patient cancellations', async () => {
    const created = await bookFor(3, { name: 'Sunita Devi', phone: PATIENT.phone, email: PATIENT.email });
    const portal = createClient(ctx.baseUrl);
    await loginPatient(portal);

    const moved = await portal.post(`/api/patient/appointments/${created.data.data._id}/reschedule`, {
      newStartAt: slotAt(windowStart, 4).startAt,
      newEndAt: slotAt(windowStart, 4).endAt
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.data.patientUserId, created.data.data.patientUserId);

    const noConfirm = await portal.post(`/api/patient/appointments/${moved.data.data._id}/cancel`, {});
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.data.code, 'CONFIRMATION_REQUIRED');

    const cancelled = await portal.post(`/api/patient/appointments/${moved.data.data._id}/cancel`, { confirmed: true, reason: 'Feeling better' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.data.cancelledBy, 'patient');
    assert.equal(cancelled.data.data.cancellationReason, 'Feeling better');
  });
});
