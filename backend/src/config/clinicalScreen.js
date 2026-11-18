/**
 * Flags free text that touches clinical decisions (medicines, doses, treatment changes, conflicting
 * instructions). PlanPilot handles logistics only, so such text is routed to a clinician instead of
 * being acted on. Deliberately broad: a false alarm costs a clinician a minute; a miss could cost more.
 * Runs after the emergency screen (assessEmergencyRisk), which takes priority.
 */
const CLINICAL_TERMS = [
  'medicine', 'medication', 'tablet', 'pill', 'capsule', 'dose', 'dosage', 'insulin', 'aspirin',
  'blood thinner', 'statin', 'prescription', 'prescribed', 'side effect', 'side-effect', 'allergic',
  'stop taking', 'stopped taking', 'start taking', 'skip the', 'change my treatment', 'treatment change',
  'different instruction', 'conflicting', 'contradict', 'says to stop', 'says the opposite',
  'dawai', 'dawa', 'goli', 'दवा', 'दवाई', 'गोली'
];

export function assessClinicalContent(text) {
  const lower = String(text || '').toLowerCase();
  const matched = CLINICAL_TERMS.filter(term => lower.includes(term));
  return { isClinical: matched.length > 0, matched };
}
