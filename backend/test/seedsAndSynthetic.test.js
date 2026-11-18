import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer, createClient } from './helpers/testServer.js';
import { loginClinician } from './helpers/fixtures.js';
import { seedClinician } from '../src/scripts/seedUsers.js';
import { seedProvidersAndSchedules, DEMO_PROVIDERS } from '../src/scripts/seedAppointments.js';
import { seedPatients } from '../src/scripts/seedPatientUsers.js';
import { seedCarePlans } from '../src/scripts/seedCarePlans.js';

describe('seed data and synthetic-patient guards', () => {
  let ctx;
  let clinician;

  before(async () => {
    ctx = await startTestServer();
    await seedClinician();
    await seedProvidersAndSchedules();
    await seedPatients();
    await seedCarePlans();
    clinician = createClient(ctx.baseUrl);
    await loginClinician(clinician, { email: 'clinician@careloop.local', password: 'CareLoop2026!' });
  });

  after(async () => {
    await ctx.stop();
  });

  it('is safe to run twice without duplicating providers, schedules, or patients', async () => {
    const db = ctx.getDb();
    const counts = async () => ({
      providers: await db.collection('providers').countDocuments(),
      windows: await db.collection('availability').countDocuments(),
      users: await db.collection('users').countDocuments(),
      patients: await db.collection('patients').countDocuments(),
      carePlans: await db.collection('care_plans').countDocuments()
    });
    const before = await counts();
    await seedClinician();
    await seedProvidersAndSchedules();
    await seedPatients();
    await seedCarePlans();
    assert.deepEqual(await counts(), before);
    assert.equal(before.providers, DEMO_PROVIDERS.length);
    assert.equal(before.patients, 3, 'two portal patients plus one phone-only patient');
    assert.equal(before.carePlans, 1);
  });

  it('seeds a demo care plan that the clinician API can read', async () => {
    const list = await clinician.get('/api/care-plans');
    assert.equal(list.status, 200);
    assert.equal(list.data.data[0].patient.name, 'Sunita Devi');
    assert.equal(list.data.data[0].progress.total, 4);
  });

  it('schedules providers from 9:00 to 17:00 clinic-local time', async () => {
    const window = await ctx.getDb().collection('availability').findOne({});
    const localTime = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: window.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    assert.equal(window.timezone, 'Asia/Kolkata');
    assert.equal(localTime(window.startAt), '09:00');
    assert.equal(localTime(window.endAt), '17:00');
  });

  it('stores seeded appointments so conflict detection sees them', async () => {
    const seeded = await ctx.getDb().collection('appointments').findOne({ status: 'confirmed' });
    assert.ok(seeded.providerId instanceof ObjectId, 'providerId must be an ObjectId');
    assert.ok(seeded.patientUserId instanceof ObjectId, 'appointment must link to the patient account');
    assert.equal(seeded.patient.isSynthetic, true);

    const clash = await clinician.post('/api/appointments', {
      providerId: String(seeded.providerId),
      startAt: seeded.startAt.toISOString(),
      endAt: seeded.endAt.toISOString(),
      patient: { name: 'Someone Else', phone: '+15550100199' }
    });
    assert.equal(clash.status, 409);
  });

  it('always simulates reminder calls to synthetic patients, even with mock mode off', async () => {
    const seeded = await ctx.getDb().collection('appointments').findOne({ status: 'confirmed' });
    ctx.env.VOICE_MOCK_MODE = false;
    try {
      const res = await clinician.post('/api/voice/outbound', { appointmentId: String(seeded._id), confirmed: true });
      assert.equal(res.status, 201);
      assert.equal(res.data.data.isMock, true);
    } finally {
      ctx.env.VOICE_MOCK_MODE = true;
    }
  });
});
