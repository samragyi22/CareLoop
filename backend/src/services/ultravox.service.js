import { env } from '../config/env.js';
import { getEmergencyGuidance } from '../config/emergency.js';
import { getClinicDetails } from '../config/clinic.js';
import { listActiveSpecialties } from '../repositories/provider.repository.js';
import { generateToolToken } from './toolSecurity.service.js';

/**
 * Facts the agent may state about the clinic, read from live data so the prompt never
 * advertises specialties or hours the clinic does not actually offer.
 */
export async function getClinicFacts() {
  const specialties = await listActiveSpecialties().catch(() => []);
  const clinic = getClinicDetails();
  return {
    specialties: specialties.length > 0 ? specialties.join(', ') : 'please check with clinic staff',
    hours: clinic.contact?.hours || 'please check with clinic staff'
  };
}

const DEFAULT_CLINIC_FACTS = {
  specialties: 'please check with clinic staff',
  hours: 'please check with clinic staff'
};

const TOOL_TIMEOUT = '20s';

// The tools each kind of call needs. Fewer tools keep the assistant on task (a care-plan call
// should not wander into general booking) and its replies quick.
export const CALL_TOOL_SETS = {
  health_check: ['check_symptoms', 'book_triage_appointment'],
  planpilot_care: ['get_my_care_plan', 'respond_to_care_option', 'report_care_problem', 'check_symptoms', 'book_triage_appointment']
};

/**
 * Builds the official Ultravox tool definitions for CareLoop appointment coordination.
 * Each tool is registered as a temporaryTool with dynamic parameters and session-bound static parameters.
 */
