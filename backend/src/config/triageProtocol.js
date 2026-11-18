/**
 * CareLoop symptom-check protocol for phone health check-ins.
 *
 * This is a fixed, reviewable library: the voice agent may only repeat advice and medicine names
 * that come from here (it never invents medicines, doses, or diagnoses). Thresholds follow NHS
 * guidance (see SOURCES). Medicines are standard over-the-counter options with "follow the dose on
 * the pack"; no prescription medicines and no doses are ever given.
 *
 * IMPORTANT: synthetic demo content. A licensed clinician must review this file before any real use.
 */

export const PROTOCOL_VERSION = '2026-10-20';

export const SOURCES = [
  { topic: 'Cough', url: 'https://www.nhs.uk/symptoms/cough/' },
  { topic: 'Common cold', url: 'https://www.nhs.uk/conditions/common-cold/' },
  { topic: 'Headache', url: 'https://www.nhs.uk/conditions/tension-headaches/' },
  { topic: 'Chest pain', url: 'https://www.nhs.uk/symptoms/chest-pain/' },
  { topic: 'Heart attack symptoms', url: 'https://www.nhs.uk/conditions/heart-attack/symptoms/' },
  { topic: 'Diarrhoea and vomiting', url: 'https://www.chelwest.nhs.uk/your-visit/patient-leaflets/medicine-services/gastroenteritis' },
  { topic: 'Sore throat', url: 'https://www.chelwest.nhs.uk/your-visit/patient-leaflets/medicine-services/sore-throat' }
];

const PARACETAMOL = {
  name: 'Paracetamol',
  how: 'Follow the dose on the pack and never take more than the pack allows in 24 hours. Do not take it if you have liver disease.'
};

/**
 * Symptom categories. selfCareMaxDays: how long it is reasonable to manage at home before a doctor
 * should see it (null = never self-care). keywords match English, Hindi, and Hinglish.
 */
