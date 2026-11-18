import { initUserIndexes } from '../repositories/user.repository.js';
import { initProviderIndexes } from '../repositories/provider.repository.js';
import { initAvailabilityIndexes } from '../repositories/availability.repository.js';
import { initAppointmentIndexes } from '../repositories/appointment.repository.js';
import { initVoiceCallIndexes } from '../repositories/voiceCall.repository.js';
import { initTokenRevocationIndexes } from '../repositories/tokenRevocation.repository.js';
import { initCallbackConsentIndexes } from '../repositories/callbackConsent.repository.js';
import { initCallbackLockIndexes } from '../repositories/callbackLock.repository.js';
import { initConfirmationIndexes } from '../services/confirmation.service.js';
import { initPatientIndexes } from '../repositories/patient.repository.js';
import { initCarePlanIndexes } from '../repositories/carePlan.repository.js';
import { initCareTaskIndexes } from '../repositories/careTask.repository.js';
import { initTaskEventIndexes } from '../repositories/taskEvent.repository.js';
import { initEvidenceIndexes } from '../repositories/evidence.repository.js';
import { initServiceDirectoryIndexes } from '../repositories/serviceDirectory.repository.js';
import { initBarrierIndexes } from '../repositories/barrier.repository.js';
import { initReplanProposalIndexes } from '../repositories/replanProposal.repository.js';
import { initApprovalIndexes } from '../repositories/approval.repository.js';
import { initDocumentSubmissionIndexes } from '../repositories/documentSubmission.repository.js';
import { initAgentRunIndexes } from '../repositories/agentRun.repository.js';
import { initSymptomCheckIndexes } from '../repositories/symptomCheck.repository.js';

/**
 * Creates every collection index the application relies on.
 * Shared by server startup, seed scripts, and the test harness.
 */
export async function initAllIndexes() {
  // Each collection's indexes are independent, so they are created in parallel: on a distant database
  // this takes a couple of seconds instead of one round trip per index
  await Promise.all([
    initUserIndexes(),
    initProviderIndexes(),
    initAvailabilityIndexes(),
    initAppointmentIndexes(),
    initVoiceCallIndexes(),
    initTokenRevocationIndexes(),
    initCallbackConsentIndexes(),
    initCallbackLockIndexes(),
    initConfirmationIndexes(),
    initPatientIndexes(),
    initCarePlanIndexes(),
    initCareTaskIndexes(),
    initTaskEventIndexes(),
    initEvidenceIndexes(),
    initServiceDirectoryIndexes(),
    initBarrierIndexes(),
    initReplanProposalIndexes(),
    initApprovalIndexes(),
    initDocumentSubmissionIndexes(),
    initAgentRunIndexes(),
    initSymptomCheckIndexes()
  ]);
}
