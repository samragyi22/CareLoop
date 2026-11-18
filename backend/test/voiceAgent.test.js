import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/testServer.js';
import {
  createClinician,
  createPatientUser,
  createProviderWithSchedule,
  slotAt,
  loginClinician,
  PATIENT
} from './helpers/fixtures.js';
import { generateToolToken } from '../src/services/toolSecurity.service.js';
import { createVoiceCall, findVoiceCallBySidRaw } from '../src/repositories/voiceCall.repository.js';
import { prepareConfirmation, transitionToConfirmed } from '../src/services/confirmation.service.js';

describe('voice agent tools, confirmations, and consent endpoints', () => {
  let ctx;
  let provider;
  let windowStart;

  // Outbound calls bind tools to an agent session ID that differs from Twilio's CallSid
  const TWILIO_SID = 'CA00000000000000000000000000000001';
  const AGENT_SESSION = 'AGENT-OUT-test-1';

  before(async () => {
    ctx = await startTestServer();
    await createClinician();
    await createPatientUser();
    ({ provider, windowStart } = await createProviderWithSchedule({ hours: 4 }));
    await createVoiceCall({
      callSid: TWILIO_SID,
      agentSessionId: AGENT_SESSION,
      from: '+15550000999',
      to: PATIENT.phone,
      direction: 'outbound',
      status: 'in-progress',
      isMock: true
    });
  });

  after(async () => {
    await ctx.stop();
  });

  const callTool = (name, body, { session = AGENT_SESSION, token = generateToolToken(session) } = {}) =>
    createClient(ctx.baseUrl).post(`/api/voice/tools/${name}`, { callSid: session, toolToken: token, ...body });

  describe('consent endpoints', () => {
    it('require a clinician session', async () => {
      const anonymous = createClient(ctx.baseUrl);
      const read = await anonymous.get('/api/voice/callback/consent?phone=%2B919876543210');
      assert.equal(read.status, 401);
      const write = await anonymous.post('/api/voice/callback/consent', { phone: '+919876543210', status: 'consented' });
      assert.equal(write.status, 401);
    });

    it('work for a clinician and record who changed consent', async () => {
      const clinician = createClient(ctx.baseUrl);
      await loginClinician(clinician);
      const write = await clinician.post('/api/voice/callback/consent', { phone: '+919876543210', status: 'consented' });
      assert.equal(write.status, 200);
      assert.match(write.data.data.consentSource, /^clinician:/);

      const read = await clinician.get('/api/voice/callback/consent?phone=%2B919876543210');
      assert.equal(read.status, 200);
      assert.equal(read.data.data.consentStatus, 'consented');
    });
  });

  describe('tool authentication', () => {
    it('rejects calls without a token', async () => {
      const res = await createClient(ctx.baseUrl).post('/api/voice/tools/find_providers', { callSid: AGENT_SESSION });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'TOOL_AUTH_MISSING');
    });

    it('rejects a token minted for a different call', async () => {
      const res = await callTool('find_providers', {}, { token: generateToolToken('some-other-call') });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'TOOL_AUTH_INVALID');
    });

    it('only honours the mock bypass header outside production', async () => {
      const mockRequest = () => createClient(ctx.baseUrl).post('/api/voice/tools/find_providers', {}, { headers: { 'x-mock-tool': 'true' } });

      const dev = await mockRequest();
      assert.equal(dev.status, 200);

      ctx.env.NODE_ENV = 'production';
      try {
        const prod = await mockRequest();
        assert.equal(prod.status, 403);
      } finally {
        ctx.env.NODE_ENV = 'test';
      }
    });
  });

  describe('tool behaviour', () => {
    it('finds providers by partial doctor name and lists real specialties when nothing matches', async () => {
      const byName = await callTool('find_providers', { name: 'Dr. Sharma' });
      assert.equal(byName.data.status, 'success');
      assert.equal(byName.data.providers[0].name, 'Dr. Ananya Sharma');

      const none = await callTool('find_providers', { specialty: 'Endocrinology' });
      assert.equal(none.data.status, 'not_found');
      assert.match(none.data.message, /General Practice/);
      assert.doesNotMatch(none.data.message, /Endocrinology, /);

      const weird = await callTool('find_providers', { name: '(((' });
      assert.equal(weird.status, 200);
    });

    it('records tool events on the call record even though the tool session ID differs from the Twilio SID', async () => {
      await callTool('find_providers', { specialty: 'General Practice' });
      const record = await findVoiceCallBySidRaw(TWILIO_SID);
      assert.ok(record.toolEvents.some(e => e.toolName === 'find_providers'));
    });

    it("uses the call's real phone number instead of a placeholder, and books only after confirmation", async () => {
      const slot = slotAt(windowStart, 0);
      const prepared = await callTool('prepare_booking', {
        providerId: provider._id,
        startAt: slot.startAt,
        endAt: slot.endAt,
        patientName: 'Sunita Devi'
      });
      assert.equal(prepared.data.status, 'needs_confirmation');

      const stored = await ctx.getDb().collection('confirmations').findOne({ confirmationId: prepared.data.confirmationId });
      assert.equal(stored.status, 'prepared', 'confirmation must be persisted, not held in memory');
      assert.equal(stored.payload.patient.phone, PATIENT.phone);

      const appointmentsBefore = await ctx.getDb().collection('appointments').countDocuments();
      assert.equal(appointmentsBefore, 0, 'prepare must not create an appointment');

      const confirmed = await callTool('confirm_booking', { confirmationId: prepared.data.confirmationId, confirmed: true });
      assert.equal(confirmed.data.status, 'success');

      const appt = await ctx.getDb().collection('appointments').findOne({ bookingReference: confirmed.data.bookingReference });
      assert.equal(appt.patient.phone, PATIENT.phone);
      assert.ok(appt.patientUserId, 'voice booking should link to the matching patient account');
    });

    it('creates exactly one appointment when confirm is sent twice at once', async () => {
      const slot = slotAt(windowStart, 1);
      const prepared = await callTool('prepare_booking', {
        providerId: provider._id,
        startAt: slot.startAt,
        endAt: slot.endAt,
        patientName: 'Sunita Devi'
      });

      await Promise.all([
        callTool('confirm_booking', { confirmationId: prepared.data.confirmationId, confirmed: true }),
        callTool('confirm_booking', { confirmationId: prepared.data.confirmationId, confirmed: true })
      ]);

      const count = await ctx.getDb().collection('appointments').countDocuments({ startAt: new Date(slot.startAt) });
      assert.equal(count, 1);
    });

    it('cancels a pending confirmation when Twilio reports the call ended', async () => {
      const slot = slotAt(windowStart, 2);
      const prepared = await callTool('prepare_booking', {
        providerId: provider._id,
        startAt: slot.startAt,
        endAt: slot.endAt,
        patientName: 'Sunita Devi'
      });

      const status = await createClient(ctx.baseUrl).post('/api/voice/status', { CallSid: TWILIO_SID, CallStatus: 'completed', CallDuration: '42' });
      assert.equal(status.status, 200);

      const confirm = await callTool('confirm_booking', { confirmationId: prepared.data.confirmationId, confirmed: true });
      assert.equal(confirm.data.status, 'validation_error');
      assert.equal(confirm.data.code, 'CONFIRMATION_CANCELLED');
    });
  });

  describe('confirmation state machine', () => {
    it('expires unconfirmed actions and refuses cross-call confirmation', async () => {
      const expiring = await prepareConfirmation({ callSid: 'call-a', action: 'BOOKING', payload: {}, summary: {}, ttlMs: 1 });
      await new Promise(resolve => setTimeout(resolve, 10));
      await assert.rejects(() => transitionToConfirmed(expiring.confirmationId, 'call-a', 'BOOKING'), { code: 'CONFIRMATION_EXPIRED' });

      const other = await prepareConfirmation({ callSid: 'call-b', action: 'BOOKING', payload: {}, summary: {} });
      await assert.rejects(() => transitionToConfirmed(other.confirmationId, 'call-c', 'BOOKING'), { code: 'CROSS_CALL_FORBIDDEN' });
    });

    it('supersedes an older pending action on the same call', async () => {
      const first = await prepareConfirmation({ callSid: 'call-d', action: 'BOOKING', payload: {}, summary: {} });
      await prepareConfirmation({ callSid: 'call-d', action: 'CANCELLATION', payload: {}, summary: {} });
      await assert.rejects(() => transitionToConfirmed(first.confirmationId, 'call-d', 'BOOKING'), { code: 'CONFIRMATION_CANCELLED' });
    });
  });
});
