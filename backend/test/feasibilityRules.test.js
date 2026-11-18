import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessTaskFeasibility,
  proposeAlternatives,
  upcomingOpenings,
  distanceKm
} from '../src/services/feasibilityRules.js';
import { weekdayInZone } from '../src/utils/time.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-10-20T04:30:00.000Z'); // Tuesday 10:00 IST
const DAY = 24 * 60 * 60 * 1000;

const sunita = {
  name: 'Sunita Devi',
  location: { x: 14, y: 6 },
  constraints: { hasOwnTransport: false, maxTravelKm: 5, documentsHeld: ['aadhaar'], caregiverName: 'Ravi (son)' }
};
const lakshmi = {
  name: 'Lakshmi Bai',
  location: { x: -7, y: -9 },
  constraints: { hasOwnTransport: false, maxTravelKm: 3, documentsHeld: [], caregiverName: null }
};

const clinic = (code, overrides = {}) => ({
  code,
  name: code,
  category: 'clinic',
  modality: 'in_person',
  specialties: ['General Practice'],
  location: { x: 0, y: 0 },
  hours: { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '17:00' },
  requiredDocuments: [],
  isActive: true,
  isSimulated: true,
  ...overrides
});

const district = clinic('DISTRICT', { specialties: ['General Practice', 'Cardiology'] });
const nearPhc = clinic('PHC-NEAR', { location: { x: 13, y: 5 }, requiredDocuments: ['aadhaar'] });
const farPhc = clinic('PHC-FAR', { location: { x: -6, y: -8 }, requiredDocuments: ['aadhaar'] });
const tele = clinic('TELE', { modality: 'teleconsult', location: null });
const nearCardiology = clinic('CARDIO-NEAR', { location: { x: 14, y: 6 }, specialties: ['Cardiology'] });

const slot = (daysAhead) => ({
  providerName: 'Dr. Test',
  startAt: new Date(NOW.getTime() + daysAhead * DAY).toISOString(),
  endAt: new Date(NOW.getTime() + daysAhead * DAY + 30 * 60 * 1000).toISOString()
});

const bookingTask = (overrides = {}) => ({
  type: 'appointment_booking',
  status: 'suggested',
  serviceRequirement: { category: 'clinic', specialty: 'General Practice', facilityCode: 'DISTRICT' },
  dueAt: new Date(NOW.getTime() + 3 * DAY).toISOString(),
  updatedAt: NOW.toISOString(),
  ...overrides
});

const assess = (args) => assessTaskFeasibility({ now: NOW, timeZone: TZ, ...args });
const codes = (result) => result.barriers.map(b => b.code).sort();

