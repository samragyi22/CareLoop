import { normalizeE164Phone } from '../repositories/callbackConsent.repository.js';
import { runSymptomCheck, bookTriageAppointment } from './symptomCheck.service.js';
import { RED_FLAGS } from '../config/triageProtocol.js';
import { callForSession } from './callContextCache.js';

/**
 * Phone-agent tools for health check-ins: check_symptoms (runs the protocol and says what to tell
 * the caller) and book_triage_appointment (books the slot the caller agreed to). The agent may only
 * repeat the advice these tools return.
 */

async function callerOf(callSid) {
  const call = await callForSession(callSid);
  if (!call) return { phone: null, callerName: '', channel: 'phone' };
  const phone = normalizeE164Phone(call.direction === 'outbound' ? call.to : call.from) || null;
  return { phone, callerName: call.planpilot?.callerName || '', channel: call.direction === 'outbound' ? 'outbound_call' : 'inbound_call' };
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[,;]/).map(v => v.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
  return [];
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'yes') return true;
  if (value === 'false' || value === 'no') return false;
  return undefined;
}

/**
 * check_symptoms
 */
export async function handleCheckSymptoms({
  callSid, callerName, symptoms, mainSymptom, durationDays, severity, happeningNow, redFlags, age, pregnant, conditions, allergies
} = {}) {
  const caller = await callerOf(callSid);
  const { check, decision, slots } = await runSymptomCheck({
    phone: caller.phone,
    callerName: callerName || caller.callerName,
    channel: caller.channel,
    callSid,
    input: {
      symptoms: symptoms || '',
      mainSymptom,
      durationDays,
      severity,
      happeningNow: toBoolean(happeningNow),
      redFlags: toList(redFlags).filter(f => RED_FLAGS[f]),
      age: age === undefined || age === null || age === '' ? null : Number(age),
      pregnant: toBoolean(pregnant),
      conditions,
      allergies
    }
  });

  // Replies carry only what to say next, already short, so the assistant does not improvise or ramble
  const base = { status: 'success', action: 'symptom_check', careLevel: decision.careLevel, checkId: check?._id || null };
  // Slots are numbered so the assistant books by number instead of repeating IDs and timestamps
  const slotList = slots.map((s, i) => ({ slotNumber: i + 1, doctor: s.providerName, when: s.spoken }));
  const bookCall = (n) => `call book_triage_appointment with checkId ${check._id}, slotNumber ${n}, confirmed true`;
  const speakRule = 'Say it in the caller\'s language, naturally, but no longer than this. Do not add tips, medicines, or explanations.';

  switch (decision.careLevel) {
    case 'none':
      return { ...base, say: 'Say one short line wishing them good health, and end the call.' };
    case 'need_more_info':
      return { ...base, status: 'need_more_info', say: 'Ask only: since how many days? Then call check_symptoms again with durationDays.' };
    case 'emergency':
      return {
        ...base,
        say: `Say only this, calmly: "This needs emergency help right now. Please call 112 immediately. Our CareLoop doctor will call you back too." ${speakRule} Then end the call.`
      };
    case 'self_care': {
      const first = slots[0];
      return {
        ...base,
        slots: slotList,
        say: `It is a mild problem. Say: "${decision.advice.spoken}" Then ask: "Shall I book a CareLoop doctor for you, or will you try this first?" ${speakRule}`
          + (first
            ? ` If they want a doctor, say "${first.providerName} is free ${first.spoken}. Shall I book it?" and on yes ${bookCall(1)}.${slots[1] ? ` If that time does not suit them, offer ${slots[1].providerName}, ${slots[1].spoken} (slotNumber 2).` : ''}`
            : ' If they want a doctor, say the CareLoop team will call them to fix a time.')
          + ' If they will try the medicine, end warmly in one line.'
      };
    }
    default: {
      const [first, second] = slots;
      const when = decision.careLevel === 'urgent' ? 'soon' : 'in the next few days';
      const doctorType = decision.specialty === 'Cardiology' ? 'a CareLoop heart specialist' : decision.specialty === 'Orthopedics' ? 'a CareLoop bone and joint doctor' : 'a CareLoop doctor';
      return {
        ...base,
        slots: slotList,
        say: first
          ? `Say: "This needs ${doctorType} ${when}. ${first.providerName} is free ${first.spoken}. Shall I book it?" ${speakRule} If they say yes, ${bookCall(1)}.${second ? ` If that time does not suit them, offer ${second.providerName}, ${second.spoken} (slotNumber 2).` : ''}${decision.careLevel === 'urgent' && decision.advice?.safetyNet ? ` After booking, add one line: "${decision.advice.safetyNet}"` : ''}`
          : `Say: "This needs ${doctorType} ${when}. Our CareLoop team will call you to fix a time." ${speakRule}`
      };
    }
  }
}

/**
 * book_triage_appointment
 */
export async function handleBookTriageAppointment({ callSid, checkId, slotNumber, providerId, slotStartAt, confirmed } = {}) {
  if (toBoolean(confirmed) !== true) {
    return { status: 'needs_confirmation', message: 'Read the doctor, day and time back and wait for an explicit yes, then call again with confirmed true.' };
  }
  const caller = await callerOf(callSid);
  try {
    const { appointment, alreadyBooked } = await bookTriageAppointment({ checkId, phone: caller.phone, slotNumber, providerId, slotStartAt });
    return {
      status: 'success',
      action: 'triage_appointment_booked',
      bookingReference: appointment.bookingReference,
      message: `Say: "Done. ${appointment.providerName}, ${appointment.spoken || appointment.startAt}. Your reference is ${appointment.bookingReference.split('').join(' ')}. Please come 10 minutes early." Then end the call warmly in one line.${alreadyBooked ? ' (It was already booked.)' : ''}`
    };
  } catch (err) {
    if (err.code === 'SLOT_TAKEN' || err.code === 'SLOT_CONFLICT') {
      const next = (err.nextSlots || [])[0];
      return {
        status: 'slot_taken',
        message: next
          ? `That time was just taken. Say: "That slot just filled. ${next.providerName} is free ${next.spoken}. Shall I book that?" On yes, call book_triage_appointment with checkId ${checkId}, slotNumber 1, confirmed true.`
          : 'Say: "That slot just filled. Our CareLoop team will call you to fix a time."'
      };
    }
    if (err.code === 'SLOT_NOT_OFFERED') {
      const options = (err.offered || []).map((s, i) => `slotNumber ${i + 1} = ${s.providerName}, ${s.spoken}`).join('; ');
      return {
        status: 'needs_slot',
        message: options
          ? `Book by slotNumber. Offered: ${options}. Use the one the caller agreed to (call again with checkId ${checkId}, slotNumber, confirmed true).`
          : 'No slots were offered on this call. Say: "Our CareLoop team will call you to fix a time."'
      };
    }
    if (err.code === 'CHECK_NOT_FOUND' || err.code === 'NO_APPOINTMENT_NEEDED') {
      return { status: 'failed', message: err.message };
    }
    throw err;
  }
}
