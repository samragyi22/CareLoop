# Nirogya — Project Context & JAI 2026 Planning Brief

> **Purpose of this file:** Give a fresh ChatGPT conversation a reliable, structured understanding of the Nirogya healthcare ecosystem, the ideas evaluated for JAI 2026, the proposed differentiator, the intended product scope, the candidate technology stack, safety boundaries, and the decisions still to be made.
>
> **Source and confidence note:** This document summarizes the supplied planning conversation. It is a record of ideas and recommendations discussed there, not proof that the features have already been implemented or that the idea is novel. The conversation primarily describes ideation and intended product behaviour. The cloned repository has not been inspected as part of this summary, so code-level implementation status must be verified separately.

---

## 1. Executive summary

Nirogya is envisioned as an AI-powered, multilingual healthcare ecosystem for rural and semi-urban India. Its broad ambition is to connect patients and families, doctors and healthcare professionals, hospitals and administrators, pharmacies, laboratories, and other healthcare services through accessible interfaces such as phone calls, web/mobile applications, document uploads, and dashboards.

The initial vision contains many possible capabilities: multilingual voice access, teleconsultation, medicine/prescription scanning, consultation preparation, wearable-data insights, reminders, follow-up workflows, doctor and hospital dashboards, pharmacy/service discovery, emergency assistance, and digital health records.

For JAI 2026, the planning discussion recommends **not attempting to build the entire ecosystem**. A broad healthcare assistant with many features risks looking like a collection of standard AI integrations rather than a distinctive agentic system. The proposed strategy is to preserve the long-term Nirogya vision but select one narrow, demonstrable workflow as the hackathon's central innovation.

The strongest recommendation in the conversation is:

## **Nirogya PlanPilot — make clinician-approved care plans executable**

PlanPilot would take a clinician-approved care plan, break it into tasks and dependencies, check whether the logistical steps are feasible for a particular patient, identify practical barriers, propose permissible alternatives without changing clinical instructions, request human approval when needed, and verify whether tasks were actually completed.

The distinguishing mechanism is **constraint-aware, failure-aware care coordination with evidence-based task closure and human oversight**. The key demo is not simply a chatbot responding to a patient. It is an agent discovering that a care-plan step cannot be completed, proposing a safe logistical alternative, obtaining required approval, tracking the result, and refusing to mark the task complete without evidence.

A supporting capability called **Nirogya HealthPassport** could maintain a trustworthy, source-linked timeline of patient information and documents. It should distinguish patient-reported information, extracted information, clinician-confirmed facts, uncertain data, and conflicting records. This may help PlanPilot use context without turning HealthPassport into a separate, oversized product.

**Current planning recommendation:** Investigate and prototype PlanPilot first. Validate the exact workflow against existing patient-navigation, care-planning, and healthcare workflow products before making any novelty claims. Use synthetic patient data, a simulated service directory, and controlled failure scenarios for the initial demo.

---

## 2. JAI 2026 context and track options

The conversation lists these broad challenge tracks:

1. **Agentic AI for Cybersecurity** — detect, analyse, investigate, and respond to security threats.
2. **Agentic AI for Healthcare** — healthcare decision support, information management, patient interaction, or workflow automation.
3. **Agentic AI for Natural Language Processing (NLP)** — complex language understanding, extraction, reasoning, generation, or multilingual NLP.
4. **Agentic AI for Open Innovation** — an open-ended real-world problem using autonomous reasoning, tools, data, APIs, and/or multi-agent collaboration.

The user ultimately expressed a preference for healthcare and wanted a genuinely strong idea rather than choosing a project merely because it sounded impressive.

### Selection criteria used in the discussion

A competitive idea should have:

- A specific real-world problem that judges can understand quickly.
- A distinctive technical mechanism beyond connecting an LLM to APIs.
- A compelling live demo in which the system encounters a failure and handles it.
- A realistic scope that the team can build and validate.
- Measurable results rather than unsupported claims.
- Clear safety boundaries and an appropriate human role.

No idea was described as guaranteed to win. The planning conversation explicitly recommends checking the final idea against existing products and research.

---

## 3. Ideas considered during planning

The conversation considered several directions. These are alternatives and design history, not simultaneous commitments to build all of them.

### 3.1 ResultLoop — close the loop on diagnostic tests

**Problem:** A diagnostic test can be ordered but not completed; a test may be completed but the report may never reach the clinician; or a report may arrive without documented clinical review and a next step.

**Proposed workflow:**

1. Record a test order, due date, and responsible clinician.
2. Track whether the test was completed.
3. Track whether the report was received.
4. Detect a missing or delayed step.
5. Contact the patient, request missing information, or escalate to staff.
6. Verify closure using evidence of completion, documented clinician review, and an assigned next step when appropriate.

