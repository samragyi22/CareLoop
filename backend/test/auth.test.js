import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient } from './helpers/testServer.js';
import { createClinician, createPatientUser, loginClinician, loginPatient, CLINICIAN, PATIENT } from './helpers/fixtures.js';
import { assertProductionSafety } from '../src/config/env.js';

describe('authentication and role boundaries', () => {
  let ctx;

  before(async () => {
    ctx = await startTestServer();
    await createClinician();
    await createPatientUser();
  });

  after(async () => {
    await ctx.stop();
  });

  it('rejects clinician routes without a session', async () => {
    const client = createClient(ctx.baseUrl);
    const res = await client.get('/api/appointments');
    assert.equal(res.status, 401);
  });

  it('logs a clinician in with a session cookie and returns the profile', async () => {
    const client = createClient(ctx.baseUrl);
    await loginClinician(client);
    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, CLINICIAN.email);
    assert.equal(me.data.user.passwordHash, undefined);
  });

  it('rejects a wrong password with a generic message', async () => {
    const client = createClient(ctx.baseUrl);
    const res = await client.post('/api/auth/login', { email: CLINICIAN.email, password: 'wrong-password' });
    assert.equal(res.status, 401);
    assert.equal(res.data.message, 'Invalid email or password');
  });

  it('does not let a patient account into the clinician workspace', async () => {
    const client = createClient(ctx.baseUrl);
    const res = await client.post('/api/auth/login', { email: PATIENT.email, password: PATIENT.password });
    assert.equal(res.status, 403);

    await loginPatient(client);
    const appointments = await client.get('/api/appointments');
    assert.equal(appointments.status, 401);
  });

  it('revokes a patient token on logout', async () => {
    const client = createClient(ctx.baseUrl);
    const login = await loginPatient(client);
    const token = login.data.token;

    const before = await client.get('/api/auth/patient/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(before.status, 200);

    await client.post('/api/auth/patient/logout', undefined, { headers: { Authorization: `Bearer ${token}` } });

    const after = await createClient(ctx.baseUrl).get('/api/auth/patient/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(after.status, 401);
    assert.equal(after.data.code, 'SESSION_REVOKED');
  });
});

describe('production safety checks', () => {
  it('refuses to start production with a missing or placeholder JWT secret', () => {
    assert.throws(() => assertProductionSafety({ NODE_ENV: 'production', JWT_SECRET: '' }), /JWT_SECRET/);
    assert.throws(
      () => assertProductionSafety({ NODE_ENV: 'production', JWT_SECRET: 'careloop-development-jwt-secret-do-not-use-in-production-random-key' }),
      /JWT_SECRET/
    );
    assert.throws(() => assertProductionSafety({ NODE_ENV: 'production', JWT_SECRET: 'short' }), /JWT_SECRET/);
  });

  it('refuses to start production in voice mock mode', () => {
    assert.throws(
      () => assertProductionSafety({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(48), VOICE_MOCK_MODE: true }),
      /VOICE_MOCK_MODE/
    );
  });

  it('accepts a safe production configuration and ignores development', () => {
    assert.doesNotThrow(() => assertProductionSafety({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48), VOICE_MOCK_MODE: false }));
    assert.doesNotThrow(() => assertProductionSafety({ NODE_ENV: 'development', JWT_SECRET: '' }));
  });
});
