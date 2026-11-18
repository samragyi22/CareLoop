/**
 * Hand-written care-plan templates (SYNTHETIC DEMO DATA).
 *
 * A clinician picks a template for a patient; creating the plan is the clinician's approval.
 * `clinicalInstruction` is copied verbatim from the clinician's plan and is never edited by
 * PlanPilot. PlanPilot only coordinates the logistics needed to carry it out.
 *
 * Task fields:
 *   key                  stable identifier within the plan (lowercase, underscores)
 *   type                 one of TASK_TYPES in services/taskStateMachine.js
 *   owner                who is expected to act: patient | clinic_staff | clinician | agent
 *   dueInDays            due date relative to plan creation
 *   dependsOn            keys of tasks that must be completed with evidence first
 *   serviceRequirement   what service the task needs and the facility the plan expects
 *                        (facilityCode refers to the service directory; used by feasibility checks)
 */
export const CARE_PLAN_TEMPLATES = [
  {
    id: 'post-discharge-chest-pain',
    title: 'Post-discharge follow-up after chest pain observation',
    sourceText: [
      'SYNTHETIC DEMO PLAN.',
      'Patient observed overnight for chest pain; acute cardiac event ruled out.',
      'Discharge instructions:',
      '1. Fasting lipid profile blood test within 5 days.',
      '2. Follow-up with General Practice within 7 days to review recovery and the lipid report.',
      '3. Bring the discharge summary to the follow-up visit.',
      '4. Continue current medicines as prescribed; do not change doses without a doctor.',
      'Return to emergency care or call 112 if chest pain recurs.'
    ].join('\n'),
    tasks: [
      {
        key: 'lipid_test',
        type: 'lab_test',
        title: 'Fasting lipid profile blood test',
        clinicalInstruction: 'Fasting lipid profile blood test within 5 days.',
        owner: 'patient',
        dueInDays: 5,
        dependsOn: [],
        serviceRequirement: { category: 'lab', service: 'lipid_profile', facilityCode: 'LAB-DISTRICT' }
      },
      {
        key: 'book_followup',
        type: 'appointment_booking',
        title: 'Book General Practice follow-up',
        clinicalInstruction: 'Follow-up with General Practice within 7 days to review recovery and the lipid report.',
        owner: 'agent',
        dueInDays: 3,
        dependsOn: [],
        serviceRequirement: { category: 'clinic', specialty: 'General Practice', facilityCode: 'CARELOOP-DISTRICT' }
      },
      {
        key: 'discharge_summary',
        type: 'document_submission',
        title: 'Share discharge summary with the clinic',
        clinicalInstruction: 'Bring the discharge summary to the follow-up visit.',
        owner: 'patient',
        dueInDays: 6,
        dependsOn: [],
        serviceRequirement: { category: 'document', document: 'discharge_summary' }
      },
      {
        key: 'followup_visit',
        type: 'follow_up_visit',
        title: 'Attend General Practice follow-up visit',
        clinicalInstruction: 'Follow-up with General Practice within 7 days to review recovery and the lipid report.',
        owner: 'patient',
        dueInDays: 7,
        dependsOn: ['book_followup', 'discharge_summary'],
        serviceRequirement: { category: 'clinic', specialty: 'General Practice', facilityCode: 'CARELOOP-DISTRICT' }
      }
    ]
  },
  {
    id: 'diabetes-quarterly-review',
    title: 'Quarterly diabetes review',
    sourceText: [
      'SYNTHETIC DEMO PLAN.',
      'Type 2 diabetes, stable on current treatment.',
      '1. HbA1c blood test within 10 days.',
      '2. Review with General Practice within 14 days once the HbA1c result is available.',
      'Continue current treatment unchanged until the review.'
    ].join('\n'),
    tasks: [
      {
        key: 'hba1c_test',
        type: 'lab_test',
        title: 'HbA1c blood test',
        clinicalInstruction: 'HbA1c blood test within 10 days.',
        owner: 'patient',
        dueInDays: 10,
        dependsOn: [],
        serviceRequirement: { category: 'lab', service: 'hba1c', facilityCode: 'LAB-DISTRICT' }
      },
      {
        key: 'book_review',
        type: 'appointment_booking',
        title: 'Book General Practice review',
        clinicalInstruction: 'Review with General Practice within 14 days once the HbA1c result is available.',
        owner: 'agent',
        dueInDays: 7,
        dependsOn: [],
        serviceRequirement: { category: 'clinic', specialty: 'General Practice', facilityCode: 'CARELOOP-DISTRICT' }
      },
      {
        key: 'review_visit',
        type: 'follow_up_visit',
        title: 'Attend diabetes review visit',
        clinicalInstruction: 'Review with General Practice within 14 days once the HbA1c result is available.',
        owner: 'patient',
        dueInDays: 14,
        dependsOn: ['book_review', 'hba1c_test'],
        serviceRequirement: { category: 'clinic', specialty: 'General Practice', facilityCode: 'CARELOOP-DISTRICT' }
      }
    ]
  }
];

export function findCarePlanTemplate(templateId) {
  return CARE_PLAN_TEMPLATES.find(t => t.id === templateId) || null;
}
