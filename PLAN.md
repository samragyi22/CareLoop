# PlanPilot Build Plan

> Working plan for turning this repo (CareLoop) into the PlanPilot demo for JAI 2026.
> Background and reasoning: [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md). Update this file when a decision changes.

---

## 1. Goal

Build **one reliable workflow**: take a clinician-approved care plan, turn it into tasks, find out when a step can't happen for this patient, offer a safe logistical alternative, get the right approval, and mark a task done **only with evidence**.

The demo must show at least one failure and a clean recovery, without the system ever making a clinical decision.

---

## 2. Where we are (code review, 20 Oct 2026)

**Built and reusable**
- Clinician and patient logins (HttpOnly cookies).
- Appointment engine: slots, transactional booking, idempotency keys, conflict protection, reschedule history.
- Hindi/English voice agent (Twilio + Ultravox) with 9 tools and a prepare → read back → confirm pattern.
- Outbound reminder calls; missed-call callback with keypad consent, cooldowns and locks.
- Patient portal: view, reschedule, cancel, manage consent.

**Verified:** frontend builds; backend starts and answers `/api/health`; clinician routes reject logged-out users.
**Not verified:** anything needing MongoDB, Twilio or Ultravox. There are no tests in the repo (they were deleted in later commits).

> Update: Phase 0 restored a test suite and verified the MongoDB paths. See the Phase 0 status line in §4.

**Missing entirely:** care plans, tasks, feasibility checks, service directory, approval queue, evidence, text LLM.

> CareLoop already does the *execution* (booking, calling). PlanPilot adds the *decision* layer: tracking the plan, choosing the next action, and refusing to fake completion.

---

## 3. Design

### Stack
Keep what exists: Express 5, MongoDB driver (no Mongoose), React 19 + Vite + Tailwind. No LangGraph: the task engine is a plain JS state machine. The LLM only fills narrow, server-checked slots.

### Flow
```
Clinician-approved plan → LLM drafts tasks → clinician confirms tasks
                                 │
       care_tasks (state machine) ── task_events (append-only log)
                                 │
  Orchestrator: server lists ALLOWED actions → LLM/rules pick one
                → server validates → risky actions go to approvals
         │                      │                       │
  Feasibility rules     Simulated directory     Approvals (patient / clinician)
                                 │
       Execution = existing booking engine, calls, portal
                                 │
               Evidence records → only path to "completed"
```

### New collections
| Collection | Key fields |
|---|---|
| `patients` | name, phone, language, constraints (transport, max travel km, documents held, caregiver), `isSynthetic` |
| `care_plans` | patientId, source text, approvedBy, approvedAt, status |
| `care_tasks` | planId, type, title, owner, dueAt, dependsOn[], status, requiredEvidence, clinicalInstruction (read-only) |
| `task_events` | taskId, from → to, actor (system/agent/patient/clinician), reason, evidenceId, timestamp |
| `barriers` | taskId, code, detail, source, detectedAt, resolvedAt |
| `service_directory` | name, type, services[], distanceKm, hours, requiredDocuments[], `isSimulated: true` |
| `approvals` | taskId, kind (patient_confirmation / clinician_approval), proposal, status, decidedBy, decidedAt |
| `evidence` | taskId, type, source, reference, recordedBy, recordedAt |

### Task statuses (first draft, finalize in Phase 1)
`suggested` → `awaiting_patient` → `awaiting_approval` → `requested` → `confirmed` → `in_progress` → `completed_with_evidence`

Side states: `blocked`, `escalated`, `unable_to_verify`. Any state can move to `escalated`. `blocked` returns to `suggested` after a replan.

### Evidence required to complete
| Task type | Not enough | Required |
|---|---|---|
| Follow-up visit | Appointment booked | Clinician marks visit attended |
| Lab test | Test booked or done | Report received **and** clinician reviewed |
| Document submission | Patient says it was sent | Document received and verified by staff |
| Appointment booking | Request sent | Confirmed booking reference |

