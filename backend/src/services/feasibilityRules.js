import { localTimeOnDay, weekdayInZone, parseClockTime } from '../utils/time.js';

/**
 * PlanPilot feasibility rules and replanner (pure logic, no database access).
 *
 * assessTaskFeasibility() checks whether a care-plan task is practically achievable for this
 *   patient (logistics only: distance, documents, service availability, slots, contact) and
 *   returns barriers.
 * proposeAlternatives() suggests ways around those barriers. It only ever proposes the SAME
 *   service the clinician asked for. Anything that changes how care is delivered (an in-person
 *   visit becoming a teleconsultation) or misses the clinician's deadline is marked as needing
 *   clinician approval. Proposals change nothing on their own.
 */

export const BARRIER_CODES = {
  TRANSPORT: { label: 'Cannot reach the facility', scope: 'facility' },
  SERVICE_UNAVAILABLE: { label: 'Service not available', scope: 'facility' },
  MISSING_DOCUMENT: { label: 'Required document missing', scope: 'document' },
  NO_SLOT: { label: 'No slot before the deadline', scope: 'facility' },
  UNCONFIRMED: { label: 'Request not confirmed', scope: 'confirmation' },
  NO_RESPONSE: { label: 'Patient not reachable', scope: 'contact' },
  OTHER: { label: 'Other barrier', scope: 'other' }
};

export const MODALITY_LABELS = {
  in_person: 'in-person visit',
  home_visit: 'home visit',
  teleconsult: 'teleconsultation'
};

export const DOCUMENT_LABELS = {
  aadhaar: 'Aadhaar card',
  discharge_summary: 'discharge summary',
  doctor_referral: 'doctor referral slip'
};

const UNREACHED_CALL_STATUSES = ['no-answer', 'busy', 'failed', 'canceled'];
const UNCONFIRMED_AFTER_MS = 48 * 60 * 60 * 1000;
const MAX_SLOTS_PER_ALTERNATIVE = 3;
const HOUR_MS = 60 * 60 * 1000;

export function documentLabel(code) {
  return DOCUMENT_LABELS[code] || code;
}

export function distanceKm(a, b) {
  if (!a || !b) return null;
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 10) / 10;
}

export function facilityOffers(facility, requirement) {
  if (!facility || !requirement) return false;
  if (requirement.category === 'clinic') {
    return facility.category === 'clinic' && (facility.specialties || []).includes(requirement.specialty);
  }
  if (requirement.category === 'lab') {
    return facility.category === 'lab' && (facility.tests || []).includes(requirement.service);
  }
  return false;
}

function requiresTravel(facility) {
  return (facility.modality || 'in_person') === 'in_person';
}

/**
 * Travel check: null if fine, 'unknown' if it can't be judged, or a barrier.
 */
function checkTravel(patient, facility) {
  if (!requiresTravel(facility)) return null;
  const distance = distanceKm(patient.location, facility.location);
  if (distance === null) return 'unknown';

  const { maxTravelKm, hasOwnTransport } = patient.constraints || {};
  if (distance > maxTravelKm) {
    return {
      code: 'TRANSPORT',
      facilityCode: facility.code,
      detail: `${facility.name} is ${distance} km away; ${patient.name} can travel up to ${maxTravelKm} km${hasOwnTransport ? '' : ' and has no own transport'}.`
    };
  }
  return null;
}

function missingDocumentsFor(patient, facility) {
  const held = new Set(patient.constraints?.documentsHeld || []);
  return (facility.requiredDocuments || []).filter(doc => !held.has(doc));
}

/**
 * Upcoming opening windows of a walk-in or home-visit facility between now and `until`.
 */
export function upcomingOpenings(facility, { now, until, timeZone, limit = MAX_SLOTS_PER_ALTERNATIVE }) {
  if (!facility.hours) return [];
  const open = parseClockTime(facility.hours.open);
  const close = parseClockTime(facility.hours.close);
  const firstDay = facility.bookAheadDays || 0;
  const openings = [];

  for (let dayOffset = firstDay; dayOffset <= 60 && openings.length < limit; dayOffset++) {
    const startAt = localTimeOnDay({ from: now, dayOffset, hour: open.hour, minute: open.minute, timeZone });
    if (startAt >= until) break;
    const endAt = localTimeOnDay({ from: now, dayOffset, hour: close.hour, minute: close.minute, timeZone });
    if (endAt <= now) continue;
    if (!facility.hours.days.includes(weekdayInZone(startAt, timeZone))) continue;
    openings.push({ startAt: startAt.toISOString(), endAt: endAt.toISOString() });
  }
  return openings;
}

