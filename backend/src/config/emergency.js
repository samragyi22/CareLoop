import { env } from './env.js';

export const REGIONAL_EMERGENCY_CONFIG = {
  IN: {
    regionName: 'India',
    emergencyNumber: '112',
    facilityName: 'nearest hospital emergency department',
    spokenInstructions: 'If you are experiencing a life-threatening medical emergency, please hang up immediately and dial 1 1 2 or seek immediate emergency care at your nearest hospital.'
  },
  US: {
    regionName: 'United States',
    emergencyNumber: '911',
    facilityName: 'nearest emergency room',
    spokenInstructions: 'If you are experiencing a life-threatening medical emergency, please hang up immediately and dial 9 1 1 or proceed to the nearest emergency room.'
  },
  UK: {
    regionName: 'United Kingdom',
    emergencyNumber: '999',
    facilityName: 'nearest Accident and Emergency department',
    spokenInstructions: 'If you are experiencing a life-threatening medical emergency, please hang up immediately and dial 9 9 9 or proceed to your nearest accident and emergency department.'
  }
};

/**
 * Returns emergency guidance for the configured deployment region.
 * Note: Caller location is NEVER inferred solely from caller phone number.
 */
export function getEmergencyGuidance(region = env.DEPLOYMENT_REGION) {
  const norm = (region || 'IN').toUpperCase().trim();
  const config = REGIONAL_EMERGENCY_CONFIG[norm] || REGIONAL_EMERGENCY_CONFIG.IN;

  const emergencyNumber = env.EMERGENCY_NUMBER || config.emergencyNumber;
  const facilityName = config.facilityName;
  const spokenInstructions = `If you are experiencing a life-threatening medical emergency, please hang up immediately and dial ${emergencyNumber.split('').join(' ')} or seek immediate emergency care at your ${facilityName}.`;
  const spokenInstructionsHindi = `यदि यह एक आपातकालीन स्थिति है, तो कृपया तुरंत कॉल समाप्त करें और ${emergencyNumber.split('').join(' ')} डायल करें या नजदीकी अस्पताल के आपातकालीन विभाग में जाएँ।`;

  return {
    region: norm,
    regionName: config.regionName,
    emergencyNumber,
    facilityName,
    spokenInstructions,
    spokenInstructionsHindi
  };
}

// Red-flag clinical emergency triggers for immediate human emergency intervention (English, Hindi, and Hinglish)
const RED_FLAG_PATTERNS = [
  /chest pain|chest tightness|chest pressure|सीने में (तेज )?दर्द|छाती में दर्द|seene me(in)? (tez )?dard|chhati me(in)? dard/i,
  /cannot breathe|can't breathe|shortness of breath|trouble breathing|struggling to breathe|gasping|सांस (नहीं आ रही|लेने में तकलीफ|फूल रही)|saans (nahi aa rahi|lene me|phool rahi)/i,
  /collapsed|suddenly collapsed|unconscious|passed out|won't wake up|unresponsive|fainted|बेहोश|behosh|chakkar kha ke gir/i,
  /bleeding heavily|heavy bleeding|bleeding profusely|uncontrolled bleeding|खून बह रहा|khoon beh raha/i,
  /heart attack|cardiac arrest|stroke|face drooping|slurred speech|sudden numbness|दिल का दौरा|dil ka daura/i,
  /suicid|kill myself|end my life|overdose|आत्महत्या|jaan lena|jaan dena/i,
  /anaphylaxis|throat swelling|severe allergic reaction|गला सूज/i
];

// Ambiguous symptom triggers requiring prompt clinical evaluation (English, Hindi, and Hinglish)
const AMBIGUOUS_PATTERNS = [
  /feel unwell|feeling unwell|not sure if (it's )?serious|feel sick|feeling sick|under the weather|dizzy|तबीयत (खराब|ठीक नहीं)|tabiyat (kharab|theek nahi)|achha nahi lag raha|chakkar aa rahe/i
];

/**
 * Deterministic safeguard to assess emergency risk in caller statements.
 * Provides a reliable classification safeguard without building a full decision engine.
 */
export function assessEmergencyRisk(text, region = env.DEPLOYMENT_REGION) {
  if (!text || typeof text !== 'string') {
    return { isEmergency: false, isAmbiguous: false, guidance: null };
  }

  const clean = text.trim();
  const guidance = getEmergencyGuidance(region);

  for (const pattern of RED_FLAG_PATTERNS) {
    if (pattern.test(clean)) {
      return {
        isEmergency: true,
        isAmbiguous: false,
        emergencyNumber: guidance.emergencyNumber,
        spokenInstructions: guidance.spokenInstructions,
        recommendation: `Immediate emergency protocol: dial ${guidance.emergencyNumber} or visit ${guidance.facilityName}.`
      };
    }
  }

  for (const pattern of AMBIGUOUS_PATTERNS) {
    if (pattern.test(clean)) {
      return {
        isEmergency: false,
        isAmbiguous: true,
        emergencyNumber: guidance.emergencyNumber,
        spokenInstructions: `If your symptoms worsen or become acute, please dial ${guidance.emergencyNumber.split('').join(' ')} immediately. For ongoing non-life-threatening symptoms, please consult a licensed healthcare professional promptly.`,
        recommendation: `Advise prompt medical evaluation with a licensed physician; err toward emergency guidance (${guidance.emergencyNumber}) if acute symptoms develop.`
      };
    }
  }

  return {
    isEmergency: false,
    isAmbiguous: false,
    guidance: null
  };
}