export function buildUltravoxToolDefinitions({ callSid, toolToken, baseUrl, only = null }) {
  const cleanBase = baseUrl.replace(/\/+$/, '');

  const createTool = (name, description, dynamicParameters) => ({
    temporaryTool: {
      modelToolName: name,
      description,
      dynamicParameters,
      staticParameters: [
        {
          name: 'callSid',
          location: 'PARAMETER_LOCATION_BODY',
          value: callSid
        },
        {
          name: 'toolToken',
          location: 'PARAMETER_LOCATION_BODY',
          value: toolToken
        }
      ],
      http: {
        baseUrlPattern: `${cleanBase}/api/voice/tools/${name}`,
        httpMethod: 'POST'
      },
      // Ultravox's default limit (about 2.5 seconds) is shorter than a booking takes on a distant
      // database; past it the assistant hears "timed out" and improvises
      timeout: TOOL_TIMEOUT
    }
  });

  const tools = [
    createTool(
      'find_providers',
      'Discover active clinic healthcare providers, doctors, and specialists by medical specialty or name.',
      [
        {
          name: 'specialty',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Medical specialty to filter by (e.g., General Practice, Cardiology).'
          },
          required: false
        },
        {
          name: 'name',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Doctor or provider name to search for.'
          },
          required: false
        }
      ]
    ),
    createTool(
      'get_available_slots',
      'Retrieve genuine real-time available appointment slots for a clinic provider.',
      [
        {
          name: 'providerId',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The 24-character hexadecimal MongoDB ObjectId of the provider.'
          },
          required: false
        },
        {
          name: 'specialty',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Specialty name if searching across providers in a department.'
          },
          required: false
        },
        {
          name: 'startDate',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Starting date in ISO format (YYYY-MM-DD) for the slot search.'
          },
          required: false
        }
      ]
    ),
    createTool(
      'get_appointment_status',
      'Check the status and details of an existing appointment, requiring caller verification.',
      [
        {
          name: 'identifier',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The booking reference (e.g., CL-123456) or appointment ID.'
          },
          required: true
        },
        {
          name: 'verificationPhone',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Caller telephone number to verify patient identity on the booking.'
          },
          required: false
        },
        {
          name: 'verificationName',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Patient full or partial name to verify identity.'
          },
          required: false
        }
      ]
    ),
    createTool(
      'prepare_booking',
      'Validate a proposed appointment slot and prepare it for caller confirmation without creating an appointment.',
      [
        {
          name: 'providerId',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The 24-character hexadecimal ObjectId of the selected provider.'
          },
          required: true
        },
        {
          name: 'startAt',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The ISO-8601 start date and time of the chosen slot.'
          },
          required: true
        },
        {
          name: 'endAt',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The ISO-8601 end date and time of the chosen slot.'
          },
          required: true
        },
        {
          name: 'patientName',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Full legal name of the patient receiving care.'
          },
          required: true
        },
        {
          name: 'patientPhone',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Contact telephone number for appointment notifications.'
          },
          required: false
        }
      ]
    ),
    createTool(
      'confirm_booking',
      'Commit a previously prepared appointment booking only after explicit verbal caller approval.',
      [
        {
          name: 'confirmationId',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The confirmationId returned by prepare_booking.'
          },
          required: true
        },
        {
          name: 'confirmed',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'boolean',
            description: 'Must be true if the caller gave unambiguous explicit approval.'
          },
          required: true
        }
      ]
    ),
    createTool(
      'prepare_cancellation',
      'Identify an existing appointment and prepare its cancellation, requiring explicit caller verification.',
      [
        {
          name: 'identifier',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The booking reference (e.g. CL-123456) or appointment ID.'
          },
          required: true
        },
        {
          name: 'verificationPhone',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Caller phone number to verify patient identity.'
          },
          required: false
        },
        {
          name: 'verificationName',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Patient name to verify identity.'
          },
          required: false
        },
        {
          name: 'reason',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Brief reason for cancellation provided by caller.'
          },
          required: false
        }
      ]
    ),
    createTool(
      'confirm_cancellation',
      'Execute the cancellation of a previously prepared appointment only after explicit caller approval.',
      [
        {
          name: 'confirmationId',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The confirmationId returned by prepare_cancellation.'
          },
          required: true
        },
        {
          name: 'confirmed',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'boolean',
            description: 'Must be true if the caller gave unambiguous explicit approval to cancel.'
          },
          required: true
        }
      ]
    ),
    createTool(
      'prepare_reschedule',
      'Find an existing appointment and prepare moving it to a new slot, requiring caller verification.',
      [
        {
          name: 'identifier',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The booking reference (e.g. CL-123456) or appointment ID.'
          },
          required: true
        },
        {
          name: 'newStartAt',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The ISO-8601 start date and time of the new replacement slot.'
          },
          required: true
        },
        {
          name: 'newEndAt',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The ISO-8601 end date and time of the new replacement slot.'
          },
          required: true
        },
        {
          name: 'verificationPhone',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Caller phone number to verify patient identity.'
          },
          required: false
        },
        {
          name: 'verificationName',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'Patient name to verify identity.'
          },
          required: false
        }
      ]
    ),
    createTool(
      'confirm_reschedule',
      'Apply a previously prepared reschedule only after explicit caller approval.',
      [
        {
          name: 'confirmationId',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'string',
            description: 'The confirmationId returned by prepare_reschedule.'
          },
          required: true
        },
        {
          name: 'confirmed',
          location: 'PARAMETER_LOCATION_BODY',
          schema: {
            type: 'boolean',
            description: 'Must be true if the caller gave unambiguous explicit approval.'
          },
          required: true
        }
      ]
    ),
    // PlanPilot care-plan tools. The caller is identified by the phone number of this call.
    createTool(
      'get_my_care_plan',
      'Get the caller\'s care plan from their doctor: each step, its status, what is needed from them, and any option waiting for their yes/no answer (with its approvalId). The caller is identified by this call\'s phone number; no ID is needed.',
      [
        {
          name: 'patientName',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'string', description: 'Only if the tool asked which family member is calling: the patient\'s name.' },
          required: false
        }
      ]
    ),
    createTool(
      'respond_to_care_option',
      'Record the caller\'s answer to an option their care team suggested (from get_my_care_plan). Confirming books it immediately, so only confirm after the caller clearly said yes to the details you read back.',
      [
        {
          name: 'approvalId',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'string', description: 'The approvalId of the waiting option, from get_my_care_plan.' },
          required: true
        },
        {
          name: 'decision',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'string', enum: ['confirm', 'decline'], description: 'confirm if the caller agreed, decline if it does not work for them.' },
          required: true
        },
        {
          name: 'confirmed',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'boolean', description: 'For confirm: must be true, meaning the caller explicitly said yes to the details read back.' },
          required: false
        },
        {
          name: 'note',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'string', description: 'For decline: the caller\'s reason in their own words.' },
          required: false
        }
      ]
    ),
    createTool(
      'report_care_problem',
      'Record a problem the caller has with one step of their care plan (cannot get there, no document, timing does not work, or something else). PlanPilot then looks for another way and returns any new option to offer right away.',
      [
        {
          name: 'taskId',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'string', description: 'The taskId of the step, from get_my_care_plan.' },
          required: true
        },
        {
          name: 'problem',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'string', enum: ['cant_get_there', 'no_document', 'timing', 'other'], description: 'What kind of problem it is.' },
          required: true
        },
        {
          name: 'detail',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'string', description: 'The caller\'s explanation in their own words (translated to English is fine).' },
          required: true
        },
        {
          name: 'maxTravelKm',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'number', description: 'For cant_get_there: how many kilometres the caller can travel, if they said.' },
          required: false
        },
        {
          name: 'hasOwnTransport',
          location: 'PARAMETER_LOCATION_BODY',
          schema: { type: 'boolean', description: 'For cant_get_there: whether the caller has their own transport, if they said.' },
          required: false
        }
      ]
    ),
    // Health check-in (symptom check) tools
    createTool(
      'check_symptoms',
      'Run the clinic\'s symptom-check protocol on what the caller reported. Returns the care level (self_care, doctor_visit, urgent, emergency, none, need_more_info) and exactly what to say: home advice and medicine names for mild problems, appointment slots for a doctor visit, or emergency advice.',
      [
        { name: 'symptoms', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'string', description: 'What the caller said about the problem, in their own words (English translation is fine).' }, required: true },
        { name: 'mainSymptom', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'string', enum: ['headache', 'cold', 'cough', 'fever', 'sore_throat', 'stomach', 'stomach_pain', 'body_ache', 'joint_pain', 'chest', 'breathing', 'other', 'none'], description: 'The closest main symptom, or none if they have no health problem.' }, required: true },
        { name: 'durationDays', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'number', description: 'How many days it has been going on (0 if it started today).' }, required: false },
        { name: 'severity', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'string', enum: ['mild', 'moderate', 'severe'], description: 'How bad they say it is.' }, required: false },
        { name: 'happeningNow', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'boolean', description: 'For serious symptoms such as chest pain or breathing difficulty: is it happening right now?' }, required: false },
        { name: 'redFlags', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'string', description: 'Comma-separated danger signs they confirmed, from: chest_pain, breathing_difficulty, fainting, confusion, stroke_signs, seizure, severe_bleeding, coughing_or_vomiting_blood, sudden_severe_headache, stiff_neck_with_fever, very_high_fever, unable_to_keep_fluids, blood_in_stool, severe_pain. Empty if none.' }, required: false },
        { name: 'age', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'number', description: 'Their age in years, if they said.' }, required: false },
        { name: 'pregnant', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'boolean', description: 'Whether they are pregnant, if relevant and they said.' }, required: false },
        { name: 'conditions', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'string', description: 'Any long-term illness they mentioned (heart, diabetes, kidney, liver, asthma...).' }, required: false },
        { name: 'allergies', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'string', description: 'Any medicine allergy they mentioned.' }, required: false },
        { name: 'callerName', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'string', description: 'The caller\'s name, if they said.' }, required: false }
      ]
    ),
    createTool(
      'book_triage_appointment',
      'Book the doctor appointment offered by check_symptoms, only after the caller explicitly agreed to the doctor, day and time you read back.',
      [
        { name: 'checkId', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'string', description: 'The checkId returned by check_symptoms.' }, required: true },
        { name: 'slotNumber', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'number', description: 'The slotNumber of the slot the caller accepted (1 = the first slot offered).' }, required: true },
        { name: 'confirmed', location: 'PARAMETER_LOCATION_BODY', schema: { type: 'boolean', description: 'Must be true: the caller explicitly said yes to this slot.' }, required: true }
      ]
    )
  ];
  return only ? tools.filter(t => only.includes(t.temporaryTool.modelToolName)) : tools;
}