/**
 * Checks one task. Inputs are plain objects already loaded by the caller.
 *
 * @param {object} args
 * @param {object} args.task           care task (type, status, serviceRequirement, dueAt, updatedAt)
 * @param {object} args.patient        patient record (name, location, constraints)
 * @param {object|null} args.facility  the facility the plan expects the task to happen at
 * @param {Array} args.slotsBeforeDue  open slots at that facility for the required service, before the due date
 * @param {Array} args.recentCalls     recent outbound calls to the patient, newest first
 * @returns {{ barriers: Array, checks: Array<{ name, result: 'pass'|'fail'|'skipped', note }> }}
 */
export function assessTaskFeasibility({ task, patient, facility = null, slotsBeforeDue = [], recentCalls = [], now = new Date(), timeZone = 'UTC' }) {
  const barriers = [];
  const checks = [];
  const check = (name, result, note) => checks.push({ name, result, note });

  if (task.status === 'completed_with_evidence') {
    check('status', 'skipped', 'Task is already completed with evidence.');
    return { barriers, checks };
  }

  const requirement = task.serviceRequirement || {};
  const dueAt = new Date(task.dueAt);

  if (requirement.category === 'clinic' || requirement.category === 'lab') {
    if (!facility) {
      check('facility', 'skipped', 'No planned facility recorded for this task.');
    } else {
      if (!facility.isActive || !facilityOffers(facility, requirement)) {
        const service = requirement.specialty || requirement.service;
        barriers.push({
          code: 'SERVICE_UNAVAILABLE',
          facilityCode: facility.code,
          detail: facility.isActive
            ? `${facility.name} does not offer ${service}.`
            : `${facility.name} is temporarily closed.`
        });
        check('service', 'fail', `${facility.name} cannot provide this service.`);
      } else {
        check('service', 'pass', `${facility.name} offers this service.`);
      }

      const travel = checkTravel(patient, facility);
      if (travel === 'unknown') {
        check('travel', 'skipped', 'Patient or facility location unknown; distance not checked.');
      } else if (travel) {
        barriers.push(travel);
        check('travel', 'fail', travel.detail);
      } else {
        check('travel', 'pass', requiresTravel(facility)
          ? `${distanceKm(patient.location, facility.location)} km, within ${patient.constraints.maxTravelKm} km limit.`
          : `No travel needed (${MODALITY_LABELS[facility.modality]}).`);
      }

      const missing = missingDocumentsFor(patient, facility);
      if (missing.length > 0) {
        barriers.push({
          code: 'MISSING_DOCUMENT',
          facilityCode: facility.code,
          detail: `${facility.name} requires ${missing.map(documentLabel).join(', ')}, which ${patient.name} does not have.`
        });
        check('documents', 'fail', `Missing: ${missing.map(documentLabel).join(', ')}.`);
      } else {
        check('documents', 'pass', 'Patient has the documents this facility requires.');
      }

      if (requirement.category === 'clinic' && task.type === 'appointment_booking') {
        if (slotsBeforeDue.length === 0) {
          barriers.push({
            code: 'NO_SLOT',
            facilityCode: facility.code,
            detail: `No open ${requirement.specialty} slots at ${facility.name} before the deadline.`
          });
          check('slots', 'fail', 'No slots before the deadline.');
        } else {
          check('slots', 'pass', `${slotsBeforeDue.length} slot(s) available before the deadline.`);
        }
      }

      if (requirement.category === 'lab') {
        const openings = upcomingOpenings(facility, { now, until: dueAt, timeZone, limit: 1 });
        if (openings.length === 0) {
          barriers.push({
            code: 'NO_SLOT',
            facilityCode: facility.code,
            detail: `${facility.name} has no opening hours before the deadline.`
          });
          check('opening_hours', 'fail', 'Closed until after the deadline.');
        } else {
          check('opening_hours', 'pass', 'Open before the deadline.');
        }
      }
    }
  }

  if (requirement.category === 'document') {
    const held = patient.constraints?.documentsHeld || [];
    if (!held.includes(requirement.document)) {
      barriers.push({
        code: 'MISSING_DOCUMENT',
        detail: `${patient.name} does not have a copy of the ${documentLabel(requirement.document)}.`
      });
      check('documents', 'fail', `Patient does not hold the ${documentLabel(requirement.document)}.`);
    } else {
      check('documents', 'pass', `Patient holds the ${documentLabel(requirement.document)}.`);
    }
  }

  if (task.status === 'requested') {
    const waitingMs = now.getTime() - new Date(task.updatedAt).getTime();
    if (waitingMs > UNCONFIRMED_AFTER_MS) {
      barriers.push({
        code: 'UNCONFIRMED',
        detail: `Requested ${Math.floor(waitingMs / HOUR_MS)} hours ago and still not confirmed.`
      });
      check('confirmation', 'fail', 'Request has not been confirmed in time.');
    } else {
      check('confirmation', 'pass', 'Request is recent.');
    }
  }

  const lastTwo = recentCalls.slice(0, 2);
  if (lastTwo.length === 2 && lastTwo.every(call => UNREACHED_CALL_STATUSES.includes(call.status))) {
    barriers.push({
      code: 'NO_RESPONSE',
      detail: `The last 2 calls to ${patient.name} were not answered (${lastTwo.map(c => c.status).join(', ')}).`
    });
    check('contact', 'fail', 'Patient has not been reachable by phone.');
  } else {
    check('contact', 'pass', recentCalls.length ? 'Patient reachable on recent calls.' : 'No recent call attempts.');
  }

  return { barriers, checks };
}

