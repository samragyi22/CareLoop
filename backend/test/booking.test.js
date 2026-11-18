import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/testServer.js';
import { createClinician, createProviderWithSchedule, slotAt, loginClinician } from './helpers/fixtures.js';

describe('appointment booking engine', () => {
  let ctx;
  let clinician;
  let provider;
  let windowStart;

  const patient = { name: 'Ramesh Kumar', phone: '+15550100102', email: '' };

  before(async () => {
    ctx = await startTestServer();
    await createClinician();
    // 6-hour window = 12 half-hour slots (indexes 0-11); index 20 is outside it
    ({ provider, windowStart } = await createProviderWithSchedule({ hours: 6 }));
    clinician = createClient(ctx.baseUrl);
    await loginClinician(clinician);
  });

  after(async () => {
    await ctx.stop();
  });

  const book = (slotIndex, extra = {}) => clinician.post('/api/appointments', {
    providerId: provider._id,
    ...slotAt(windowStart, slotIndex),
    patient,
    ...extra
  });

  it('books a free slot and removes it from available slots', async () => {
    const res = await book(0);
    assert.equal(res.status, 201);
    assert.match(res.data.data.bookingReference, /^CL-[A-Z0-9]{6}$/);

    const slots = await clinician.get(`/api/appointments/slots?providerId=${provider._id}`);
    assert.equal(slots.status, 200);
    assert.ok(!slots.data.data.some(s => s.startAt === slotAt(windowStart, 0).startAt));
  });

  it('rejects exact and partial overlaps with 409', async () => {
    const exact = await book(0);
    assert.equal(exact.status, 409);
    assert.equal(exact.data.code, 'SLOT_CONFLICT');

    const partialStart = new Date(new Date(slotAt(windowStart, 0).startAt).getTime() + 15 * 60 * 1000);
    const partial = await clinician.post('/api/appointments', {
      providerId: provider._id,
      startAt: partialStart.toISOString(),
      endAt: new Date(partialStart.getTime() + 30 * 60 * 1000).toISOString(),
      patient
    });
    assert.equal(partial.status, 409);
  });

  it('allows back-to-back appointments that only touch at the boundary', async () => {
    const res = await book(1);
    assert.equal(res.status, 201);
  });

  it('replays an idempotent request and rejects a reused key with a different payload', async () => {
    const first = await book(2, { idempotencyKey: 'test-key-1' });
    assert.equal(first.status, 201);

    const replay = await book(2, { idempotencyKey: 'test-key-1' });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.idempotentReplay, true);
    assert.equal(replay.data.data.bookingReference, first.data.data.bookingReference);

    const mismatch = await book(3, { idempotencyKey: 'test-key-1' });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.data.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('rejects slots outside availability and in the past', async () => {
    const outside = await book(20);
    assert.equal(outside.status, 400);
    assert.equal(outside.data.code, 'OUTSIDE_AVAILABILITY');

    const past = await clinician.post('/api/appointments', {
      providerId: provider._id,
      startAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      endAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      patient
    });
    assert.equal(past.status, 400);
    assert.equal(past.data.code, 'PAST_SLOT_NOT_ALLOWED');
  });

  it('lets exactly one of several concurrent requests win the same slot', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, i) => book(4, { idempotencyKey: `race-${i}` }))
    );
    const statuses = attempts.map(r => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
  });

  it('records who cancelled and why, and frees the slot', async () => {
    const created = await book(5);
    const id = created.data.data._id;

    const cancel = await clinician.post(`/api/appointments/${id}/cancel`, { reason: 'Patient travelling' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.data.status, 'cancelled');
    assert.equal(cancel.data.data.cancellationReason, 'Patient travelling');
    assert.equal(cancel.data.data.cancelledBy, 'clinician');

    const rebook = await book(5);
    assert.equal(rebook.status, 201);
  });

  it('reschedules atomically and keeps history', async () => {
    const created = await book(6);
    const id = created.data.data._id;

    const res = await clinician.post(`/api/appointments/${id}/reschedule`, {
      newStartAt: slotAt(windowStart, 7).startAt,
      newEndAt: slotAt(windowStart, 7).endAt
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.data.rescheduledFrom, id);

    const original = await clinician.get(`/api/appointments/${id}`);
    assert.equal(original.data.data.status, 'cancelled');
    assert.equal(original.data.data.cancelledBy, 'system');
  });

  it('keeps the original appointment when the reschedule target is taken', async () => {
    const created = await book(8);
    assert.equal(created.status, 201);
    const id = created.data.data._id;

    const res = await clinician.post(`/api/appointments/${id}/reschedule`, {
      newStartAt: slotAt(windowStart, 0).startAt,
      newEndAt: slotAt(windowStart, 0).endAt
    });
    assert.equal(res.status, 409);

    const original = await clinician.get(`/api/appointments/${id}`);
    assert.equal(original.data.data.status, 'confirmed');
  });
});