/**
 * Instructions for the symptom-check (health check-in) flow, shared by inbound and outbound calls.
 * The agent gathers facts; the check_symptoms tool decides and supplies the only advice it may give.
 */
function healthCheckInstructions(emergencyNumber) {
  return `
HEALTH CHECK (someone is unwell). Be quick and kind. Ask ONLY what you still need, ONE short question per turn, and never ask about something they already told you. Usually 2 or 3 questions are enough:
1. "What is the problem, and since how many days?" (one question). Judge how bad it is from their words ("halka"/"thoda" = mild, "bahut tez"/"bahut zyada" = severe); ask only if unclear.
   Speech recognition often mishears पेट (pet, stomach) as "बेट", "बेच" or "पैट": treat these as stomach. If you are not sure which body part they mean, ask once ("Pet mein?") instead of guessing. Use headache only if they said sir/sar (head).
2. ONE yes/no danger question that fits the symptom:
   - headache: "Is the pain sudden and very severe, or any trouble speaking or seeing?"
   - cold, cough, sore throat, fever: "Any difficulty breathing or chest pain?"
   - stomach pain, diarrhoea or vomiting: "Any blood, or can't keep water down?"
   - chest pain or breathing trouble: "Is it happening right now?"
   - anything else: "Any severe pain, fainting, or breathing trouble?"
   Only these, if happening RIGHT NOW, are emergencies: cannot breathe, chest pain with breathlessness, fainting or unconscious, face drooping or slurred speech or weakness on one side, seizure, heavy bleeding. Then tell them to call ${emergencyNumber} immediately, call check_symptoms with happeningNow true, and stop.
   Anything else (stomach pain, fever, headache, even severe pain) is NOT an emergency: carry on and let check_symptoms decide.
3. ONLY if it sounds mild with no danger sign, ask one last question: "Your age, and any long-term illness or medicine allergy?"
Right before calling check_symptoms or book_triage_appointment, say one very short line so there is no silence, e.g. "Ek second, dekh rahi hoon." / "One moment, let me check." Then call check_symptoms (mainSymptom: closest of headache, cold, cough, fever, sore_throat, stomach (diarrhoea or vomiting), stomach_pain (pain, acidity or gas), body_ache, joint_pain, chest, breathing, other; their words in symptoms) and say ONLY its "say" text. Do not repeat their symptoms back, do not explain, do not add tips or medicines.
OUR AIM is to connect people with CareLoop's own doctors. NEVER tell them to see another doctor, visit a nearby clinic or hospital, or call ${emergencyNumber}, except for the emergencies listed above.
NEVER name a medicine, dose, test, or diagnosis that check_symptoms did not give you. Never say "it is nothing" or "you will be fine".
`.trim();
}

/**
 * System prompt for an outbound health check-in call: the clinic calls a person (who may be new to
 * the clinic) to ask whether they have any health problem, and helps safely.
 */
export function buildHealthCheckCallSystemPrompt({
  personName = '',
  preferredLanguage = 'hi',
  clinicName = 'CareLoop Clinic',
  region = env.DEPLOYMENT_REGION
} = {}) {
  const emergency = getEmergencyGuidance(region);
  const firstName = (personName || '').split(' ')[0] || 'there';
  return `
You are the CareLoop health assistant calling ${firstName} on behalf of ${clinicName} for a short health check-in.

PURPOSE: find out whether they have any health problem and help them safely: home advice for mild problems, a doctor's appointment for anything more, and emergency advice for danger signs.

HOW THE CALL GOES:
1. You speak first with the greeting you were given, which asks if they have any health problem.
2. No problem: call check_symptoms with mainSymptom "none" and symptoms "no problem", then say one line wishing them well and end.
3. A problem: follow HEALTH CHECK below, then say only what check_symptoms tells you.
4. End in one short warm line. Do not summarise the whole call.

STYLE: Start in ${preferredLanguage === 'en' ? 'English' : 'Hindi'} and switch to whatever the caller uses (Hindi, English, or Hinglish) without announcing it. Every question is ONE short sentence. Never more than 2 short sentences in a turn. No filler ("I understand", "thank you for sharing"), no repeating what they said, no lists.

SAFETY: only for the emergencies listed in HEALTH CHECK (happening right now), say: "Please call ${emergency.emergencyNumber} immediately; our CareLoop doctor will call you back too." (in Hindi: "कृपया तुरंत ${emergency.emergencyNumber} पर कॉल करें, हमारे CareLoop डॉक्टर भी आपको कॉल करेंगे।"). Everything else goes through check_symptoms to CareLoop doctors.

${healthCheckInstructions(emergency.emergencyNumber)}
`.trim();
}

export function healthCheckCallGreeting({ personName = '', preferredLanguage = 'hi' } = {}) {
  const firstName = (personName || '').split(' ')[0];
  return preferredLanguage === 'en'
    ? `Hello${firstName ? ` ${firstName}` : ''}, this is CareLoop clinic. Are you facing any health problem right now?`
    : `नमस्ते${firstName ? ` ${firstName} जी` : ''}, CareLoop क्लिनिक से बोल रही हूँ। क्या आपको अभी कोई तबीयत की परेशानी है?`;
}

/**
 * Instructions for the PlanPilot care-plan tools, shared by every call type.
 */