### Guardrails (enforced in code, not only in prompts)
- The LLM never writes task status. It returns an action ID from the server's list, and the server validates it.
- Anything touching clinical content (diagnosis, medication, treatment changes, conflicting instructions) → `escalated` plus a clinician review task.
- Alternatives must offer the same service the clinician specified; only time, place or logistics may change.
- All patient free text goes through `assessEmergencyRisk` first ([emergency.js:67](backend/src/config/emergency.js#L67)).
- Synthetic patients can never trigger a real phone call.
- UI labels simulated actions as simulated.

---

## 4. Phases

Effort assumes 2–3 people part-time. Critical path: **0 → 1 → 3 → 6**.

### Phase 0 — Stabilize (2–3 days)
**Security / correctness fixes**
- [x] Add auth to the consent endpoints: [voice.routes.js:607](backend/src/routes/voice.routes.js#L607), [:635](backend/src/routes/voice.routes.js#L635)
- [x] Bind outbound/callback tools to the real Twilio call ID: [outboundVoice.service.js:266](backend/src/services/outboundVoice.service.js#L266), [:555](backend/src/services/outboundVoice.service.js#L555)
- [x] Fail at startup if `JWT_SECRET` is unset in production ([env.js:19](backend/src/config/env.js#L19), [toolSecurity.service.js:18](backend/src/services/toolSecurity.service.js#L18)); block the mock tool bypass outside development ([toolSecurity.service.js:45](backend/src/services/toolSecurity.service.js#L45))
- [x] Store seeded `providerId` as ObjectId: [seedPatientUsers.js:86](backend/src/scripts/seedPatientUsers.js#L86), [:107](backend/src/scripts/seedPatientUsers.js#L107)
- [x] Stop inventing a phone number: [agentTools.service.js:302](backend/src/services/agentTools.service.js#L302)
- [x] Persist confirmations in MongoDB instead of memory: [confirmation.service.js:18](backend/src/services/confirmation.service.js#L18)
- [x] Link appointments to patients by ID, not email only: [patient.routes.js:34](backend/src/routes/patient.routes.js#L34)
- [x] Save the cancellation reason: [booking.service.js:316](backend/src/services/booking.service.js#L316)

**Honest UI**
- [x] Remove hard-coded "0 Pending" / "Exception Queue Is Clear" / exceptions `0`: [ClinicianWorkspace.jsx:303](frontend/src/components/ClinicianWorkspace.jsx#L303), [:505](frontend/src/components/ClinicianWorkspace.jsx#L505), [:1337](frontend/src/components/ClinicianWorkspace.jsx#L1337)
- [x] Change "Patient reached & confirmed" to "Call completed": [:1079](frontend/src/components/ClinicianWorkspace.jsx#L1079)
- [x] Fix the in-flight lock check (`lock?.locked` doesn't exist): [:1150](frontend/src/components/ClinicianWorkspace.jsx#L1150)
- [x] Add the Inbound Voice tab to the menu: [:759](frontend/src/components/ClinicianWorkspace.jsx#L759)

**Small fixes**
- [x] Use `VITE_API_URL`: [api.js:1](frontend/src/services/api.js#L1)
- [x] Make the doctor-name search work: [agentTools.service.js:86](backend/src/services/agentTools.service.js#L86), [provider.repository.js:47](backend/src/repositories/provider.repository.js#L47)
- [x] Align prompt specialties and hours with seed/config: [ultravox.service.js:393](backend/src/services/ultravox.service.js#L393)

**Foundations**
- [x] Test suite: `node:test` + `mongodb-memory-server` in replica-set mode (bookings use transactions). Cover booking, auth, consent, tool auth.
- [x] `npm run seed:all`; Indian-context synthetic data, all marked `isSynthetic`.
- [x] Setup doc: MongoDB must be a replica set (Atlas free tier or local `--replSet`), plus an `.env` checklist.
- [x] Rewrite README to match the current code.

**Also fixed during Phase 0**
- [x] `findAvailabilityByProvider` returned nothing when given only a start or end date
- [x] User input in provider searches is now regex-escaped
- [x] Synthetic patients (`+1 555` numbers or `isSynthetic`) can never trigger a real call; removed the real `+1 562` area code from the mock list
- [x] Demo schedules are 9:00–17:00 IST (were 9:00–17:00 UTC = 14:30–22:30 IST); spoken times use the clinic timezone
- [x] `proxy-addr` declared as a direct dependency (it was imported but only installed transitively)

**Done when:** tests pass, and a fresh clone reaches a seeded demo in under 10 minutes.

**Status (20 Oct 2026): ✅ done** on branch `phase-0-stabilize`. 41/41 backend tests pass; frontend builds with no lint errors; `seed:all` + server verified end-to-end against a throwaway replica set. Not verified: live Twilio/Ultravox calls (no credentials).

### Phase 1 — Care plan and task engine (4–5 days)
- [x] Models and repositories for `patients`, `care_plans`, `care_tasks`, `task_events` (plus `evidence`, pulled forward because completion must check it)
- [x] State machine module with a transition table, plus unit tests (including "cannot complete without evidence"): [taskStateMachine.js](backend/src/services/taskStateMachine.js)
- [x] Every transition writes a `task_events` entry, in the same transaction as the change
- [x] Clinician UI: create a plan, see tasks with status, owner, due date, dependencies: [CarePlansPanel.jsx](frontend/src/components/CarePlansPanel.jsx)
- [x] Hand-written JSON plans: 2 templates in [carePlanTemplates.js](backend/src/config/carePlanTemplates.js), and the API accepts custom JSON plans
- [ ] LLM drafter (plan text → draft tasks → clinician edits and approves). **Deferred** until open decision #2 (LLM provider) is made

**Done when:** a 4-task plan with dependencies survives a restart and rejects illegal transitions.

**Status (20 Oct 2026): ✅ done** (except the deferred LLM drafter), on branch `phase-0-stabilize`. 62/62 backend tests pass; frontend builds; the Care Plans screen was checked in headless Chrome against a seeded database.

### Phase 2 — Feasibility and replanning (3–4 days)
- [x] Simulated `service_directory` (7 facilities on a synthetic district map), every entry `isSimulated` and labelled in the UI: [seedDirectory.js](backend/src/scripts/seedDirectory.js)
- [x] Patient constraints profile: home location, own transport, travel limit, documents held, caregiver; editable by clinicians (`PATCH /api/patients/:id/logistics`)
- [x] Feasibility rules → barrier codes: `TRANSPORT`, `SERVICE_UNAVAILABLE`, `MISSING_DOCUMENT`, `NO_SLOT`, `UNCONFIRMED`, `NO_RESPONSE` (+ `OTHER` for reported barriers): [feasibilityRules.js](backend/src/services/feasibilityRules.js)
- [x] Replanner that proposes same-service alternatives only (uses real provider calendars via the slot engine); a modality change (in-person → teleconsult), a date after the clinician's deadline, or contacting a caregiver is marked as needing clinician approval
- [x] Barriers and proposals persisted (`barriers`, `replan_proposals`); feasibility checks, barriers, and proposals all appear in the audit log; a newly infeasible task is moved to Blocked through the state machine
- [x] Clinicians can report barriers by hand; the text is screened with `assessEmergencyRisk`, and a possible emergency escalates the task immediately and returns the 112 guidance

**Done when:** the transport-barrier case returns a correct alternative facility and slot.

**Status (20 Oct 2026): ✅ done** on branch `phase-2-feasibility`. 89/89 backend tests pass (27 new); the Care Plans screen was checked in headless Chrome (plan-wide check, alternatives, emergency screening). Accepting an alternative is Phase 3.

### Phase 3 — Approval, evidence, escalation (3 days)
- [x] `approvals` queue with patient confirmations and clinician approvals: [approval.service.js](backend/src/services/approval.service.js). Choosing a `replan_proposals` alternative (or a slot at the planned clinic) creates an approval; clinician first when a clinical judgement is involved, then the patient. Only when every approval is in is the slot booked (idempotent, slot re-checked), the task's facility updated, and `booking_confirmed` evidence recorded by `system`. A slot taken at commit fails safely (task back to Blocked); repeated technical failure escalates
- [x] Real Review Required tab: options needing clinician approval, documents to verify, escalations, `unable_to_verify` tasks, evidence only a clinician can record, items waiting on patients, recent failures: [reviewQueue.service.js](backend/src/services/reviewQueue.service.js), [ReviewQueuePanel.jsx](frontend/src/components/ReviewQueuePanel.jsx)
- [x] Evidence capture: automatic `system` evidence from the booking engine; patient (or staff) document upload with file-type checks; a clinician's verification is what becomes `document_verified` evidence: [documentSubmission.service.js](backend/src/services/documentSubmission.service.js)
- [x] Patient "My care plan" view: tasks, what's blocked, what's needed from them, confirm/decline an option, upload a document: [PatientCarePlan.jsx](frontend/src/components/PatientCarePlan.jsx) (the confirm and upload parts were pulled forward from Phase 5)

**Done when:** tests prove no code path reaches `completed_with_evidence` without matching evidence.

**Status (20 Oct 2026): ✅ done.** [evidenceGate.test.js](backend/test/evidenceGate.test.js) checks every task type × status × actor × partial-evidence combination against the state machine, checks the source so `applyTransitionInSession` stays the only status writer (it validates first), and checks the database after real flows. 22 new tests; screens checked in headless Chrome (agent run → patient confirms in the portal → document verified from the review queue).

### Phase 4 — Orchestrator (3–4 days)
- [x] Per task: server builds context + allowed actions → LLM picks one with a reason → server validates → executes or queues for approval: [orchestratorActions.js](backend/src/services/orchestratorActions.js) (pure), [orchestrator.service.js](backend/src/services/orchestrator.service.js). The allowed list never contains completing, approving, verifying, or answering for the patient
- [x] Retries with backoff for tool failures, timeouts or bad LLM output, then escalate (never fail silently). Bad/slow LLM answers fall back to the rules engine (logged); tool failures retry 3× then escalate the task with the error
- [x] Re-evaluation of overdue/blocked tasks: scheduled tick (`PLANPILOT_AGENT_INTERVAL_MINUTES`, off by default) + "Run PlanPilot agent" button; per-plan lock so runs never overlap
- [x] Rules-only fallback so the demo works without the LLM (the default)
- [x] LLM adapter: Gemini (per the context doc) in [llmClient.js](backend/src/services/llmClient.js), JSON mode, patient names removed from prompts. Tested against a fake Gemini server only; **not yet tried against the live API** (no key)

**Done when:** one plan recovers from two failures in a row without losing state.

**Status (20 Oct 2026): ✅ done.** [orchestrator.test.js](backend/test/orchestrator.test.js): the chosen slot is taken twice in a row; the agent re-checks, offers fresh slots, and the third confirmation books, with one booking, two failed approvals, and every audit trail replaying. [orchestratorLlm.test.js](backend/test/orchestratorLlm.test.js) covers garbage JSON, a forbidden "complete" action, timeouts, HTTP errors, and an outage. 31 new tests; **142/142 backend tests pass**. Work is uncommitted (not pushed), as asked.

### Phase 5 — Patient channels (2–3 days)
- [x] Portal: report a barrier ("I can't get there" also asks how far they can travel, which updates their logistics), confirm an alternative, upload a missing document. Free text is screened for emergencies and clinical content: [PatientCarePlan.jsx](frontend/src/components/PatientCarePlan.jsx)
- [x] Simulated patient-response panel for the demo: the **Demo Lab** tab (patient says yes/no, misses 2 calls, uploads a document, reports a problem; all labelled simulated): [DemoLabPanel.jsx](frontend/src/components/DemoLabPanel.jsx), [demo.service.js](backend/src/services/demo.service.js)
- [ ] *Optional, skipped:* voice tools `get_my_care_tasks`, `report_barrier`, `confirm_alternative` for the Hindi agent. First on the cut list, and they can't be tested without live Twilio/Ultravox

**Done when:** a patient can report a barrier and confirm an alternative from the portal. **✅ Done (20 Oct 2026)**, checked in headless Chrome.

### Phase 6 — Demo, failure injection, evaluation (3 days)
- [x] Scripted run of the demo in PROJECT_CONTEXT §6.5: [DEMO.md](DEMO.md)
- [x] Failure switches in the Demo Lab: directory down, slot taken at commit, booking system error, agent action error, LLM unreachable, malformed LLM output (the LLM switches only matter with a key); "no answer" and "missing document" are patient simulations: [faults.js](backend/src/utils/faults.js)
- [x] `npm run eval` over the 10 cases in PROJECT_CONTEXT §11 ([eval/run.js](backend/eval/run.js)). It reports blocker detection, recovery success, false-completion rate, escalation correctness, unnecessary escalations, audit consistency, steps to recover and human actions, and writes [EVAL_RESULTS.md](EVAL_RESULTS.md)
- [x] One-click demo reset (Demo Lab), plus `npm run demo` (one command, no MongoDB or `.env` needed)
- [x] Clinical-content screen: text about medicines, doses, or conflicting instructions is escalated to a clinician instead of acted on: [clinicalScreen.js](backend/src/config/clinicalScreen.js)

**Done when:** the full demo runs end-to-end with injected failures, and `npm run eval` prints real metrics. **✅ Done (20 Oct 2026):** 10/10 cases pass (our own synthetic cases, not a clinical evaluation).

### Phase 7 — Polish and pitch (2 days)
- [x] Per-task audit timeline view ("History of this task" on every task card), and a PlanPilot summary card on the dashboard
- [ ] *Optional, skipped:* HealthPassport-lite
- [ ] Compare against existing patient-navigation products before any novelty claim. **Needs a person to research**; what to check is listed in [PITCH.md](PITCH.md) §8
- [x] Deck outline: [PITCH.md](PITCH.md). [ ] Recorded backup demo: **needs a person to record it** from [DEMO.md](DEMO.md)

**Status (20 Oct 2026):** the software is complete. Remaining are human tasks (competitor research, recording) and optional extras (voice tools, HealthPassport, LLM plan drafter, trying Gemini live).

**Total:** about 22–27 working days.
**If short on time, cut in this order:** voice tools (Phase 5) → HealthPassport (Phase 7) → LLM plan drafter (keep hand-written JSON plans).

---

## 5. Open decisions

| # | Decision | Options | Owner | Status |
|---|---|---|---|---|
| 1 | Product name shown to judges | CareLoop / Nirogya PlanPilot | | Open |
| 2 | Text LLM for orchestrator and plan drafter | Gemini (per context doc) or other; design is provider-agnostic | | Open. A Gemini adapter exists and is off by default; the rules engine runs without it. Choosing means adding a key (or another adapter) and trying it live |
| 3 | Deadline and team split | — | | Open |
| 4 | Live voice in the demo | Live (Twilio + Ultravox credits + HTTPS tunnel) / simulated | | Open |

---

## 6. Working rules

- Branch per phase (`phase-0-stabilize`, `phase-1-task-engine`, …); open PRs into `main`, no direct pushes.
- Every PR runs the tests; new behaviour comes with tests.
- No secrets in git; only `.env.example` is committed.
- Synthetic data only. Never use real patient details or real phone numbers in seeds.
- Never claim results, novelty or completion without evidence: in the product, in the UI, or in the pitch.
- Tick the checkboxes here as work lands, and update §5 when a decision is made.