describe('feasibility rules', () => {
  it('flags a facility beyond the patient\'s travel limit', () => {
    const result = assess({ task: bookingTask(), patient: sunita, facility: district, slotsBeforeDue: [slot(1)] });
    assert.deepEqual(codes(result), ['TRANSPORT']);
    assert.match(result.barriers[0].detail, /15\.2 km away; Sunita Devi can travel up to 5 km and has no own transport/);
  });

  it('passes a reachable facility and records each check', () => {
    const result = assess({ task: bookingTask(), patient: sunita, facility: nearPhc, slotsBeforeDue: [slot(1)] });
    assert.deepEqual(result.barriers, []);
    assert.ok(result.checks.every(c => c.result === 'pass'));
  });

  it('flags missing documents, unavailable services, and closed facilities', () => {
    assert.deepEqual(codes(assess({ task: bookingTask(), patient: lakshmi, facility: farPhc, slotsBeforeDue: [slot(1)] })), ['MISSING_DOCUMENT']);
    assert.deepEqual(codes(assess({ task: bookingTask(), patient: sunita, facility: { ...nearCardiology, location: { x: 13, y: 6 } }, slotsBeforeDue: [slot(1)] })), ['SERVICE_UNAVAILABLE']);
    const closed = assess({ task: bookingTask(), patient: sunita, facility: { ...nearPhc, isActive: false }, slotsBeforeDue: [slot(1)] });
    assert.match(closed.barriers[0].detail, /temporarily closed/);
  });

  it('flags a booking task with no slot before the deadline', () => {
    assert.deepEqual(codes(assess({ task: bookingTask(), patient: sunita, facility: nearPhc, slotsBeforeDue: [] })), ['NO_SLOT']);
  });

  it('skips the distance check honestly when a location is unknown', () => {
    const result = assess({ task: bookingTask(), patient: { ...sunita, location: null }, facility: district, slotsBeforeDue: [slot(1)] });
    assert.deepEqual(result.barriers, []);
    assert.equal(result.checks.find(c => c.name === 'travel').result, 'skipped');
  });

  it('checks that the patient holds a document they must submit', () => {
    const docTask = { type: 'document_submission', status: 'suggested', serviceRequirement: { category: 'document', document: 'discharge_summary' }, dueAt: NOW.toISOString() };
    assert.deepEqual(codes(assess({ task: docTask, patient: sunita })), ['MISSING_DOCUMENT']);
    const holder = { ...sunita, constraints: { ...sunita.constraints, documentsHeld: ['discharge_summary'] } };
    assert.deepEqual(codes(assess({ task: docTask, patient: holder })), []);
  });

  it('flags a request left unconfirmed for over 48 hours', () => {
    const stale = bookingTask({ status: 'requested', updatedAt: new Date(NOW.getTime() - 3 * DAY).toISOString() });
    assert.ok(codes(assess({ task: stale, patient: sunita, facility: nearPhc, slotsBeforeDue: [slot(1)] })).includes('UNCONFIRMED'));
  });

  it('flags an unreachable patient only after two unanswered calls in a row', () => {
    const task = bookingTask();
    const twoMissed = [{ status: 'no-answer' }, { status: 'busy' }];
    assert.ok(codes(assess({ task, patient: sunita, facility: nearPhc, slotsBeforeDue: [slot(1)], recentCalls: twoMissed })).includes('NO_RESPONSE'));
    const answeredLast = [{ status: 'completed' }, { status: 'no-answer' }];
    assert.ok(!codes(assess({ task, patient: sunita, facility: nearPhc, slotsBeforeDue: [slot(1)], recentCalls: answeredLast })).includes('NO_RESPONSE'));
  });

  it('does not re-check completed tasks', () => {
    const result = assess({ task: bookingTask({ status: 'completed_with_evidence' }), patient: sunita, facility: district });
    assert.deepEqual(result.barriers, []);
  });

  it('computes opening windows on open days only, respecting advance notice', () => {
    const homeService = { ...clinic('HOME'), category: 'lab', modality: 'home_visit', hours: { days: [2, 4, 6], open: '07:00', close: '10:00' }, bookAheadDays: 1 };
    const openings = upcomingOpenings(homeService, { now: NOW, until: new Date(NOW.getTime() + 10 * DAY), timeZone: TZ });
    assert.equal(openings.length, 3);
    assert.equal(openings[0].startAt, '2026-10-22T01:30:00.000Z'); // Thursday 07:00 IST (not today, Tuesday)
    assert.ok(openings.every(o => [2, 4, 6].includes(weekdayInZone(new Date(o.startAt), TZ))));
    assert.equal(distanceKm({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  });
});

describe('replanner', () => {
  const transport = [{ code: 'TRANSPORT', facilityCode: 'DISTRICT', detail: 'too far' }];
  const candidates = [
    { facility: district, slotsBeforeDue: [slot(1)], slotsAfterDue: [] },
    { facility: nearPhc, slotsBeforeDue: [slot(1), slot(2), slot(2.1), slot(2.2)], slotsAfterDue: [] },
    { facility: farPhc, slotsBeforeDue: [slot(1)], slotsAfterDue: [] },
    { facility: tele, slotsBeforeDue: [slot(1)], slotsAfterDue: [] },
    { facility: nearCardiology, slotsBeforeDue: [slot(1)], slotsAfterDue: [] }
  ];
  const propose = (args) => proposeAlternatives({ now: NOW, timeZone: TZ, plannedFacility: district, ...args });

  it('proposes the same service at a reachable facility first, then a teleconsult that needs clinician approval', () => {
    const result = propose({ task: bookingTask(), patient: sunita, barriers: transport, candidates });
    assert.equal(result.recommendation, 'choose_alternative');
    assert.deepEqual(result.alternatives.map(a => [a.kind, a.facility.code]), [
      ['facility_change', 'PHC-NEAR'],
      ['modality_change', 'TELE']
    ]);

    const [nearby, teleconsult] = result.alternatives;
    assert.equal(nearby.requiresPatientConfirmation, true);
    assert.equal(nearby.requiresClinicianApproval, false);
    assert.equal(nearby.times.length, 3, 'at most three slots per alternative');
    assert.equal(nearby.facility.distanceKm, 1.4);
    assert.equal(teleconsult.requiresClinicianApproval, true);
    assert.match(teleconsult.approvalReason, /Only a clinician can decide/);
  });

  it('never proposes a different specialty, an unreachable facility, or one needing documents the patient lacks', () => {
    const lakshmiResult = propose({ task: bookingTask(), patient: lakshmi, barriers: transport, candidates });
    const proposed = lakshmiResult.alternatives.map(a => a.facility.code);
    assert.ok(!proposed.includes('CARDIO-NEAR'));
    assert.ok(!proposed.includes('PHC-FAR'), 'Lakshmi has no Aadhaar card, which PHC-FAR requires');
    assert.deepEqual(proposed, ['TELE']);
  });

  it('offers a later slot only with clinician approval when nothing fits the deadline', () => {
    const lateOnly = [{ facility: nearPhc, slotsBeforeDue: [], slotsAfterDue: [slot(5)] }];
    const result = propose({ task: bookingTask(), patient: sunita, barriers: transport, candidates: lateOnly });
    assert.equal(result.alternatives[0].kind, 'time_change');
    assert.equal(result.alternatives[0].requiresClinicianApproval, true);
    assert.match(result.alternatives[0].approvalReason, /after the clinician's deadline/);
  });

  it('recommends escalation when no permitted alternative exists', () => {
    const result = propose({ task: bookingTask(), patient: sunita, barriers: transport, candidates: [{ facility: district, slotsBeforeDue: [slot(1)] }] });
    assert.equal(result.alternatives.length, 0);
    assert.equal(result.recommendation, 'escalate');
  });

  it('treats home sample collection as the same lab test, needing only patient confirmation', () => {
    const lab = (code, overrides) => ({ ...clinic(code), category: 'lab', tests: ['lipid_profile'], specialties: [], hours: { days: [1, 2, 3, 4, 5, 6], open: '07:00', close: '13:00' }, ...overrides });
    const labTask = { type: 'lab_test', status: 'suggested', serviceRequirement: { category: 'lab', service: 'lipid_profile', facilityCode: 'LAB-DISTRICT' }, dueAt: new Date(NOW.getTime() + 5 * DAY).toISOString() };
    const home = lab('HOME', { modality: 'home_visit', location: null, requiredDocuments: ['aadhaar'], bookAheadDays: 1 });
    const result = proposeAlternatives({
      task: labTask,
      patient: sunita,
      barriers: [{ code: 'TRANSPORT', facilityCode: 'LAB-DISTRICT', detail: 'too far' }],
      plannedFacility: lab('LAB-DISTRICT'),
      candidates: [{ facility: lab('LAB-DISTRICT') }, { facility: home }],
      now: NOW,
      timeZone: TZ
    });
    assert.equal(result.alternatives[0].facility.code, 'HOME');
    assert.equal(result.alternatives[0].kind, 'facility_change');
    assert.equal(result.alternatives[0].requiresClinicianApproval, false);
    assert.equal(result.alternatives[0].timesAre, 'opening_hours');
  });

  it('suggests requesting a missing document, following up an unconfirmed request, and reaching a caregiver with consent', () => {
    const docTask = { type: 'document_submission', status: 'suggested', serviceRequirement: { category: 'document', document: 'discharge_summary' }, dueAt: NOW.toISOString() };
    const doc = proposeAlternatives({ task: docTask, patient: sunita, barriers: [{ code: 'MISSING_DOCUMENT', detail: 'no copy' }] });
    assert.equal(doc.alternatives[0].kind, 'request_document');
    assert.match(doc.alternatives[0].rationale, /Ravi \(son\)/);

    const followUp = proposeAlternatives({ task: bookingTask(), patient: sunita, barriers: [{ code: 'UNCONFIRMED', detail: 'stale' }] });
    assert.equal(followUp.alternatives[0].kind, 'follow_up_confirmation');

    const caregiver = proposeAlternatives({ task: bookingTask(), patient: sunita, barriers: [{ code: 'NO_RESPONSE', detail: 'unreachable' }] });
    assert.equal(caregiver.alternatives[0].kind, 'contact_caregiver');
    assert.equal(caregiver.alternatives[0].requiresClinicianApproval, true);

    const noCaregiver = proposeAlternatives({ task: bookingTask(), patient: lakshmi, barriers: [{ code: 'NO_RESPONSE', detail: 'unreachable' }] });
    assert.equal(noCaregiver.alternatives[0].kind, 'escalate');
  });
});