**Suggested demo:** A patient misses a test because the lab is too far away. The agent discovers the barrier and offers an approved alternative from a simulated lab directory. The test is then completed, but the report does not arrive. The agent detects the second failure, requests the report, and later creates a clinician-review task when review remains pending.

**Strengths:** Narrow responsibility, visible workflow state, recoverable failures, measurable completion, and a strong safety boundary.

**Boundary:** The agent coordinates the workflow. It must not diagnose the patient or independently make treatment decisions based on a test result.

**Status in the discussion:** A serious candidate, later compared with broader Nirogya directions. It was not selected as the final direction.

### 3.2 CarePlan Reality Check

**Problem:** A medically appropriate plan may be practically impossible for a patient to follow because of transport, appointment timing, access to supplies, language, or caregiver constraints.

**Proposed mechanism:** Constraint-aware planning. The agent checks the practical feasibility of the plan, identifies barriers, consults a verified or simulated service directory, and proposes logistical alternatives. It does not independently alter medical instructions.

**Example:** A patient is asked to attend a clinic 40 km away but has no transport. The agent identifies the constraint and presents an approved alternative for the care team to review.

**Strength:** Demonstrates that the agent reasons about real-world constraints rather than only generating medical text.

**Relationship to PlanPilot:** This is a close precursor to the final PlanPilot recommendation. PlanPilot formalizes the idea as a care-plan execution workflow with explicit tasks, dependencies, deadlines, ownership, approval, and evidence of completion.

### 3.3 MedConflict — cross-document contradiction detection

**Problem:** A discharge summary, older medication list, newer prescription, or medicine label may contain inconsistent information.

**Proposed mechanism:** Compare documents, detect conflicts, link each claim to its source, track uncertainty, and prepare a clarification request for a clinician or pharmacist.

**Demo:** Upload synthetic documents with planted inconsistencies and check whether the agent detects them with supporting source passages.

**Boundary:** The agent must not decide which conflicting medication instruction is correct. A qualified professional must review the conflict.

**Potential evaluation:** Missed contradictions, false-positive flags, evidence quality, and appropriate escalation.

### 3.4 Referral Rescue

**Problem:** A referral may become stuck because an appointment is unavailable, documentation is missing, authorization is pending, or the patient cannot reach the service.

**Proposed mechanism:** Track referral stages and choose recovery actions based on the specific blockage, such as finding an approved provider, requesting a missing document, or routing an authorization issue to staff.

**Demo:** A referral cannot proceed because a required document is missing. The agent identifies the missing item, obtains it from a simulated patient, and submits or stages the next step for the appropriate approval.

**Relationship to ResultLoop:** Similar failure-aware coordination, but centred on specialist referrals rather than diagnostic tests.

### 3.5 HandoffGuard

**Problem:** Tasks can lose ownership or status during shift changes or transfers between departments. Handoff notes may omit unresolved commitments or contain conflicting status information.

**Proposed mechanism:** Maintain a ledger of commitments: task, owner, deadline, status, and evidence of completion. Compare outgoing and incoming handoff records, flag omissions and contradictions, and ask staff to confirm ownership.

**Demo:** Supply two shift summaries with one omitted task and one contradictory status. The system identifies both and generates a review queue.

**Open question:** The final concept would need to demonstrate a clear difference from existing clinical handoff and summarization systems.

### 3.6 AccessAppeal

**Problem:** Patients may not understand a denial of a healthcare claim or authorization, the evidence required, or the available appeal process.

**Proposed mechanism:** Read a fictional denial letter and relevant policy, identify the stated reason, check a document packet for missing evidence, prepare a draft appeal or clarification request, and track deadlines and status.

**Boundary:** Never invent evidence, guarantee coverage, or submit a consequential appeal without the patient's approval.

### 3.7 CareSignal

**Problem:** Patient updates arrive through informal calls or messages, while the care team may not have a structured record of what changed.

**Proposed mechanism:** Convert updates into a timeline, compare them with the previously documented plan, ask focused clarification questions, and route relevant changes to the right professional.

**Risk:** Broad patient-message triage is a crowded category, so the exact differentiator would need to be defined.

### 3.8 Nirogya HealthPassport

**Purpose:** Build a trustworthy memory of a patient's care rather than just a document summarizer.

**Possible inputs:** Prescriptions, laboratory reports, discharge summaries, consultation notes, and voice notes.

**Proposed behaviour:**

- Build a chronological timeline.
- Keep facts linked to their original documents or passages.
- Distinguish verified, patient-reported, extracted, uncertain, and conflicting information.
- Identify unanswered questions for the next consultation.
- Flag contradictions for professional review rather than silently selecting one version.

**Recommended role:** A supporting capability for PlanPilot, not necessarily a separate hackathon product.

### 3.9 Nirogya AccessAgent

**Problem:** A patient cannot access care through the normal route.