export const SYMPTOM_CATEGORIES = {
  headache: {
    quickTip: 'Rest in a quiet room and drink plenty of water',
    shortSeeDoctor: 'it lasts more than 3 days or gets very bad',
    label: 'Headache',
    keywords: ['headache', 'head ache', 'head pain', 'migraine', 'sir dard', 'sar dard', 'sir mein dard', 'sar mein dard', 'sir me dard', 'सिर दर्द', 'सिरदर्द', 'सिर में', 'सर में दर्द', 'सर दर्द'],
    selfCareMaxDays: 3,
    specialty: 'General Practice',
    selfCare: ['Rest in a quiet, dark room.', 'Drink plenty of water.', 'Take regular breaks from screens and get enough sleep.'],
    medicines: [{ ...PARACETAMOL, use: 'for the headache' }],
    seeDoctorIf: 'the headache lasts more than 3 days, keeps coming back several times a week, or is very severe'
  },
  cold: {
    quickTip: 'Take steam and drink warm fluids',
    shortSeeDoctor: 'it lasts more than 10 days or a fever stays over 3 days',
    label: 'Cold',
    keywords: ['cold', 'runny nose', 'blocked nose', 'stuffy nose', 'sneez', 'zukam', 'jukam', 'zukaam', 'jukaam', 'sardi', 'nazla', 'naak beh', 'जुकाम', 'सर्दी', 'नाक'],
    selfCareMaxDays: 10,
    specialty: 'General Practice',
    selfCare: ['Rest and drink plenty of warm fluids.', 'Breathe in steam from a bowl of hot water, carefully.', 'Antibiotics do not help a cold, so they are not needed.'],
    medicines: [{ ...PARACETAMOL, use: 'for body aches or fever' }, { name: 'Saline nasal drops', use: 'for a blocked nose', how: 'Use as the pack says.' }],
    seeDoctorIf: 'it does not improve after 10 days, a fever lasts more than 3 days, or it gets worse'
  },
  cough: {
    quickTip: 'Have honey in warm water and drink plenty of fluids',
    shortSeeDoctor: 'it lasts more than 3 weeks or breathing gets hard',
    label: 'Cough',
    keywords: ['cough', 'khansi', 'khaansi', 'khasi', 'खांसी', 'खाँसी'],
    selfCareMaxDays: 21,
    specialty: 'General Practice',
    selfCare: ['Rest and drink plenty of fluids.', 'A spoon of honey in warm water or with lemon can soothe the throat (not for babies under 1 year).', 'Avoid smoke and dust.'],
    medicines: [{ name: 'Cough syrup or lozenges', use: 'to ease the cough', how: 'Ask the pharmacist for a simple one and follow the pack.' }],
    seeDoctorIf: 'the cough lasts more than 3 weeks, you cough up blood, or it becomes hard to breathe'
  },
  fever: {
    quickTip: 'Rest and drink plenty of fluids',
    shortSeeDoctor: 'the fever lasts more than 3 days or is very high',
    label: 'Fever',
    keywords: ['fever', 'temperature', 'bukhar', 'bukhaar', 'taap', 'बुखार'],
    selfCareMaxDays: 3,
    specialty: 'General Practice',
    selfCare: ['Rest and drink plenty of fluids.', 'Wear light clothing and keep the room cool.'],
    medicines: [{ ...PARACETAMOL, use: 'to bring the fever down' }],
    seeDoctorIf: 'the fever lasts more than 3 days, is very high, or you feel very unwell'
  },
  sore_throat: {
    quickTip: 'Gargle with warm salt water',
    shortSeeDoctor: 'it lasts more than a week or swallowing gets hard',
    label: 'Sore throat',
    keywords: ['sore throat', 'throat pain', 'throat infection', 'gala kharab', 'gale mein dard', 'gala dard', 'gale me dard', 'गला'],
    selfCareMaxDays: 7,
    specialty: 'General Practice',
    selfCare: ['Gargle with warm salt water (not for young children).', 'Drink plenty of fluids and eat soft foods.'],
    medicines: [{ ...PARACETAMOL, use: 'for the pain' }, { name: 'Throat lozenges', use: 'to soothe the throat', how: 'Follow the pack.' }],
    seeDoctorIf: 'it does not improve after a week, or swallowing or breathing becomes difficult'
  },
  stomach: {
    quickTip: 'Sip fluids often and eat light food',
    shortSeeDoctor: 'vomiting lasts over 2 days, there is blood, or fluids do not stay down',
    label: 'Stomach upset (diarrhoea or vomiting)',
    keywords: ['diarrh', 'loose motion', 'loose stool', 'dast', 'vomit', 'ulti', 'stomach upset', 'upset stomach', 'pet kharab', 'pet kharaab', 'उल्टी', 'दस्त'],
    selfCareMaxDays: 2,
    specialty: 'General Practice',
    selfCare: ['Drink small sips of fluid often.', 'Eat light food when you feel ready.', 'Wash hands well; stay home until 48 hours after the last episode.'],
    medicines: [{ name: 'ORS (oral rehydration salts)', use: 'to replace lost fluids', how: 'Mix exactly as the packet says; use it for 2 to 3 days at most unless a doctor says otherwise.' }],
    seeDoctorIf: 'vomiting lasts more than 2 days, diarrhoea lasts more than 7 days, there is blood, or you cannot keep fluids down'
  },
  stomach_pain: {
    quickTip: 'Eat light food, avoid spicy and oily food, and sip warm water',
    shortSeeDoctor: 'it lasts more than 3 days, gets severe, or there is vomiting or blood',
    label: 'Stomach pain or acidity',
    keywords: ['stomach pain', 'stomach ache', 'tummy ache', 'abdominal pain', 'pet dard', 'pet mein dard', 'pet me dard', 'pait dard', 'pait mein dard', 'acidity', 'gas problem', 'gas ho', 'gas ki', 'indigestion', 'stomach', 'tummy', 'pet mein', 'pet me ', 'pait', 'पेट दर्द', 'पेट में', 'पेट मे', 'बेट में', 'बेट मे', 'बेच में', 'पैट में', 'एसिडिटी', 'गैस'],
    selfCareMaxDays: 3,
    specialty: 'General Practice',
    selfCare: ['Eat small, light meals and avoid spicy or oily food.', 'Sip warm water through the day.', 'Do not lie down straight after eating.'],
    medicines: [{ name: 'An antacid', use: 'for acidity or gas', how: 'Ask the pharmacist and follow the pack.' }],
    seeDoctorIf: 'the pain lasts more than 3 days, becomes severe, or comes with vomiting, fever, or blood'
  },
  body_ache: {
    quickTip: 'Rest and drink plenty of fluids',
    shortSeeDoctor: 'it lasts more than 3 days',
    label: 'Body ache',
    keywords: ['body ache', 'body pain', 'badan dard', 'sharir mein dard', 'बदन दर्द'],
    selfCareMaxDays: 3,
    specialty: 'General Practice',
    selfCare: ['Rest and drink plenty of fluids.'],
    medicines: [{ ...PARACETAMOL, use: 'for the aches' }],
    seeDoctorIf: 'it lasts more than 3 days or comes with a high fever'
  },
  joint_pain: {
    quickTip: 'Rest it and use a warm or cold pack',
    shortSeeDoctor: 'it lasts more than a week or followed an injury',
    label: 'Joint or back pain',
    keywords: ['back pain', 'joint pain', 'knee pain', 'kamar dard', 'ghutne', 'ghutna', 'haddi', 'sprain', 'कमर दर्द', 'घुटने'],
    selfCareMaxDays: 7,
    specialty: 'Orthopedics',
    selfCare: ['Keep gently moving; rest it if it is very painful.', 'A warm or cold pack may help.'],
    medicines: [{ ...PARACETAMOL, use: 'for the pain' }],
    seeDoctorIf: 'it lasts more than a week, is getting worse, or followed a fall or injury'
  },
  chest: {
    label: 'Chest pain or heart symptoms',
    keywords: ['chest', 'heart', 'seene', 'seena', 'chhati', 'dil', 'सीने', 'छाती', 'दिल'],
    selfCareMaxDays: null,
    specialty: 'Cardiology'
  },
  breathing: {
    label: 'Breathing difficulty',
    keywords: ['breath', 'breathless', 'oxygen', 'saans', 'sans phool', 'saas', 'सांस', 'साँस'],
    selfCareMaxDays: null,
    specialty: 'General Practice'
  }
};