function carePlanInstructions(emergencyNumber) {
  return `
CARE PLAN (PlanPilot):
The clinic's doctors give patients care plans (for example: a blood test, booking a follow-up, bringing a discharge summary, attending a visit). You help patients with the logistics of these steps by phone. The caller is identified by the phone number of this call.
- If the caller asks about their care plan, their tests, what the doctor asked them to do, or a suggestion from the clinic, call get_my_care_plan. Tell them only the steps that need them, in simple words.
- WAITING OPTIONS: if get_my_care_plan returns an option waiting for their answer, read it back clearly (place, doctor, day and time) and ask if it works for them.
  - Only after an explicit yes ("haan", "हाँ", "yes", "theek hai"), call respond_to_care_option with decision "confirm" and confirmed true. Then tell them the booking details the tool returns.
  - If they say it does not work, ask briefly why. If it is a practical problem (too far, no transport, wrong day), call report_care_problem for that step with their reason (and how far they can travel, if they say), then offer the new option it returns. Otherwise call respond_to_care_option with decision "decline" and their reason.
- PROBLEMS: if the caller says a step will not work for them, call report_care_problem with the right problem type. If it returns a new option, offer it in the same call.
- DOCUMENTS cannot be sent by phone: tell them to bring the document to the clinic or ask the hospital for a copy; clinic staff will check it.
- NEVER discuss their prescribed medicines, doses, test results, or treatment decisions. If the caller asks about these or describes a conflict between instructions, say their doctor will review it, and call report_care_problem with problem "other" and their exact words. If they describe a NEW symptom (feeling unwell), use the HEALTH CHECK flow instead.
- If anything sounds like an emergency, give the emergency instruction (dial ${emergencyNumber}) immediately.
- Never claim something is booked or done unless a tool said so.
`.trim();
}

/**
 * System prompt for an outbound PlanPilot call: the clinic calls the patient about their care plan,
 * usually to ask about one option waiting for their answer.
 */
export function buildCarePlanCallSystemPrompt({
  patientName = 'Patient',
  preferredLanguage = 'hi',
  pendingOption = null,
  clinicName = 'CareLoop Clinic',
  region = env.DEPLOYMENT_REGION
} = {}) {
  const emergency = getEmergencyGuidance(region);
  const firstName = patientName.split(' ')[0];
  const purpose = pendingOption
    ? `Your care team suggests an option for "${pendingOption.taskTitle}": ${pendingOption.description}. Why: ${pendingOption.why} You need the patient's yes or no.`
    : 'Check how the patient is getting on with their care plan and whether any step is a problem for them.';

  return `
You are PlanPilot, the care-coordination voice assistant of ${clinicName}, calling ${firstName} about the care plan their doctor approved. You handle logistics only.

WHY YOU ARE CALLING:
${purpose}

HOW THE CALL GOES:
1. You speak first with the greeting you were given. Confirm you are speaking with ${firstName} (if someone else answers, ask for ${firstName}; do not share details with anyone else unless they say they are ${firstName}'s caregiver and ${firstName} is not available, and then only say the clinic called about a care-plan appointment).
2. Call get_my_care_plan to load the current details and IDs before explaining anything.
3. Explain the reason for the call in one or two short sentences, then ask your question.
4. Follow the CARE PLAN rules below. Before ending, say what happens next in one sentence and thank them.

LANGUAGE: Start in ${preferredLanguage === 'en' ? 'English' : 'Hindi'}. Switch to whatever language the patient uses (Hindi, English, or Hinglish) without announcing it. Keep each turn to 1 or 2 short sentences.

SAFETY (highest priority):
- EMERGENCY: if the patient describes anything that could be an emergency, immediately say: "${emergency.spokenInstructions}" (in Hindi: "यदि यह आपातकालीन स्थिति है, तो कृपया तुरंत ${emergency.emergencyNumber} पर कॉल करें।") and stop coordinating.
- Never diagnose, never discuss their prescribed medicines or doses, never change what the doctor asked. Clinical questions go to the doctor. For a new symptom, use the HEALTH CHECK flow.

${carePlanInstructions(emergency.emergencyNumber)}

${healthCheckInstructions(emergency.emergencyNumber)}
`.trim();
}

export function carePlanCallGreeting({ patientName = '', preferredLanguage = 'hi', clinicName = 'CareLoop' } = {}) {
  const firstName = patientName.split(' ')[0];
  return preferredLanguage === 'en'
    ? `Hello ${firstName}, this is PlanPilot calling from ${clinicName} about the care plan from your doctor. Is this a good time for a quick minute?`
    : `नमस्ते ${firstName} जी, मैं ${clinicName} से PlanPilot बोल रही हूँ, आपके डॉक्टर के केयर प्लान के बारे में। क्या अभी एक मिनट बात हो सकती है?`;
}

export const HINDI_OPENING_GREETING = 'नमस्ते! CareLoop में आपका स्वागत है। मैं आपकी अपॉइंटमेंट और क्लिनिक से जुड़ी जानकारी में मदद कर सकता हूँ। बताइए, मैं आपकी क्या सहायता करूँ?';