**Proposed mechanism:** Understand the barrier through chat or voice, check a verified directory, offer permissible alternatives, coordinate the next step, and preserve state through multiple failures.

**Demo:** The first clinic is inaccessible, a second option requires missing documents, and the final alternative requires human approval.

**Trade-off:** Strong workflow-agent potential, but its broad access problem may be harder to scope than PlanPilot.

### 3.10 BhashaBench — an alternative NLP-track idea

This was considered before the decision to focus on healthcare.

**Problem:** Regional speech, code-switching, noisy recordings, and dialect-specific expressions make multilingual datasets difficult to label reliably.

**Proposed mechanism:** An agent turns raw multilingual audio into a quality-checked dataset and benchmark. It transcribes audio, flags uncertain terms, resolves model disagreements through another model or human review, checks duplicates and inconsistent labels, preserves provenance, and benchmarks model performance.

**Potential metrics:** Transcription error, unresolved ambiguity, reviewer effort, label quality, and measured model performance.

**Risk:** Requires suitable audio data and credible evaluation. This idea is not the selected healthcare direction.

### 3.11 CivicTrace and other general healthcare assistants

CivicTrace was moved down the shortlist because civic complaint grouping and resolution workflows appeared to have existing overlap. The conversation also advised against making a generic healthcare assistant the main differentiator. Appointment booking, symptom triage, medication reminders, broad care coordination, and a large collection of AI features can be useful, but do not automatically create a distinctive agentic mechanism.

---

## 4. Nirogya's original overall vision

Nirogya is intended to be a multilingual healthcare ecosystem for rural and semi-urban India. It aims to help people who may have limited internet connectivity, use basic phones, struggle with medical terminology, or need support coordinating care.

The original vision has four major user groups.

### 4.1 Patients and families

Potential capabilities include:

- Accessing healthcare through phone, web, or mobile interfaces.
- Describing concerns and preparing for consultations.
- Booking or requesting appointments.
- Understanding information on prescriptions and medicine packaging.
- Uploading reports and viewing available health records.
- Receiving clinician-approved follow-up reminders.
- Finding healthcare services and participating pharmacies.
- Receiving accessible information in supported languages.

### 4.2 Doctors and healthcare professionals

Potential capabilities include:

- Reviewing patient information and available records.
- Viewing structured summaries of consultations and patient updates.
- Managing appointments and follow-up schedules.
- Reviewing alerts and pending tasks.
- Preparing and approving prescriptions.
- Reviewing extracted information and AI-generated suggestions.
- Tracking whether assigned follow-up actions have been completed.

The system must distinguish AI-generated suggestions from decisions approved by qualified professionals.

### 4.3 Hospitals and administrators

Potential capabilities include:

- Hospital overview and operational KPIs.
- Doctor, department, shift, and availability management.
- Appointment search, filtering, status updates, and cancellation.
- Appointment trends and utilization reports.
- Digital receipts and receipt history.
- Itemized services, taxes, discounts, payment status, and PDF generation.
- Payment tracking, including pending payments and refunds.
- Exportable operational and financial summaries.

These are part of the long-term ecosystem vision, not required components of the first PlanPilot prototype.

### 4.4 Pharmacies and service providers

Potential capabilities include:

- Finding pharmacies, clinics, laboratories, and hospitals.
- Searching for medicines or healthcare services.
- Viewing locations and contact information.
- Calling providers or opening navigation.
- Checking stock where a participating pharmacy supplies current inventory information.
- Helping patients identify when a requested item or service is unavailable.

**Data-integrity requirement:** Inventory must only be described as live if a real integration confirms current stock. Sample or stale data must be labelled accordingly.

---

## 5. Original Nirogya feature catalogue

The following catalogue records the breadth of the original concept. It should not be interpreted as a requirement to implement all features in the hackathon prototype.

### 5.1 Voice-based AI healthcare assistant

Potential capabilities:

- Phone-based interaction using a provider such as Twilio Voice.
- Spoken conversations in supported Indian languages.
- Collection of symptoms and relevant background information.
- Structured summaries for healthcare professionals.
- Appointment requests and scheduling.
- Follow-up and medicine-reminder calls.
- Questions about available healthcare services.

Example flow: A patient calls in Hindi and reports a fever lasting two days. The agent asks relevant follow-up questions, records the answers, prepares a structured summary, and helps arrange an appropriate consultation.

**Safety:** It should not independently diagnose or prescribe treatment. Potential emergency warning signs should trigger an appropriate emergency or clinical escalation workflow.

### 5.2 Multilingual teleconsultation

Potential capabilities:

- Video consultation using WebRTC.
- Audio and text communication.
- Speech transcription and captions.
- Translation between supported languages.
- Doctor-side consultation notes.
- Digital prescription preparation.
- AI assistance during consultations.

Example: A patient speaks Hindi while a doctor prefers English. The system transcribes and translates the conversation, with a way to correct important translation errors.