function facilitySummary(facility, patient) {
  return {
    code: facility.code,
    name: facility.name,
    category: facility.category,
    modality: facility.modality || 'in_person',
    distanceKm: requiresTravel(facility) ? distanceKm(patient.location, facility.location) : 0,
    locationLabel: facility.location?.label || null,
    isSimulated: Boolean(facility.isSimulated)
  };
}

/**
 * Proposes ways around the barriers. Every alternative offers the same service the clinician
 * specified and says exactly what approval it needs before anyone acts on it.
 *
 * @param {object} args
 * @param {Array<{ facility, slotsBeforeDue, slotsAfterDue }>} args.candidates  facilities offering the
 *   required service (including the planned one), with their slots split around the due date
 * @returns {{ alternatives: Array, recommendation: 'choose_alternative'|'escalate', note: string }}
 */
export function proposeAlternatives({ task, patient, barriers, plannedFacility = null, candidates = [], now = new Date(), timeZone = 'UTC' }) {
  const requirement = task.serviceRequirement || {};
  const codes = new Set(barriers.map(b => b.code));
  const facilityBlocked = barriers.some(b => b.facilityCode && BARRIER_CODES[b.code]?.scope !== 'confirmation');
  const plannedModality = plannedFacility?.modality || 'in_person';
  const dueAt = new Date(task.dueAt);
  const alternatives = [];

  if (facilityBlocked && (requirement.category === 'clinic' || requirement.category === 'lab')) {
    const usable = candidates.filter(({ facility }) =>
      facility.isActive &&
      facilityOffers(facility, requirement) &&
      checkTravel(patient, facility) === null &&
      missingDocumentsFor(patient, facility).length === 0
    );

    for (const { facility, slotsBeforeDue = [] } of usable) {
      if (plannedFacility && facility.code === plannedFacility.code) continue;

      const modalityChanged = requirement.category === 'clinic' && (facility.modality || 'in_person') !== plannedModality;
      const times = requirement.category === 'clinic'
        ? slotsBeforeDue.slice(0, MAX_SLOTS_PER_ALTERNATIVE)
        : upcomingOpenings(facility, { now, until: dueAt, timeZone });
      if (times.length === 0) continue;

      const summary = facilitySummary(facility, patient);
      alternatives.push({
        kind: modalityChanged ? 'modality_change' : 'facility_change',
        facility: summary,
        times,
        timesAre: requirement.category === 'clinic' ? 'bookable_slots' : 'opening_hours',
        requiresPatientConfirmation: true,
        requiresClinicianApproval: modalityChanged,
        approvalReason: modalityChanged
          ? `Changes the ${MODALITY_LABELS[plannedModality]} the clinician planned into a ${MODALITY_LABELS[summary.modality]}. Only a clinician can decide that is appropriate.`
          : null,
        resolves: barriers.filter(b => b.facilityCode).map(b => b.code),
        rationale: summary.modality === 'in_person'
          ? `Same service at ${summary.name}, ${summary.distanceKm} km from ${patient.name}, before the deadline.`
          : `Same service as a ${MODALITY_LABELS[summary.modality]}, no travel needed, before the deadline.`
      });
    }

    // Nothing before the deadline: offer the earliest later slot at a reachable facility, flagged for the clinician
    if (alternatives.length === 0 && requirement.category === 'clinic') {
      const later = usable
        .filter(({ facility }) => (facility.modality || 'in_person') === plannedModality)
        .map(({ facility, slotsAfterDue = [] }) => ({ facility, slot: slotsAfterDue[0] }))
        .filter(entry => entry.slot)
        .sort((a, b) => new Date(a.slot.startAt) - new Date(b.slot.startAt))[0];

      if (later) {
        alternatives.push({
          kind: 'time_change',
          facility: facilitySummary(later.facility, patient),
          times: [later.slot],
          timesAre: 'bookable_slots',
          requiresPatientConfirmation: true,
          requiresClinicianApproval: true,
          approvalReason: `The earliest reachable slot is after the clinician's deadline (${dueAt.toISOString().slice(0, 10)}). Only a clinician can accept a later date.`,
          resolves: barriers.filter(b => b.facilityCode).map(b => b.code),
          rationale: 'No reachable slot before the deadline.'
        });
      }
    }

    alternatives.sort((a, b) => {
      const rank = { facility_change: 0, modality_change: 1, time_change: 2 };
      return rank[a.kind] - rank[b.kind] || a.facility.distanceKm - b.facility.distanceKm;
    });
  }

  const documentBarrier = barriers.find(b => b.code === 'MISSING_DOCUMENT' && !b.facilityCode);
  if (documentBarrier) {
    alternatives.push({
      kind: 'request_document',
      document: requirement.document,
      requiresPatientConfirmation: false,
      requiresClinicianApproval: false,
      resolves: ['MISSING_DOCUMENT'],
      rationale: `Clinic staff ask the discharging hospital's records office for a copy of the ${documentLabel(requirement.document)}, or ask ${patient.name}${patient.constraints?.caregiverName ? ` / ${patient.constraints.caregiverName}` : ''} to collect one.`
    });
  }

  if (codes.has('UNCONFIRMED')) {
    alternatives.push({
      kind: 'follow_up_confirmation',
      requiresPatientConfirmation: false,
      requiresClinicianApproval: false,
      resolves: ['UNCONFIRMED'],
      rationale: 'Contact the facility to confirm the request. If it is still unconfirmed after 24 hours, choose another option.'
    });
  }

  if (codes.has('NO_RESPONSE')) {
    const caregiver = patient.constraints?.caregiverName;
    alternatives.push(caregiver
      ? {
        kind: 'contact_caregiver',
        caregiverName: caregiver,
        requiresPatientConfirmation: false,
        requiresClinicianApproval: true,
        approvalReason: 'Sharing care details with a caregiver needs the patient\'s consent on file.',
        resolves: ['NO_RESPONSE'],
        rationale: `Try reaching ${patient.name} through ${caregiver}.`
      }
      : {
        kind: 'escalate',
        requiresPatientConfirmation: false,
        requiresClinicianApproval: true,
        approvalReason: 'No other way to reach the patient.',
        resolves: ['NO_RESPONSE'],
        rationale: `${patient.name} cannot be reached and has no caregiver on file.`
      });
  }

  alternatives.forEach((alt, index) => { alt.id = `alt-${index + 1}`; });

  const addressed = new Set(alternatives.flatMap(a => a.resolves));
  const unaddressed = [...codes].filter(code => !addressed.has(code));

  if (alternatives.length === 0 || unaddressed.length > 0) {
    return {
      alternatives,
      recommendation: 'escalate',
      note: alternatives.length === 0
        ? 'No permitted alternative was found within the patient\'s constraints. Escalate to a clinician.'
        : `No alternative addresses: ${unaddressed.map(code => BARRIER_CODES[code]?.label || code).join(', ')}. Escalate those to a clinician.`
    };
  }

  return {
    alternatives,
    recommendation: 'choose_alternative',
    note: 'Alternatives are proposals only. Each needs the confirmation or approval shown before anything is booked or changed.'
  };
}