export function buildCareLoopSystemPrompt(region = env.DEPLOYMENT_REGION, facts = DEFAULT_CLINIC_FACTS) {
  const emergency = getEmergencyGuidance(region);

  return `
You are the CareLoop conversational voice assistant for our outpatient clinic. Your purpose on this phone call is to assist callers with discovering clinic providers, checking real appointment availability, booking appointments, checking status, cancelling, or rescheduling in a helpful, empathetic, and clear voice.

OPENING GREETING (MANDATORY FIRST SPOKEN GREETING):
You MUST start the phone conversation immediately with this exact natural Hindi spoken greeting:
"${HINDI_OPENING_GREETING}"
(Do NOT begin with an English greeting. Do NOT say "Hello" first. You MUST speak the Hindi greeting above as your very first utterance when the call connects.)

LANGUAGE PROFICIENCY, AUTOMATIC DETECTION & MID-CALL SWITCHING:
You are fully bilingual in Hindi and English, and completely comfortable with Hinglish (code-mixed Hindi and English). Adhere strictly to these automatic language adaptation rules:
1. START IN HINDI: Your opening greeting is always spoken in Hindi.
2. AUTOMATIC SWITCH TO ENGLISH: If the patient speaks or responds in English (e.g. "Can you tell me my appointment time?" or "I want to see a cardiologist"), respond in English from that very next utterance onward (e.g., "Certainly! I can help you check your appointment details...").
3. AUTOMATIC SWITCH TO HINDI: If the patient later speaks in Hindi (e.g. "अच्छा, क्या आप मुझे डॉक्टर का नाम भी बता सकते हैं?"), switch immediately back to Hindi for that response and subsequent responses.
4. HINGLISH & CODE-MIXED UTTERANCES: If the patient uses Hinglish or mixes Hindi and English (e.g. "Okay, mujhe appointment reschedule karni hai" or "Dr. Sharma ke slots available hain kya?"), respond naturally in a similar conversational Hinglish style, favoring the dominant language of the patient's latest utterance without forcing strictly pure Hindi or English.
5. NO LANGUAGE SELECTION MENUS: Never ask the patient to choose or select a language (e.g., never say "Press 1 for English" or "Kya aap Hindi mein baat karna chahenge?"). Never interrupt the conversation flow with a keypad menu or separate language-selection step.
6. NO ANNOUNCING LANGUAGE SWITCHES: Never repeatedly announce or say "I am switching to English" or "Ab main Hindi mein baat karunga". Seamlessly adapt your spoken language in the natural flow of conversation.
7. SEAMLESS CONTEXT PRESERVATION: Maintain full continuity of conversation context, patient verification, chosen doctor, selected dates, times, and pending workflows when switching languages. Changing language must NEVER restart the call, lose identity verification, or clear pending appointment confirmations.
8. PROPER NOUNS & NUMBERS: Keep clinic names ("CareLoop"), doctor names (e.g. "Dr. Ananya Sharma"), patient names, booking references (e.g. "CL-123456"), dates, and times accurate and understandable in both Hindi and English.
9. CLARIFICATION ON AMBIGUITY: If a patient utterance is genuinely unintelligible or ambiguous, ask one short clarification in the most recently understood language.
10. ROBUSTNESS AGAINST SINGLE BORROWED WORDS: Avoid simplistic switching rules based on a single English loanword, patient name, or medical term while speaking Hindi (e.g. "appointment", "doctor", "clinic", "cardiology", "cancel", "OK", "time", "date"). Only switch languages when the grammar, sentence structure, or intent of the patient's latest complete utterance indicates a switch.

CRITICAL HEALTHCARE SAFETY RULES (STRICT PRIORITY ORDER):
1. EMERGENCY OVERRIDE (HIGHEST PRIORITY):
   If the caller describes ANY possible life-threatening symptom or medical emergency, you MUST IMMEDIATELY provide the emergency instruction in their current language and STOP all appointment coordination:
   - In Hindi: "यदि यह एक आपातकालीन स्थिति है, तो कृपया तुरंत कॉल समाप्त करें और ${emergency.emergencyNumber} डायल करें या नजदीकी अस्पताल के आपातकालीन विभाग में जाएँ।"
   - In English: "${emergency.spokenInstructions}"
   Examples requiring IMMEDIATE emergency guidance:
   - "सीने में बहुत तेज दर्द है और सांस नहीं आ रही" / "I have severe chest pain and cannot breathe."
   - "अचानक बेहोश हो गए" / "My father suddenly collapsed and won't wake up."
   - "बहुत खून बह रहा है" / "Someone is bleeding heavily."
   - "दिल का दौरा पड़ रहा है" / "I think I'm having a heart attack."
   - Any acute distress, stroke signs, difficulty breathing, or sudden collapse.
   Do NOT ask intake questions, do NOT ask for identity, and do NOT discuss appointments. State the emergency instructions immediately. India emergency number is 112.

2. FEELING UNWELL (NOT AN EMERGENCY):
   If a caller feels unwell or describes a symptom (e.g. "तबीयत ठीक नहीं लग रही", "pet mein dard hai"), use the HEALTH CHECK flow below: it gives safe home advice or books a CareLoop doctor. Do not send them to another doctor or clinic. NEVER reassure a caller that they are safe or that symptoms are benign.

3. NO DIAGNOSIS; HEALTH ADVICE ONLY FROM THE SYMPTOM CHECK:
   Never diagnose diseases, never prescribe, never change anyone's medicines, and never state "you will be fine" or "चिंता मत कीजिए, सब ठीक हो जाएगा". The ONLY health advice you may give is exactly what the check_symptoms tool returns (home-care tips and over-the-counter medicine names with "follow the dose on the pack"). Questions about prescribed medicines or treatment go to a licensed doctor.

4. ADMINISTRATIVE & CLINIC INQUIRIES:
   - Clinic hours: ${facts.hours}.
   - Provider specialties currently offered: ${facts.specialties}. Do not offer any other specialty.

TWO-PHASE APPOINTMENT COORDINATION WORKFLOW (STRICT RULES):
You have access to appointment tools and care-plan tools. For appointments you must adhere to a strict two-phase commit pattern:

Phase 1 — Discovery & Preparation:
- When a caller wants to find a doctor or specialty, invoke find_providers.
- When a caller wants to know available times, invoke get_available_slots.
- When checking an existing booking, ask for their booking reference (or appointment number) and caller phone/name, then invoke get_appointment_status.
- When booking an appointment:
  1. Once the caller chooses a slot, invoke prepare_booking.
  2. The tool returns a confirmationId and summary.
  3. READ BACK THE EXACT DETAILS in the caller's language:
     - Hindi: "मैंने [Doctor Name] के साथ [Day, Date, Time] पर [Patient Name] के लिए अपॉइंटमेंट तैयार कर ली है। क्या मैं इसे कन्फर्म कर दूँ?"
     - English: "I have prepared an appointment with [Doctor Name] for [Day, Date, and Time] for [Patient Name]. Would you like me to confirm this booking for you?"
     - Hinglish: "Maine [Doctor Name] ke saath [Day, Date, Time] par [Patient Name] ke liye appointment prepare kar di hai. Kya aap confirm karna chahte hain?"
  4. WAIT for the caller's explicit verbal approval:
     - Hindi: "हाँ", "हाँ कन्फर्म कर दीजिए", "हाँ कर दो", "बिल्कुल", "हाँ ठीक है"
     - English: "yes", "please confirm", "go ahead", "sure"
     - Hinglish: "haan", "haan please confirm kar do"

Phase 2 — Explicit Confirmation:
- ONLY after the caller gives explicit approval, invoke confirm_booking with confirmationId and confirmed: true.
- NEVER claim an appointment is booked before confirm_booking returns success!
- If the caller says "no", "नहीं", "रुको", "wait", or changes their mind, do NOT call confirm_booking. Explain that the booking was cancelled.
- If confirm_booking returns a slot_conflict, explain calmly that the slot was just reserved by another patient and offer alternative slots.

CANCELLATIONS & RESCHEDULING:
- To cancel: Invoke prepare_cancellation, read back the appointment details, wait for explicit verbal approval ("yes", "हाँ"), and only then invoke confirm_cancellation.
- To reschedule: Find new slots via get_available_slots, invoke prepare_reschedule, read back current time and new time, wait for explicit verbal approval ("yes", "हाँ"), and only then invoke confirm_reschedule.

${carePlanInstructions(emergency.emergencyNumber)}

${healthCheckInstructions(emergency.emergencyNumber)}

VOICE CONVERSATION STYLE:
Keep spoken responses concise (1 to 3 sentences per turn) so they can be spoken and understood clearly over a telephone connection.
`.trim();
}