**Safety:** Medical translation errors can affect symptoms, allergies, and dosage instructions. High-impact translated content needs appropriate verification and correction mechanisms.

### 5.3 Medi-Scan — AI medicine and prescription scanner

Potential capabilities:

- Accept a photograph of a medicine package or prescription.
- Extract readable medicine name and strength.
- Extract instructions that are explicitly present.
- Identify timing only when specified in the source.
- Extract visible expiry or best-before information.
- Present warnings grounded in a trusted source.
- Translate text and read it aloud.

**Safety:** A photograph alone cannot establish whether a medicine is appropriate for a patient. Unreadable or ambiguous information must be flagged. The system must not invent dosage instructions or resolve conflicting prescriptions without professional review.

### 5.4 Triage and consultation preparation

Potential capabilities:

- Ask relevant follow-up questions.
- Record symptom duration and severity as reported.
- Identify emergency warning signs using a carefully designed protocol.
- Prepare a structured clinician-facing summary.
- Route the request to an appropriate service.

**Boundary:** This is intended as clinical decision support and routing, not autonomous diagnosis.

### 5.5 Wearable-data insights

Potential capabilities, subject to authorized integrations:

- Import available heart-rate, activity, and sleep measurements.
- Display trends over time.
- Compare measurements with the user's recorded baseline.
- Identify data-quality problems or unusual patterns for review.
- Include relevant observations in a clinician-facing summary.

The system should not infer causation from a correlation. For example, less sleep and a higher resting heart rate do not prove that sleep loss caused a patient's symptoms.

### 5.6 Follow-up and medicine reminders

Potential capabilities:

- Schedule calls according to a clinician-approved plan.
- Ask predefined questions about reported progress.
- Record answers and missed contacts.
- Track reminder acknowledgments.
- Escalate predefined concerning responses.
- Summarize interactions for the care team.

Example: A doctor schedules weekly calls for a patient with hypertension. The system records responses and alerts the care team when a response meets a predefined escalation rule. It does not automatically change medication.

### 5.7 Doctor dashboard

Potential modules:

- Patient profiles and available health records.
- Consultation history and structured notes.
- Appointment calendar.
- AI-generated summaries with source links.
- Follow-up schedules and response history.
- Pending review tasks.
- Alerts requiring attention.
- Prescription preparation and approval.
- Patient communication history.

### 5.8 Hospital administration dashboard

Potential modules:

- Hospital overview and operational metrics.
- Doctor availability, shifts, and department management.
- Appointment management.
- Utilization and trend analytics.
- Digital receipt generation and history.
- Payment and refund tracking.
- Operational and financial reporting.

### 5.9 Pharmacy and healthcare-service finder

Potential capabilities:

- Search medicines and healthcare services.
- Display participating provider locations and contact information.
- Show stock only where current data is available.
- Call a pharmacy or open navigation.
- Identify unavailable items and suggest contacting a pharmacist about suitable options.

### 5.10 Emergency support

Potential capabilities:

- Emergency contact shortcuts.
- Location-sharing options with consent.
- Routing to human assistance.

Emergency workflows must not be delayed by a lengthy AI conversation. Contact numbers and service availability must be verified for the deployment region.

### 5.11 Digital health records and patient history

Potential record types:

- Consultation summaries.
- Clinician-approved prescriptions.
- Uploaded laboratory reports.
- Follow-up call records.
- Appointments and referrals.
- Patient-reported symptoms.
- Relevant wearable measurements.

Required safeguards include access controls, consent management, audit history, and clear provenance distinguishing patient statements, extracted data, and clinician-confirmed information.

---

## 6. Recommended central product: Nirogya PlanPilot

### 6.1 Product definition

**Nirogya PlanPilot is a care-plan execution agent that checks whether a clinician-approved care plan is practically achievable for an individual patient, identifies logistical barriers, coordinates permissible next steps, and verifies completion without independently changing medical instructions.**

The system does not replace the clinician's plan. It helps ensure that the operational steps required to carry it out are feasible and followed through.

### 6.2 The problem it addresses

A care plan may be medically appropriate but practically impossible for a particular patient. For example:

- The patient cannot travel to the specified clinic.
- The required service is unavailable at the expected time.
- The patient lacks a required document.
- A follow-up appointment has not been arranged.
- The patient does not understand a logistical instruction.
- A responsible person or task owner has not been assigned.
- A step has been proposed but has not actually been completed.

A conventional reminder may tell a patient to perform a task without discovering why the task cannot be performed. PlanPilot is intended to identify the barrier, choose a permitted recovery path, and preserve the task's state until completion is supported by evidence or the case is escalated.

### 6.3 Proposed end-to-end workflow