/**
 * Danger signs. acuteIfNow: life-threatening when happening right now (the only cases where the
 * assistant says 112). Every other danger sign, or one not happening now, means an urgent
 * appointment with a CareLoop doctor.
 */
export const RED_FLAGS = {
  chest_pain: { label: 'Chest pain or tightness', acuteIfNow: true, keywords: ['chest pain', 'chest tight', 'seene mein dard', 'seene me dard', 'chhati mein dard', 'सीने में दर्द'] },
  breathing_difficulty: { label: 'Difficulty breathing', acuteIfNow: true, keywords: ["can't breathe", 'cannot breathe', 'not able to breathe', 'breathing difficulty', 'difficulty breathing', 'short of breath', 'shortness of breath', 'oxygen', 'saans nahi', 'saans lene mein', 'सांस नहीं', 'साँस नहीं'] },
  fainting: { label: 'Fainting or collapse', acuteIfNow: true, keywords: ['faint', 'collapse', 'unconscious', 'behosh', 'बेहोश'] },
  stroke_signs: { label: 'Face drooping, slurred speech, or weakness on one side', acuteIfNow: true, keywords: ['slurred', 'face droop', 'one side', 'paralys', 'lakwa', 'लकवा'] },
  seizure: { label: 'Seizure', acuteIfNow: true, keywords: ['seizure', 'fit ', 'convulsion', 'mirgi', 'दौरा'] },
  severe_bleeding: { label: 'Heavy bleeding', acuteIfNow: true, keywords: ['heavy bleeding', 'bleeding heavily', 'bahut khoon', 'खून बह'] },
  confusion: { label: 'Confusion or drowsiness', acuteIfNow: true, keywords: ['confus', 'not making sense', 'very drowsy'] },
  sudden_severe_headache: { label: 'Sudden, extremely severe headache', acuteIfNow: true, keywords: ['worst headache', 'sudden severe headache', 'thunderclap'] },
  stiff_neck_with_fever: { label: 'Stiff neck with fever', acuteIfNow: true, keywords: ['stiff neck'] },
  coughing_or_vomiting_blood: { label: 'Coughing or vomiting blood', acuteIfNow: true, keywords: ['cough blood', 'coughing blood', 'coughing up blood', 'vomiting blood', 'khoon ki ulti', 'khaansi mein khoon'] },
  very_high_fever: { label: 'Very high fever', keywords: ['very high fever', 'high fever', 'tez bukhar', 'tez bukhaar', 'तेज बुखार'] },
  unable_to_keep_fluids: { label: 'Cannot keep fluids down', keywords: ["can't keep", 'cannot keep', 'kuch nahi tik'] },
  blood_in_stool: { label: 'Blood in stool', keywords: ['blood in stool', 'blood in potty', 'potty mein khoon'] },
  severe_pain: { label: 'Severe pain', keywords: ['unbearable', 'severe pain', 'bahut tez dard', 'असहनीय'] }
};

// People for whom PlanPilot never suggests medicines by phone and always involves a doctor
export const LONG_TERM_CONDITION_KEYWORDS = ['heart', 'cardiac', 'diabet', 'sugar', 'kidney', 'liver', 'asthma', 'copd', 'cancer', 'transplant', 'bp', 'blood pressure', 'pregnan', 'दिल', 'शुगर'];

export const GENERAL_SAFETY_NET = 'This is general advice, not a prescription. If you get worse, or notice chest pain, difficulty breathing, fainting or confusion, dial 112 straight away.';

// One-line safety net spoken at the end of self-care advice
export const SHORT_SAFETY_NET = 'If it gets worse, call CareLoop and we will book a doctor for you.';