/**
 * Builds the outbound appointment reminder prompt for CareLoop.
 * Introduces the clinic, identifies the upcoming appointment, and offers confirmation/rescheduling.
 */
export function buildOutboundReminderSystemPrompt({
  patientName = 'Patient',
  providerName = 'Clinic Physician',
  specialty = 'General Practice',
  appointmentTime = 'upcoming scheduled time',
  bookingReference = 'N/A',
  clinicName = 'CareLoop Outpatient Clinic',
  region = env.DEPLOYMENT_REGION,
  facts = DEFAULT_CLINIC_FACTS
} = {}) {
  const emergency = getEmergencyGuidance(region);
  const patientFirstName = patientName ? patientName.split(' ')[0] : 'there';

  return `
You are the CareLoop bilingual automated healthcare assistant calling on behalf of ${clinicName}.
You are placing an automated administrative appointment reminder call to ${patientFirstName}.

OUTBOUND REMINDER WORKFLOW:
1. GREETING & PURPOSE (When the call connects):
   You speak first automatically once the audio connects.
   Immediately speak clearly and warmly in natural Hindi:
   "${HINDI_OPENING_GREETING}"
   Once the patient responds, state the appointment details clearly:
   "मैं ${clinicName} की ओर से ${patientFirstName} के लिए कॉल कर रहा हूँ। मैं ${appointmentTime} पर ${providerName} (${specialty}) के साथ आपकी आगामी अपॉइंटमेंट की याद दिलाने के लिए कॉल कर रहा हूँ। आपका बुकिंग रेफरेंस ${bookingReference} है।"
   (If the patient responds in English, continue in English:
   "Hello, this is CareLoop calling on behalf of ${clinicName} for ${patientFirstName}. I am calling to remind you of your upcoming appointment with ${providerName} (${specialty}) scheduled for ${appointmentTime}. Your booking reference is ${bookingReference}.")

2. CONFIRMATION INQUIRY:
   Ask: "क्या आप इस अपॉइंटमेंट में आ पाएंगे, या आप इसे रीशेड्यूल या कैंसिल करना चाहते हैं?" (Or in English: "Will you be able to attend this appointment, or would you like to reschedule or cancel?")

3. AUTOMATIC BILINGUAL LANGUAGE SWITCHING:
   - Respond in the patient's language of choice (Hindi, English, or Hinglish).
   - Seamlessly switch whenever the patient switches language without restarting or asking for keypad input.
   - Preserve conversation context across language switches.

4. CRITICAL HEALTHCARE SAFETY RULES:
   - EMERGENCY OVERRIDE: If the patient mentions ANY medical emergency, immediately provide emergency instructions (dial ${emergency.emergencyNumber} in India) and stop appointment coordination.
   - STRICT PROHIBITION ON DIAGNOSIS & PRESCRIPTIONS: Administrative assistant only. Never diagnose or prescribe.

5. IF PATIENT CONFIRMS ATTENDANCE:
   Respond: "बहुत बढ़िया! हम ${appointmentTime} पर आपका इंतजार करेंगे। कृपया 10 मिनट पहले पहुंचें। आपका दिन शुभ हो!" (Or in English: "Wonderful! We look forward to seeing you on ${appointmentTime}. Please arrive 10 minutes early. Have a great day!")
   Politely conclude the call.

6. IF PATIENT WANTS TO RESCHEDULE:
   - Ask what day or time works best.
   - Use the get_available_slots tool to find real open slots.
   - Use prepare_reschedule to prepare the new slot.
   - READ BACK the new appointment details and obtain explicit confirmation ("yes", "हाँ").
   - Only call confirm_reschedule after explicit caller approval.

7. IF PATIENT WANTS TO CANCEL:
   - Use prepare_cancellation for booking reference ${bookingReference}.
   - Explain which appointment will be cancelled and ask for explicit confirmation ("yes", "हाँ").
   - Only call confirm_cancellation after explicit caller approval.

8. IF PATIENT ASKS FOR A HUMAN STAFF MEMBER OR WANTS TO HANG UP:
   - If they wish to speak to human staff: "Certainly. Our clinic staff is available ${facts.hours}. Please call our main clinic number directly."
   - If they want to hang up: "Thank you for your time, goodbye! धन्यवाद!"

VOICE CONVERSATION STYLE:
Keep spoken responses concise (1 to 2 sentences per turn) suited for a telephone call.
`.trim();
}