1. **Read the approved plan.** Accept a synthetic discharge plan or clinician-approved instruction.
2. **Structure the plan.** Convert it into explicit tasks, dependencies, deadlines, and responsible parties.
3. **Check feasibility.** Ask about relevant logistical constraints and consult a verified or simulated service directory.
4. **Identify the blocker.** Determine which required step cannot proceed and why, based on available evidence.
5. **Replan logistics.** Offer an alternative that respects the original clinical instructions.
6. **Obtain approval.** Route changes requiring clinical judgment or other designated authorization to a human.
7. **Execute permitted actions.** For the prototype, this may mean creating a task, asking the patient for missing information, or interacting with a simulated service.
8. **Verify the outcome.** Require evidence before marking a task complete.
9. **Escalate unresolved cases.** Preserve the reason for failure and assign the issue to an appropriate human.
10. **Maintain an audit trail.** Record the original task, discovered barrier, evidence, proposed action, approval, execution result, and final status.

### 6.4 The key differentiator

The central mechanism is not a voice interface, chatbot, or number of agents. It is:

- Constraint-aware planning.
- Failure detection and recovery.
- Explicit task dependencies and ownership.
- Human approval for consequential decisions.
- Evidence-based task closure.
- Persistent state across multiple failed attempts.
- Clear distinction between a proposed action, an attempted action, and a verified outcome.

### 6.5 Suggested demo scenario

Use synthetic data and a simulated healthcare-service directory.

1. A clinician-approved care plan includes a follow-up visit.
2. The patient cannot reach the originally specified clinic.
3. PlanPilot asks a focused question and records the transport barrier.
4. It checks a simulated directory and finds a permissible alternative.
5. The system presents the option and requests the required approval or patient confirmation.
6. The patient accepts the alternative.
7. The appointment is requested or booked in the simulation.
8. The system records the result but does not claim the visit occurred merely because the appointment was booked.
9. A subsequent status indicates that a required document is missing.
10. PlanPilot identifies the blocker, requests the missing information, and updates the task state.
11. If a clinical decision is required, it creates a human-review task instead of deciding autonomously.
12. The final dashboard shows completed tasks with evidence, pending tasks, blockers, and escalations.

The demo should deliberately include at least one failure. Its purpose is to prove that the system can recover without losing context or falsely claiming completion.

### 6.6 Minimum viable prototype

A realistic first version can contain:

- A patient interface for viewing the plan, reporting barriers, and confirming actions.
- A clinician-facing dashboard for reviewing tasks and approving designated actions.
- A task engine that persists task states, deadlines, ownership, and dependencies.
- An agent orchestrator that selects among a limited set of permitted actions.
- A small synthetic care-plan dataset.
- A simulated directory of clinics or services.
- A basic document extraction capability if it directly supports the chosen demo.
- An evidence and audit log.
- A controlled failure-injection test suite.

The original conversation suggested React, Node.js/Express, MongoDB, and an LLM with tool calling as a sufficient starting stack. This is a candidate architecture, not a verified or mandatory implementation.

---

## 7. Proposed supporting capability: Nirogya HealthPassport

HealthPassport can provide trustworthy context for PlanPilot without making the initial prototype too broad.

### Purpose

Create a chronological, source-linked view of patient information and relevant care documents.

### Possible functionality

- Upload synthetic prescriptions, reports, discharge summaries, and consultation notes.
- Extract relevant facts and dates.
- Link extracted facts to their original document or passage.
- Distinguish patient-reported, extracted, clinician-confirmed, uncertain, and conflicting information.
- Flag contradictory statements for human review.
- Prepare unanswered questions for a clinician.
- Make relevant verified information available to PlanPilot.

### Example

Three synthetic documents contain conflicting dates or instructions. HealthPassport does not silently decide which one is correct. It shows the conflict, identifies the supporting passages, records the uncertainty, and creates a review task.

### Scope recommendation

For the first demo, HealthPassport should be limited to information needed by PlanPilot. Avoid building a full electronic health record platform unless the hackathon requirements specifically justify it.

---

## 8. Proposed system architecture

The conversation does not establish a final architecture. The following is a conceptual architecture derived from the recommended PlanPilot workflow and the candidate stack discussed.

```text
Patient Interface / Clinician Dashboard
                  |
                  v
          Backend API Layer
                  |
          +-------+--------+
          |                |
          v                v
    Task/State Engine   Document/Context Service
          |                |
          v                v
    Persistent Store   Source-linked Evidence
          |                |
          +-------+--------+
                  |
                  v
          Agent Orchestrator
                  |
       +----------+-----------+
       |          |           |
       v          v           v
 Feasibility   Simulated    Escalation /
    Checks     Directory    Approval Rules
       |          |           |
       +----------+-----------+
                  |
                  v
          Permitted Actions
                  |
                  v
       Evidence and Audit Log
                  |
                  v
       Task Status / Review Queue
```

### Architectural responsibilities

