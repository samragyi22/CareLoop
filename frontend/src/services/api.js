const API_BASE = `${(import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/+$/, '')}/api`;

/**
 * Standard fetch wrapper ensuring credentials (HttpOnly cookies) are included.
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include' // Crucial for HttpOnly session cookie transmission
    });
  } catch (networkError) {
    // The browser only says "Failed to fetch"; say what it means
    const error = new Error('Cannot reach the CareLoop server. Make sure the backend is running (npm run dev in the backend folder), then try again.');
    error.code = 'BACKEND_UNREACHABLE';
    throw error;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.code = data.code;
    error.data = data;
    throw error;
  }

  return data;
}

export const api = {
  // Authentication
  login: (email, password) => request('/auth/login', {
    method: 'POST',
    body: { email, password }
  }),

  logout: () => request('/auth/logout', {
    method: 'POST'
  }),

  getCurrentUser: () => request('/auth/me', {
    method: 'GET'
  }),

  // Providers
  getProviders: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/providers${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  createProvider: (providerData) => request('/providers', {
    method: 'POST',
    body: providerData
  }),

  updateProvider: (id, updates) => request(`/providers/${id}`, {
    method: 'PATCH',
    body: updates
  }),

  // Availability
  getProviderAvailability: (providerId) => request(`/providers/${providerId}/availability`, {
    method: 'GET'
  }),

  createProviderAvailability: (providerId, availabilityData) => request(`/providers/${providerId}/availability`, {
    method: 'POST',
    body: availabilityData
  }),

  deleteAvailability: (id) => request(`/availability/${id}`, {
    method: 'DELETE'
  }),

  // Appointment Slots & Booking Engine
  getAvailableSlots: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/appointments/slots${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  getAppointments: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/appointments${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  getAppointmentDetails: (id) => request(`/appointments/${id}`, {
    method: 'GET'
  }),

  createAppointment: (appointmentData) => request('/appointments', {
    method: 'POST',
    body: appointmentData
  }),

  cancelAppointment: (id, reason = '') => request(`/appointments/${id}/cancel`, {
    method: 'POST',
    body: { reason }
  }),

  rescheduleAppointment: (id, rescheduleData) => request(`/appointments/${id}/reschedule`, {
    method: 'POST',
    body: rescheduleData
  }),

  // Health Diagnostics
  getHealth: () => request('/health', {
    method: 'GET'
  }),

  getDbHealth: () => request('/health/db', {
    method: 'GET'
  }),

  // Voice Telephony & Agent Status
  getVoiceConfig: () => request('/voice/config', {
    method: 'GET'
  }),

  getVoiceCalls: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/voice/calls${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  // Outbound Voice Calls (M5)
  placeOutboundCall: ({ appointmentId, phone, confirmed = true }) => request('/voice/outbound', {
    method: 'POST',
    body: { appointmentId, phone, confirmed }
  }),

  // CareLoop Callback Service (M8.2)
  retryCallbackCall: ({ callbackCallSid }) => request('/voice/callback/retry', {
    method: 'POST',
    body: { callbackCallSid }
  }),

  // PlanPilot: patient registry, care plans, and tasks (clinician)
  getPatientRecords: () => request('/patients', { method: 'GET' }),

  createPatient: ({ name, phone, preferredLanguage, constraints, location }) => request('/patients', {
    method: 'POST',
    body: { name, phone, preferredLanguage, constraints, location }
  }),

  // PlanPilot calls the patient by phone (Twilio + Ultravox); patients never use a web portal
  callPatient: ({ patientId, approvalId = null }) => request('/voice/care-call', {
    method: 'POST',
    body: { patientId, approvalId }
  }),

  getCarePlanMeta: () => request('/care-plans/meta', { method: 'GET' }),

  getCarePlanTemplates: () => request('/care-plans/templates', { method: 'GET' }),

  getCarePlans: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/care-plans${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  getCarePlan: (id) => request(`/care-plans/${id}`, { method: 'GET' }),

  createCarePlan: ({ patientId, templateId }) => request('/care-plans', {
    method: 'POST',
    body: { patientId, templateId }
  }),

  transitionCareTask: (taskId, { to, reason }) => request(`/care-tasks/${taskId}/transition`, {
    method: 'POST',
    body: { to, reason }
  }),

  recordTaskEvidence: (taskId, { type, reference, note }) => request(`/care-tasks/${taskId}/evidence`, {
    method: 'POST',
    body: { type, reference, note }
  }),

  // PlanPilot: feasibility, barriers, and the simulated service directory
  checkTaskFeasibility: (taskId) => request(`/care-tasks/${taskId}/feasibility-check`, { method: 'POST', body: {} }),

  checkPlanFeasibility: (planId) => request(`/care-plans/${planId}/feasibility-check`, { method: 'POST', body: {} }),

  reportTaskBarrier: (taskId, { code, detail }) => request(`/care-tasks/${taskId}/barriers`, {
    method: 'POST',
    body: { code, detail }
  }),

  resolveTaskBarrier: (taskId, barrierId, { resolution }) => request(`/care-tasks/${taskId}/barriers/${barrierId}/resolve`, {
    method: 'POST',
    body: { resolution }
  }),

  updatePatientLogistics: (patientId, { constraints, location }) => request(`/patients/${patientId}/logistics`, {
    method: 'PATCH',
    body: { constraints, location }
  }),

  getServiceDirectory: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/directory${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  // PlanPilot: approvals, documents, and the review queue (clinician)
  chooseTaskAlternative: (taskId, { proposalId, alternativeId, slotStartAt }) => request(`/care-tasks/${taskId}/approvals`, {
    method: 'POST',
    body: { proposalId, alternativeId, slotStartAt }
  }),

  proposePlannedBooking: (taskId, { slotStartAt } = {}) => request(`/care-tasks/${taskId}/planned-booking`, {
    method: 'POST',
    body: { slotStartAt }
  }),

  decideApproval: (approvalId, { decision, note }) => request(`/approvals/${approvalId}/decision`, {
    method: 'POST',
    body: { decision, note }
  }),

  recordPatientResponse: (approvalId, { decision, note }) => request(`/approvals/${approvalId}/patient-response`, {
    method: 'POST',
    body: { decision, note }
  }),

  cancelApproval: (approvalId, { reason }) => request(`/approvals/${approvalId}/cancel`, {
    method: 'POST',
    body: { reason }
  }),

  uploadTaskDocument: (taskId, { fileName, mimeType, contentBase64 }) => request(`/care-tasks/${taskId}/documents`, {
    method: 'POST',
    body: { fileName, mimeType, contentBase64 }
  }),

  reviewDocument: (submissionId, { decision, note }) => request(`/document-submissions/${submissionId}/review`, {
    method: 'POST',
    body: { decision, note }
  }),

  // Opened in a new tab; the session cookie authorises it
  documentFileUrl: (submissionId) => `${API_BASE}/document-submissions/${submissionId}/file`,

  getReviewQueue: () => request('/review-queue', { method: 'GET' }),

  // PlanPilot agent
  runPlanAgent: (planId) => request(`/care-plans/${planId}/agent-run`, { method: 'POST', body: {} }),

  getAgentRuns: (planId) => request(`/care-plans/${planId}/agent-runs`, { method: 'GET' }),

  // Phone health checks (symptom check on a call)
  getHealthChecks: () => request('/health-checks', { method: 'GET' }),

  reviewHealthCheck: (id) => request(`/health-checks/${id}/review`, { method: 'POST', body: {} }),

  startHealthCheckCall: ({ name, phone, preferredLanguage }) => request('/voice/health-check-call', {
    method: 'POST',
    body: { name, phone, preferredLanguage }
  }),

  // Demo Lab (development only)
  getDemoStatus: () => request('/demo/status', { method: 'GET' }),

  armDemoFault: (name, times = 1) => request('/demo/faults', { method: 'POST', body: { name, times } }),

  clearDemoFaults: () => request('/demo/faults/clear', { method: 'POST', body: {} }),

  simulatePatientReply: (approvalId, decision) => request(`/demo/approvals/${approvalId}/reply`, { method: 'POST', body: { decision } }),

  simulateMissedCalls: (patientId, count = 2) => request(`/demo/patients/${patientId}/missed-calls`, { method: 'POST', body: { count } }),

  simulateDocumentUpload: (taskId) => request(`/demo/tasks/${taskId}/upload`, { method: 'POST', body: {} }),

  simulatePatientReport: (taskId, { code, detail }) => request(`/demo/tasks/${taskId}/report`, { method: 'POST', body: { code, detail } }),

  resetDemo: () => request('/demo/reset', { method: 'POST', body: {} })
};