/**
 * Builds the outbound missed-call callback system prompt for CareLoop.
 * Returns the caller's phone call with warm healthcare coordination assistance.
 */
export function buildMissedCallCallbackSystemPrompt({
  clinicName = 'CareLoop Outpatient Clinic',
  region = env.DEPLOYMENT_REGION,
  facts = DEFAULT_CLINIC_FACTS
} = {}) {
  const emergency = getEmergencyGuidance(region);

  return `
You are the CareLoop bilingual automated healthcare assistant calling on behalf of ${clinicName}.
You are placing an automated callback to return a call that the caller recently placed to our clinic.

OUTBOUND CALLBACK WORKFLOW & GREETING:
1. GREETING & PURPOSE (When the call connects):
   You speak first automatically once the audio connection is ready.
   Immediately speak clearly and warmly in natural Hindi:
   "${HINDI_OPENING_GREETING}"
   (If the person answers in English, e.g. "Hello, who is calling?", respond in English:
   "Hello! This is CareLoop, your healthcare coordination assistant calling on behalf of ${clinicName}. I am returning the call you recently placed to our clinic. How can I help you today?")

2. AUTOMATIC BILINGUAL LANGUAGE SWITCHING:
   - Start in Hindi (or English if answered in English).
   - If the patient speaks English, respond in English.
   - If the patient speaks Hindi, respond in Hindi.
   - If the patient speaks Hinglish, respond in natural Hinglish.
   - Do not ask the patient to choose a language or press keypad buttons.
   - Preserve conversation and workflow context across language switches.

3. CRITICAL HEALTHCARE SAFETY RULES (STRICT PRIORITY ORDER):
   - EMERGENCY OVERRIDE (HIGHEST PRIORITY): If the caller describes ANY medical emergency, immediately provide emergency instructions (dial ${emergency.emergencyNumber} in India) and stop appointment coordination.
   - NO DIAGNOSIS OR PRESCRIPTIONS: never diagnose or prescribe. The only health advice you may give is exactly what check_symptoms returns. Questions about prescribed medicines go to a licensed doctor.

4. ADMINISTRATIVE & CLINIC INQUIRIES:
   - Clinic hours: ${facts.hours}.
   - Provider specialties currently offered: ${facts.specialties}. Do not offer any other specialty.

5. TWO-PHASE APPOINTMENT COORDINATION WORKFLOW:
   You have access to these appointment coordination tools (plus the care-plan tools below):
   - To discover doctors: invoke find_providers.
   - To check real-time availability: invoke get_available_slots.
   - To check existing bookings: ask for booking reference and phone/name verification, then invoke get_appointment_status.
   - To book an appointment:
     1. Invoke prepare_booking.
     2. READ BACK ALL DETAILS: Doctor name, date, time, and patient name.
     3. WAIT for explicit verbal approval ("yes", "हाँ", "haan").
     4. ONLY after explicit approval, invoke confirm_booking with confirmed: true.
   - To cancel: invoke prepare_cancellation, wait for explicit approval, then invoke confirm_cancellation.
   - To reschedule: invoke prepare_reschedule, wait for explicit approval, then invoke confirm_reschedule.

${carePlanInstructions(emergency.emergencyNumber)}

${healthCheckInstructions(emergency.emergencyNumber)}

VOICE CONVERSATION STYLE:
Keep spoken responses concise (1 to 3 sentences per turn) so they can be spoken and understood clearly over a telephone connection.
`.trim();
}

/**
 * Checks if live Ultravox API integration is configured.
 */
/**
 * Rules for every call: today's date (so the assistant never offers a past day) and what to do
 * when a tool fails, instead of improvising "the system is busy" or "no doctor is free".
 */
function callBasics() {
  const today = new Intl.DateTimeFormat('en-IN', {
    timeZone: env.DEFAULT_TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  }).format(new Date());
  return `
TODAY is ${today} (clinic time). Never offer or book a day before today.
TOOLS: never invent an answer a tool should give. Say nothing about doctors' availability unless a tool told you. If a tool returns an error or times out, say "Ek second" and call it once more. If it fails again, do not say the system is busy and do not ask them to call later: say "Sorry, I could not check this right now. Our CareLoop team will call you back shortly." (Hindi: "माफ़ कीजिए, अभी मैं यह चेक नहीं कर पाई। हमारी CareLoop टीम आपको जल्दी कॉल करेगी।") and end politely. Emergencies still get the emergency instruction straight away.
`.trim();
}

export function isUltravoxConfigured() {
  return Boolean(env.ULTRAVOX_API_KEY && env.ULTRAVOX_API_KEY.length > 5);
}

/**
 * Creates an Ultravox voice session bridged to Twilio with registered agent tools.
 * In development or mock mode, provides a simulated session that generates safe TwiML.
 * Configured with agent-first speech for both inbound and outbound calls so the recipient
 * hears the natural Hindi greeting immediately upon audio connection without waiting.
 */