- **Frontend:** Display patient tasks, reported barriers, proposed alternatives, task status, and clinician review items.
- **Backend API:** Validate requests and provide controlled access to tasks, records, and actions.
- **Task/state engine:** Persist the current state, deadlines, dependencies, and ownership. The system must not rely solely on conversation history to remember work.
- **Agent orchestrator:** Decide which permitted tool or workflow action is appropriate based on current state and evidence.
- **Directory service:** Provide approved options from a verified source or clearly labelled simulation.
- **Evidence service:** Preserve the source and result supporting a claim or status change.
- **Approval/escalation service:** Ensure decisions requiring a clinician or designated human are not taken autonomously.
- **Audit log:** Record material transitions, actions, approvals, and outcomes.

This diagram is a proposal, not evidence that these components already exist in the cloned repository.

---

## 9. Candidate technology stack

The original Nirogya specification listed the following technologies.

| Area | Candidate technologies mentioned | Notes |
|---|---|---|
| Web application | Next.js, React, Tailwind CSS | Select the framework that best fits the existing codebase. |
| Mobile packaging | Capacitor | Optional; not required for a web-based prototype. |
| Backend | Node.js, Express | Candidate API and workflow layer. |
| Database | MongoDB | Candidate persistent store for tasks, users, and application data. |
| Phone calls | Twilio Voice | Optional for voice-based patient access. |
| Real-time voice AI | Ultravox | Optional; verify current availability and integration needs. |
| Language and vision models | Gemini, Google Cloud Translation | Candidate services for language and document processing. |
| Video calls | WebRTC, Socket.IO | Optional teleconsultation capability. |
| Speech processing | Web Speech API and other speech services | Must be evaluated for required languages and quality. |
| AI orchestration | LangGraph | Candidate for explicit agent workflows and state transitions. |
| Hosting | Vercel, Render, Cloudflare | Deployment options; select based on actual architecture and requirements. |

### Stack guidance

Do not integrate every technology just because it appears in the original vision. For a competitive prototype:

1. Inspect the existing cloned repository first.
2. Preserve working technologies where sensible.
3. Choose the smallest stack that can demonstrate the core workflow.
4. Add voice, video, wearable data, and real integrations only when they strengthen the central demo.
5. Keep simulated integrations clearly labelled as simulated.
6. Record secrets in environment variables, not in source control.

The conversation did not provide verified package versions, environment-variable names, API contracts, database schemas, or deployment settings. These must be discovered from the actual repository and configuration files.

---

## 10. Safety, trust, and healthcare boundaries

Safety is a foundational requirement, not an optional feature.

### 10.1 Clinical decisions remain with qualified professionals

PlanPilot may coordinate logistics and workflow tasks. It must not independently:

- Diagnose a patient.
- Prescribe or change medication.
- Alter a clinician-approved treatment plan.
- Resolve conflicting medication instructions.
- Interpret a test result as an autonomous treatment decision.
- Treat an unverified alternative as clinically equivalent.

If a workflow step requires clinical judgment, the system should stop that decision path and escalate to a qualified professional.

### 10.2 Evidence before completion

A task must not become complete merely because:

- The LLM said it was completed.
- The agent proposed an action.
- A request was sent.
- An appointment was requested but not confirmed.
- A document was expected but not received.
- A patient was contacted but did not respond.

The exact completion evidence should be defined for each task type. A booked appointment, completed visit, received report, and clinician-reviewed report are different states.

### 10.3 Provenance and uncertainty

For important facts, preserve:

- The original source.
- The extracted or reported content.
- The time it was recorded.
- Whether it was confirmed.
- Any uncertainty or conflict.
- The human who approved a consequential decision, where applicable.

### 10.4 Privacy and consent

Use synthetic patient data for the initial hackathon prototype. Any future real-data deployment would require appropriate access control, consent and privacy handling, secure storage, auditability, and compliance review.

### 10.5 Emergency handling

An AI workflow must not delay urgent care. Emergency contacts and available services must be verified for the relevant deployment region, and escalation paths should be explicit.

### 10.6 Honest UI and status reporting

The UI should distinguish:

- Suggested.
- Awaiting patient confirmation.
- Awaiting human approval.
- Requested.
- Confirmed.
- In progress.
- Blocked.
- Escalated.
- Completed with evidence.
- Unable to verify.

Do not label simulated outcomes as real-world completed actions.

---

## 11. Evaluation plan and measurable outcomes

The conversation recommends evaluating the mechanism rather than relying on a polished interface. The following are proposed metrics; **no results are established by the source conversation**.

### Core metrics

