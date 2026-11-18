import { assessEmergencyRisk } from '../config/emergency.js';
import {
  SYMPTOM_CATEGORIES,
  RED_FLAGS,
  LONG_TERM_CONDITION_KEYWORDS,
  GENERAL_SAFETY_NET,
  PROTOCOL_VERSION
} from '../config/triageProtocol.js';

/**
 * Symptom-check decision (pure logic, no database access).
 *
 * The voice agent gathers the facts; this function decides, so the outcome never depends on what
 * the language model "thinks". Care levels, from least to most serious:
 *   none          no health problem reported
 *   self_care     manage at home with the protocol's advice, and see a doctor if it does not settle
 *   doctor_visit  book a regular appointment (within about a week)
 *   urgent        book the earliest appointment (within about 2 days) and alert the clinic team
 *   emergency     only for a life-threatening danger sign happening right now: dial 112, and a
 *                 CareLoop doctor is alerted to call back
 * Everything short of a current emergency is routed to CareLoop's own doctors.
 */

export const CARE_LEVELS = {
  none: { label: 'No health problem', rank: 0 },
  self_care: { label: 'Self-care at home', rank: 1 },
  doctor_visit: { label: 'See a doctor', rank: 2 },
  urgent: { label: 'Urgent doctor visit', rank: 3 },
  emergency: { label: 'Emergency: dial 112', rank: 4 },
  // Not a protocol decision: the call ended before the check finished, so the clinic calls back
  call_back: { label: 'Call back: check not finished', rank: 2 }
};