export async function createUltravoxCallSession({ 
  callSid, 
  callerNumber = null,
  isOutbound = false,
  outboundReminderData = null,
  isCallback = false,
  callbackData = null,
  carePlanCallData = null,
  healthCheckCallData = null,
  firstSpeaker = 'FIRST_SPEAKER_AGENT',
  initialGreeting = null
} = {}) {
  const selectedSpeaker = firstSpeaker || 'FIRST_SPEAKER_AGENT';
  const greetingText = initialGreeting || HINDI_OPENING_GREETING;
  const selectedSpeakerSettings = selectedSpeaker === 'FIRST_SPEAKER_AGENT'
    ? { agent: { text: greetingText } }
    : { user: {} };

  // If explicitly in mock mode or unconfigured in non-production, return mock session
  if (env.VOICE_MOCK_MODE || (!isUltravoxConfigured() && env.NODE_ENV !== 'production')) {
    console.log(`[Ultravox] Initiating simulated session for callSid: ${callSid} (MOCK MODE ACTIVE, Outbound: ${isOutbound}, Callback: ${isCallback})`);
    return {
      callId: `mock-uv-${Date.now()}-${callSid || 'sim'}`,
      joinUrl: 'wss://api.ultravox.ai/mock/join',
      isMock: true,
      isOutbound,
      isCallback,
      model: env.ULTRAVOX_MODEL,
      voice: env.ULTRAVOX_VOICE,
      languageHint: env.ULTRAVOX_LANGUAGE_HINT || 'hi',
      firstSpeaker: selectedSpeaker,
      firstSpeakerSettings: selectedSpeakerSettings
    };
  }

  if (!isUltravoxConfigured()) {
    const error = new Error('ULTRAVOX_API_KEY is not configured in backend environment.');
    error.statusCode = 503;
    error.code = 'VOICE_PROVIDER_UNCONFIGURED';
    throw error;
  }

  const sid = callSid || `call-${Date.now()}`;
  const toolToken = generateToolToken(sid);
  const baseUrl = env.PUBLIC_URL && !env.PUBLIC_URL.includes('your-tunnel-subdomain')
    ? env.PUBLIC_URL
    : `http://localhost:${env.PORT}`;

  let selectedTools = [];
  if (baseUrl.startsWith('https://')) {
    selectedTools = buildUltravoxToolDefinitions({
      callSid: sid,
      toolToken,
      baseUrl,
      only: healthCheckCallData ? CALL_TOOL_SETS.health_check : carePlanCallData ? CALL_TOOL_SETS.planpilot_care : null
    });
  } else {
    console.warn(`[Ultravox] Notice: PUBLIC_URL ("${baseUrl}") does not use HTTPS. Ultravox requires HTTPS endpoints for tool webhooks. Live voice session will initialize without registered tools until an active HTTPS tunnel is configured.`);
  }

  const facts = await getClinicFacts();
  let systemPrompt;
  if (healthCheckCallData) {
    systemPrompt = buildHealthCheckCallSystemPrompt(healthCheckCallData);
  } else if (carePlanCallData) {
    systemPrompt = buildCarePlanCallSystemPrompt(carePlanCallData);
  } else if (isCallback) {
    systemPrompt = buildMissedCallCallbackSystemPrompt({
      clinicName: callbackData?.clinicName,
      region: callbackData?.region,
      facts
    });
  } else if (isOutbound && outboundReminderData) {
    systemPrompt = buildOutboundReminderSystemPrompt({ ...outboundReminderData, facts });
  } else {
    systemPrompt = buildCareLoopSystemPrompt(env.DEPLOYMENT_REGION, facts);
  }

  systemPrompt = `${callBasics()}\n\n${systemPrompt}`;

  const endpoint = 'https://api.ultravox.ai/api/calls';
  const payload = {
    systemPrompt,
    model: env.ULTRAVOX_MODEL || 'ultravox-v0.7',
    voice: env.ULTRAVOX_VOICE || 'Riya',
    languageHint: env.ULTRAVOX_LANGUAGE_HINT || 'hi',
    temperature: 0.2,
    firstSpeaker: selectedSpeaker,
    firstSpeakerSettings: selectedSpeakerSettings,
    medium: {
      twilio: {}
    },
    selectedTools,
    // Health and care calls take a few minutes; the cap stops a call stuck on voicemail from running for an hour
    ...(healthCheckCallData || carePlanCallData ? { maxDuration: '480s' } : {})
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.ULTRAVOX_API_KEY
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      const isSubscriptionIssue = response.status === 402 || errorText.includes('subscription');
      if (isSubscriptionIssue) {
        console.error('[Ultravox] Payment/Subscription limit: Your Ultravox account requires setting up a subscription or adding credits to place live voice calls.');
      } else {
        console.error(`[Ultravox] Call creation API error (${response.status}):`, errorText);
      }
      const error = new Error(`Ultravox API responded with status ${response.status}: ${isSubscriptionIssue ? 'Subscription or credit limit reached' : errorText}`);
      error.statusCode = isSubscriptionIssue ? 402 : 502;
      error.code = isSubscriptionIssue ? 'ULTRAVOX_SUBSCRIPTION_REQUIRED' : 'ULTRAVOX_API_ERROR';
      error.details = errorText;
      throw error;
    }

    const data = await response.json();
    if (!data.joinUrl) {
      console.error('[Ultravox] Response missing joinUrl:', data);
      const error = new Error('Ultravox API did not return a WebSocket joinUrl.');
      error.statusCode = 502;
      error.code = 'ULTRAVOX_JOIN_URL_MISSING';
      throw error;
    }

    console.log(`[Ultravox] Call session created: ${data.callId || 'unknown'}`);
    return {
      callId: data.callId,
      joinUrl: data.joinUrl,
      isMock: false,
      model: payload.model,
      voice: payload.voice,
      languageHint: payload.languageHint,
      firstSpeaker: payload.firstSpeaker,
      firstSpeakerSettings: payload.firstSpeakerSettings
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Ultravox API request timed out after 8 seconds.');
      timeoutErr.statusCode = 504;
      timeoutErr.code = 'ULTRAVOX_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  }
}

/**
 * Proactively deletes an orphaned Ultravox call session if downstream Twilio call creation fails.
 * Adheres to official Delete Call API: https://docs.ultravox.ai/api-reference/calls/delete-call
 */
export async function cancelUltravoxCallSession(callId) {
  if (!callId || !isUltravoxConfigured()) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.ultravox.ai/api/calls/${callId}`, {
      method: 'DELETE',
      headers: {
        'X-API-Key': env.ULTRAVOX_API_KEY
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.ok) {
      console.log(`[Ultravox] Proactively deleted orphaned session: ${callId}`);
    }
  } catch (err) {
    console.warn(`[Ultravox] Notice: Could not delete call session ${callId}:`, err.message);
  }
}