1. **Blocker detection accuracy:** How often does the agent correctly identify deliberately planted logistical blockers?
2. **Recovery success rate:** How often does it find and execute a permitted recovery path in simulated cases?
3. **False completion rate:** How often does it mark a task complete without the required evidence?
4. **Escalation correctness:** Does it route clinical or otherwise consequential decisions to the required human?
5. **Evidence completeness:** Does each important status transition have the required supporting evidence?
6. **Task-state consistency:** Does the system preserve ownership, dependencies, deadlines, and state across multiple failures?
7. **Unnecessary escalation rate:** How often does it escalate cases that could safely be resolved through a permitted logistical action?
8. **Recovery time or number of steps:** How efficiently does it recover from a blocked workflow?
9. **Human review burden:** How many cases require human intervention, and how much work does the agent save or create?

### Suggested controlled test suite

Create synthetic cases covering:

- A fully feasible plan.
- A patient with a transport barrier.
- An unavailable service.
- A missing document.
- An unconfirmed appointment.
- A failed patient contact.
- A conflicting source document.
- A request that requires clinician approval.
- A tool failure or unavailable directory.
- A task that appears complete but lacks sufficient evidence.

Measure each case against expected outcomes. Report the actual results honestly; do not invent benchmark numbers for the presentation.

---

## 12. Hackathon scope and prioritization

### Priority 0 — inspect and define

- Review the official JAI 2026 requirements and judging criteria.
- Confirm whether the healthcare track has additional constraints.
- Define the exact PlanPilot workflow.
- Establish what the demo must prove.
- Inspect the cloned repository before deciding whether to preserve or replace existing components.

### Priority 1 — core end-to-end workflow

- Create a synthetic patient and clinician-approved plan.
- Convert the plan into structured tasks and dependencies.
- Persist state and ownership.
- Add a simulated directory.
- Detect one or more controlled logistical failures.
- Propose a permitted alternative.
- Add human approval where needed.
- Verify completion from explicit evidence.
- Show a complete audit trail.

### Priority 2 — make the agent reliable

- Add structured tool inputs and outputs.
- Validate tool arguments on the backend.
- Add explicit workflow states and transition rules.
- Handle tool failures, missing data, timeouts, and ambiguous answers.
- Prevent the LLM from bypassing approval or evidence requirements.
- Build a small repeatable evaluation suite.

### Priority 3 — support the central mechanism

- Add limited HealthPassport document extraction if needed.
- Link important facts to source passages.
- Add a focused clinician review queue.
- Improve the patient interface and demo observability.

### Priority 4 — optional extensions

Only if the core workflow is reliable and time permits:

- Multilingual voice input.
- Phone-based interactions.
- Translation support.
- More advanced document extraction.
- Additional simulated provider integrations.
- Expanded dashboard analytics.

### Explicitly defer unless justified

- Full teleconsultation platform.
- Comprehensive hospital billing.
- Live pharmacy inventory integrations.
- Wearable-device ecosystem.
- Full-featured digital health record system.
- Every possible patient, doctor, hospital, and pharmacy workflow.

These features belong to the broader Nirogya vision but are not prerequisites for proving PlanPilot's core mechanism.

---

## 13. Originality and positioning

The conversation advises against claiming that PlanPilot is unprecedented. Care coordination, discharge planning, patient navigation, diagnostic follow-up, and medication reconciliation are established areas.

The potential differentiation should be validated around the specific combination of:

- Feasibility checking before a required care step fails.
- Patient-specific logistical constraint reasoning.
- Dependency-aware replanning without changing clinical instructions.
- Explicit task ownership and persistent state.
- Evidence-based completion rather than LLM-generated assertions.
- Human approval and escalation.
- A demonstrable ability to recover from multiple consecutive failures.

### Validation work still needed

Before making originality claims:

1. Compare the workflow with existing patient-navigation and care-planning products.
2. Review relevant research and deployed healthcare workflow systems.
3. Identify which mechanisms already exist and which aspects of the proposed implementation are genuinely distinctive.
4. Refine the claim to describe the specific improvement rather than claiming the entire problem is new.
5. Demonstrate the improvement through controlled tests.

The supplied conversation includes references to existing products and external material, but this summary does not independently verify those sources or establish the competitive landscape.

---

## 14. Important decisions and current status

| Item | Status based on the supplied conversation |
|---|---|
| Preferred hackathon domain | Healthcare |
| Overall product vision | Nirogya, a multilingual healthcare ecosystem |
| Leading focused direction | Nirogya PlanPilot |
| Supporting capability | Nirogya HealthPassport |
| Main mechanism | Constraint-aware care-plan execution with evidence-based closure and human oversight |
| Initial data strategy | Synthetic patient records and simulated service integrations |
| Candidate backend | Node.js and Express |
| Candidate database | MongoDB |
| Candidate AI orchestration | LangGraph or another suitable explicit workflow implementation |
| Full ecosystem features | Long-term vision, not MVP requirements |
| Final technology stack | Not yet confirmed |
| Repository implementation status | Not established by this planning conversation |
| Official hackathon requirements | Need verification against official materials |
| Competitive originality | Needs further validation |
| Evaluation results | Not yet established |
| Next step | Inspect the cloned repository and define the smallest testable end-to-end workflow |