function matchKeywords(text, keywords) {
  const lower = ` ${String(text || '').toLowerCase()} `;
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

export function detectCategories(text) {
  return Object.entries(SYMPTOM_CATEGORIES).filter(([, def]) => matchKeywords(text, def.keywords)).map(([key]) => key);
}

export function detectRedFlags(text) {
  return Object.entries(RED_FLAGS).filter(([, def]) => matchKeywords(text, def.keywords)).map(([key]) => key);
}

function specialtyFor(categories) {
  if (categories.includes('chest')) return 'Cardiology';
  if (categories.includes('joint_pain')) return 'Orthopedics';
  return 'General Practice';
}

/**
 * @param {object} input
 * @param {string}   input.symptoms        what the caller said, in their words
 * @param {string}   [input.mainSymptom]   a SYMPTOM_CATEGORIES key, 'other', or 'none'
 * @param {number}   [input.durationDays]  how long it has been going on
 * @param {string}   [input.severity]      'mild' | 'moderate' | 'severe'
 * @param {boolean}  [input.happeningNow]  whether the serious symptom is happening right now
 * @param {string[]} [input.redFlags]      RED_FLAGS keys the caller confirmed
 * @param {number}   [input.age]
 * @param {boolean}  [input.pregnant]
 * @param {string}   [input.conditions]    long-term illnesses the caller mentioned
 * @param {string}   [input.allergies]     medicine allergies the caller mentioned
 */
export function assessSymptoms(input = {}) {
  const text = [input.symptoms, input.conditions].filter(Boolean).join('. ');
  // The caller's own words win over the assistant's label for a minor symptom: speech recognition
  // can garble a word (पेट heard as "बेट") and the assistant may then guess the wrong symptom.
  // A serious label (chest, breathing) is always kept.
  const heard = detectCategories(input.symptoms);
  const label = SYMPTOM_CATEGORIES[input.mainSymptom] ? input.mainSymptom : null;
  const labelContradicted = label && heard.length > 0 && !heard.includes(label) && SYMPTOM_CATEGORIES[label].selfCareMaxDays;
  const reported = label && !labelContradicted ? [label] : [];
  const categories = [...new Set([...reported, ...heard])];
  const flags = [...new Set([
    ...(Array.isArray(input.redFlags) ? input.redFlags.filter(f => RED_FLAGS[f]) : []),
    ...detectRedFlags(input.symptoms)
  ])];
  const durationDays = Number.isFinite(Number(input.durationDays)) && input.durationDays !== '' && input.durationDays !== null
    ? Math.max(0, Number(input.durationDays))
    : null;
  const severity = ['mild', 'moderate', 'severe'].includes(input.severity) ? input.severity : null;
  const happeningNow = input.happeningNow === true || input.happeningNow === 'true';
  const age = Number.isFinite(Number(input.age)) && input.age !== null && input.age !== '' ? Number(input.age) : null;
  const longTermCondition = matchKeywords(input.conditions, LONG_TERM_CONDITION_KEYWORDS);
  const pregnant = input.pregnant === true || input.pregnant === 'true';
  const riskGroup = longTermCondition || pregnant || (age !== null && (age < 12 || age >= 65));

  const base = { protocolVersion: PROTOCOL_VERSION, categories, redFlags: flags, durationDays, severity, happeningNow, riskGroup };
  const flagLabels = flags.map(f => RED_FLAGS[f].label.toLowerCase());

  if (input.mainSymptom === 'none' && categories.length === 0 && flags.length === 0) {
    return { ...base, careLevel: 'none', reason: 'The person reported no health problem.', specialty: null, advice: null };
  }

  // 1. Emergency: never wait for anything else. The general emergency word screen applies unless the
  //    caller clearly said the serious symptom is not happening now (then it is urgent, not 112)
  const saidNotNow = input.happeningNow === false || input.happeningNow === 'false';
  const emergencyScreen = saidNotNow ? { isEmergency: false } : assessEmergencyRisk(input.symptoms || '');
  const acuteNow = happeningNow ? flags.filter(f => RED_FLAGS[f].acuteIfNow) : [];
  if (emergencyScreen.isEmergency || acuteNow.length) {
    const why = acuteNow.map(f => RED_FLAGS[f].label.toLowerCase());
    return {
      ...base,
      careLevel: 'emergency',
      reason: why.length ? `Happening now: ${why.join(', ')}.` : 'The description matches a life-threatening emergency.',
      specialty: specialtyFor(categories),
      advice: { emergency: 'Call 112 now. A CareLoop doctor will call you back.' }
    };
  }

  // 2. Urgent: danger signs that are not happening right now, chest or breathing symptoms, severe pain,
  //    or a person at higher risk who is more than mildly unwell
  const chestOrBreathing = categories.includes('chest') || categories.includes('breathing');
  if (flags.length || chestOrBreathing || severity === 'severe' || (riskGroup && severity && severity !== 'mild')) {
    const reasons = [];
    if (flags.length) reasons.push(`danger signs (${flagLabels.join(', ')})`);
    if (chestOrBreathing) reasons.push('chest or breathing symptoms');
    if (severity === 'severe') reasons.push('severe symptoms');
    if (riskGroup && !reasons.length) reasons.push('a higher-risk person who is unwell');
    return {
      ...base,
      careLevel: 'urgent',
      reason: `Needs a doctor soon: ${reasons.join('; ')}.`,
      specialty: specialtyFor(categories),
      advice: {
        safetyNet: chestOrBreathing
          ? 'If severe chest pain or breathlessness starts, call 112.'
          : flags.some(f => RED_FLAGS[f].acuteIfNow) ? 'If it happens again, call 112.' : 'If it gets worse, call CareLoop.'
      }
    };
  }

  // 3. A doctor visit: unknown symptoms, higher-risk people, or longer than is safe to manage at home
  const known = categories.filter(c => SYMPTOM_CATEGORIES[c].selfCareMaxDays);
  if (known.length === 0) {
    return { ...base, careLevel: 'doctor_visit', reason: 'This symptom is not one PlanPilot gives home advice for; a doctor should check it.', specialty: specialtyFor(categories), advice: null };
  }
  const limit = Math.min(...known.map(c => SYMPTOM_CATEGORIES[c].selfCareMaxDays));
  if (durationDays === null) {
    return { ...base, careLevel: 'need_more_info', reason: 'Ask how many days this has been going on, then check again.', specialty: null, advice: null };
  }
  if (riskGroup) {
    return { ...base, careLevel: 'doctor_visit', reason: 'Because of age, pregnancy, or a long-term illness, a doctor should advise on medicines.', specialty: specialtyFor(categories), advice: { selfCare: known.flatMap(c => SYMPTOM_CATEGORIES[c].selfCare).slice(0, 3) } };
  }
  if (durationDays > limit) {
    return {
      ...base,
      careLevel: 'doctor_visit',
      reason: `It has lasted ${durationDays} day(s); for ${known.map(c => SYMPTOM_CATEGORIES[c].label.toLowerCase()).join(' and ')} a doctor should check after ${limit} day(s).`,
      specialty: specialtyFor(categories),
      advice: null
    };
  }

  // 4. Self-care, with medicines only for adults and never against a stated allergy
  const allergies = String(input.allergies || '').toLowerCase();
  const adult = age === null || age >= 18;
  const candidates = adult
    ? known.flatMap(c => SYMPTOM_CATEGORIES[c].medicines || []).filter((m, i, all) => all.findIndex(o => o.name === m.name) === i)
    : [];
  const medicines = candidates.filter(m => !allergies || !allergies.includes(m.name.split(' ')[0].toLowerCase()));
  const medicinesNote = !adult
    ? 'For anyone under 18, ask a pharmacist or doctor for the right medicine and dose.'
    : medicines.length < candidates.length
      ? 'Because of the allergy mentioned, ask a pharmacist for a safe alternative.'
      : null;
  // What the assistant says on the call, based on the main symptom: one tip, at most two medicines,
  // and one "see a doctor if" line. The dashboard keeps the full advice.
  const primary = SYMPTOM_CATEGORIES[known.includes(input.mainSymptom) ? input.mainSymptom : known[0]];
  const [firstMedicine, secondMedicine] = medicines.map(m => m.name.replace(/^An? /, article => article.toLowerCase()));
  const spokenMedicines = firstMedicine ? `${firstMedicine}${secondMedicine ? `, and ${secondMedicine.toLowerCase()} if needed` : ''}` : '';
  const spoken = [
    `${primary.quickTip}.`,
    spokenMedicines ? `You can take ${spokenMedicines}; follow the dose on the pack.` : (medicinesNote || ''),
    `If ${primary.shortSeeDoctor}, call us and we will book a CareLoop doctor.`
  ].filter(Boolean).join(' ');

  return {
    ...base,
    careLevel: 'self_care',
    reason: `Mild ${known.map(c => SYMPTOM_CATEGORIES[c].label.toLowerCase()).join(' and ')} for ${durationDays} day(s), with no danger signs.`,
    specialty: specialtyFor(categories),
    followUpInDays: Math.max(1, limit - durationDays),
    advice: {
      selfCare: [...new Set(known.flatMap(c => SYMPTOM_CATEGORIES[c].selfCare))],
      medicines,
      medicinesNote,
      seeDoctorIf: known.map(c => SYMPTOM_CATEGORIES[c].seeDoctorIf).join('; or '),
      safetyNet: GENERAL_SAFETY_NET,
      spoken
    }
  };
}