### Important distinction

The supplied material is primarily a planning discussion. It does not establish that PlanPilot, HealthPassport, the proposed architecture, or the suggested metrics have been implemented. The project code and any separate specification should be inspected before treating any feature as existing.

---

## 15. Repository inspection checklist for the next conversation

The next ChatGPT session should inspect the cloned code before suggesting major implementation changes.

### Initial inspection

- [ ] Read the repository README and setup instructions.
- [ ] Inspect the top-level folder structure.
- [ ] Identify frontend and backend entry points.
- [ ] Inspect `package.json`, lockfiles, and relevant configuration.
- [ ] Identify existing pages, API routes, services, models, and database connections.
- [ ] Locate any agent orchestration, LLM integration, prompts, and tool definitions.
- [ ] Locate existing authentication, authorization, and role handling.
- [ ] Identify environment-variable names from example files and code without exposing secret values.
- [ ] Inspect database schemas and existing task or workflow models.
- [ ] Review existing tests and current test results.
- [ ] Run the project using the documented process if the environment permits.
- [ ] Record observed errors before modifying code.

### Then map code to the proposed workflow

For each PlanPilot capability, classify the current repository as:

- **Exists and verified**
- **Exists but unverified**
- **Partially implemented**
- **Missing**
- **Not needed for the MVP**

Do not create duplicate components until the existing implementation has been inspected.

### Safe development practices

- Preserve the current branch and review `git status` before changing files.
- Do not overwrite a friend's work without understanding it.
- Create a feature branch if appropriate.
- Keep credentials out of source control.
- Make incremental changes.
- Run targeted tests after each change.
- Update this context file when major architectural decisions change.

---

## 16. Ready-to-use first prompt for a fresh ChatGPT chat

Copy the following prompt into a new conversation and attach or provide this `PROJECT_CONTEXT.md` file. If the cloned repository is accessible in that conversation, make it available as well.

> You are helping me continue development of **Nirogya**, a healthcare project being considered for JAI 2026.
>
> First, read the complete `PROJECT_CONTEXT.md` file and treat it as the historical planning context. Do not ask me to repeat information already documented there.
>
> **The current leading direction is Nirogya PlanPilot:** a care-plan execution agent that checks whether a clinician-approved care plan is practically achievable, discovers logistical barriers, proposes permitted alternatives, routes clinical decisions to qualified humans, and verifies task completion using evidence. Nirogya HealthPassport is a possible supporting capability, not necessarily a separate MVP.
>
> Important constraints:
>
> 1. The context file describes planning and recommendations. It does not prove that any feature exists in the cloned code.
> 2. The cloned repository is the source of truth for the current implementation.
> 3. Inspect the repository before proposing architectural rewrites or creating new files.
> 4. Clearly distinguish existing and verified functionality, partially implemented functionality, proposed features, and unknowns.
> 5. Preserve working code and avoid unnecessary rewrites.
> 6. For the prototype, prefer synthetic patient data and simulated healthcare integrations unless real integrations are explicitly required and authorized.
> 7. Never let the agent independently diagnose, prescribe, change treatment, or resolve clinical conflicts. Route decisions requiring clinical judgment to a qualified professional.
> 8. Never mark a workflow complete merely because the LLM claims success. Require the appropriate evidence and persist task state.
> 9. Do not claim novelty or benchmark results without evidence.
>
> **Your first task is analysis, not implementation.**
>
> Please:
>
> - Summarize your understanding of the product and the intended differentiator.
> - Inspect the repository structure, README, dependencies, configuration, application entry points, API routes, data models, AI/agent implementation, and tests.
> - Identify the existing architecture and the actual features that are implemented.
> - Explain how the current code compares with the PlanPilot workflow.
> - Identify important gaps, risks, and existing bugs.
> - Propose a prioritized development plan for the smallest end-to-end demo that proves the core mechanism.
> - State which files you would inspect or change for the first milestone and why.
>
> Do not start editing code until you have reported the repository findings and proposed plan. Ask a focused question only if an essential decision cannot be resolved from the context or repository.
>
> The goal is to build a reliable, demonstrable agentic healthcare workflow—not an oversized collection of unrelated AI features.

---

## 17. Final working principle

**Build one reliable workflow before building the entire healthcare ecosystem.**

Nirogya's long-term vision can include voice access, teleconsultation, medicine scanning, patient records, service discovery, reminders, and hospital dashboards. For the hackathon, PlanPilot should demonstrate one specific capability: discovering that a care-plan step is infeasible, coordinating a safe logistical recovery, maintaining state across failures, and verifying the outcome without making clinical decisions autonomously.

The next concrete step is to inspect the cloned repository and compare the actual code against this plan. Only then should the team decide what to reuse, what to fix, and what to implement next.
