# CareLoop

**Voice-first healthcare coordination for India.** CareLoop connects clinicians and patients through a care-plan execution engine called **PlanPilot** — combining appointment booking, a Hindi/English voice agent, and automated reminder calls. The web dashboard is for clinicians; patients interact entirely over the phone.

**Off Campus code: 8GP36K**

## 🎥 Demo

[Watch the demo →](https://drive.google.com/file/d/198SAl5XUOQaHyIaAaV5MtZyvKeY_L-zK/view?usp=sharing)

---

> **Status:** Fully functional end-to-end:
> - App is stable and production-ready for demo use
> - PlanPilot care plans and tasks work with a strict state machine
> - Logistical barriers are detected and same-service alternatives proposed
> - Options go through clinician and patient approval before anything is booked; completion requires evidence
> - The PlanPilot agent picks the next step for each task (rules engine by default; Gemini optional)
> - Patients hear their plan, confirm options, and report problems by phone — PlanPilot calls them automatically
> - A Demo Lab provides failure switches and a one-click reset
> - `npm run eval` measures 10 synthetic end-to-end cases
>
> All demo data is synthetic.

---

## Quick start

### Fastest: one-command demo (no MongoDB or `.env` needed)

```bash
npm run install:all   # first time only
npm run demo          # then open http://localhost:5173
```

This starts a throwaway in-memory database, loads the synthetic demo data, and runs the API (port 5050) and the web app (port 5173). Phone calls are simulated. Ctrl+C stops everything and wipes the data, so every run starts fresh.

To run the two halves in separate terminals instead, put `VITE_API_URL=http://localhost:5050` in `frontend/.env`, then run:

```bash
cd backend && npm run dev:demo    # terminal 1: API + demo database
cd frontend && npm run dev        # terminal 2: web app
```

### Full setup (your own MongoDB)

**Prerequisites:** Node.js 18+ (tested on 24), npm 9+, and MongoDB **running as a replica set** (bookings use transactions). MongoDB Atlas free tier works; for local MongoDB see the comment in [backend/.env.example](backend/.env.example).

```bash
npm run install:all                      # install backend + frontend
cp backend/.env.example backend/.env     # then set MONGODB_URI (and JWT_SECRET outside dev)
cp frontend/.env.example frontend/.env
npm run seed:all                         # clinician, 5 doctors, IST schedules, simulated directory, 3 synthetic patients, 1 demo care plan
npm run dev:backend                      # http://localhost:5000  (terminal 1)
npm run dev:frontend                     # http://localhost:5173  (terminal 2)
```

Set `VOICE_MOCK_MODE=true` to run without Twilio or Ultravox.

**macOS:** port 5000 is often taken by AirPlay Receiver. Either turn that off (System Settings → General → AirDrop & Handoff), or set `PORT=5050` in `backend/.env` and `VITE_API_URL=http://localhost:5050` in `frontend/.env`.

### Login

| Role | Email | Password |
|---|---|---|
| Clinician | `clinician@careloop.local` | `CareLoop2026!` |

The website is for clinicians only. **Patients use the phone:** PlanPilot calls them, or they call the clinic number. Synthetic patients use fictional `+1 555` numbers, and calls to them are always simulated.

### Tests and evaluation

```bash
npm test        # automated tests
npm run eval    # the 10 synthetic PlanPilot cases; prints metrics and writes EVAL_RESULTS.md
```

Runs the backend suite (142 tests) against an in-memory MongoDB replica set (downloaded automatically on first run). It covers:

- auth and role boundaries;
- booking concurrency and idempotency;
- patient ownership;
- voice tool auth;
- persisted confirmations and consent endpoints;
- seeds and timezone handling;
- the PlanPilot state machine and care-plan API;
- feasibility rules;
- approvals and the evidence gate;
- the agent: rules, a fake Gemini server, retries, recovery from repeated failures.

---

## What's built

| Area | Summary |
|---|---|
| Auth | Separate clinician and patient logins with HttpOnly cookies; patient logout revokes the token server-side |
| Appointment engine | Slot generation, transactional booking (no double-booking), idempotency keys, cancel with reason, reschedule with history |
| Voice agent | Twilio + Ultravox, Hindi-first with automatic English/Hinglish switching, 9 tools using prepare → read back → confirm |
| Outbound calls | Clinician-triggered reminder calls; missed-call callback with keypad consent, cooldowns, daily limits |
| Patient API (no web UI) | The `/api/patient` endpoints remain for future channels; the website is clinician-only |
| Safety | Emergency override in voice prompts (112 for India), no diagnosis or prescriptions, phone numbers masked in logs and UI |
| **PlanPilot care plans** | Clinician creates a plan from a template; tasks with owners, due dates, and dependencies move through a strict state machine; completion requires evidence; every change is in an append-only audit log |
| **PlanPilot feasibility** | Checks each task against the patient's logistics (distance, transport, documents, slots, contact) and a simulated service directory; records barriers; blocks infeasible tasks; proposes same-service alternatives with the approvals each needs |
| **PlanPilot approvals and evidence** | A chosen option waits for clinician approval (clinical changes) and patient confirmation, then books through the booking engine, which records the evidence; patient document upload with clinician verification; a real Review Required queue |
| **PlanPilot agent** | For each task, the server lists the allowed actions; the rules engine (default) or Gemini picks one with a reason; the server validates, logs, and executes it, or sends it to approval. Retries, fallback, escalation, per-plan lock, optional timer |
| **PlanPilot by phone** | Voice tools `get_my_care_plan`, `respond_to_care_option`, `report_care_problem`. PlanPilot calls patients automatically when an option needs their answer (`PLANPILOT_AUTO_CALL_PATIENTS`), re-plans during the call, and screens for emergencies and clinical content |
| **Demo Lab (dev only)** | Simulated patient replies, missed calls, uploads and reports; failure switches; one-click reset |
| **Evaluation** | `npm run eval`: 10 controlled synthetic cases through the real services; writes [EVAL_RESULTS.md](EVAL_RESULTS.md) |

### PlanPilot rules (enforced in [taskStateMachine.js](backend/src/services/taskStateMachine.js))

- Tasks move only along allowed paths, e.g. you can't jump from *Suggested* to *Completed*.
- A task can't start until the tasks it depends on are completed with evidence.
- *Completed with evidence* needs every evidence type for that task type: a confirmed booking is not proof of a visit, and a received lab report isn't complete until a clinician reviews it.
- Booking evidence must be a real confirmed appointment belonging to that patient.
- The agent can never mark a task complete; only clinicians can resolve escalations.
- Blocking, escalating, or marking a task unverifiable requires a reason, which is logged.

### Feasibility rules (in [feasibilityRules.js](backend/src/services/feasibilityRules.js))

- Barriers: `TRANSPORT` (beyond the patient's travel limit), `SERVICE_UNAVAILABLE`, `MISSING_DOCUMENT`, `NO_SLOT` (nothing before the deadline), `UNCONFIRMED` (requested > 48 h ago), `NO_RESPONSE` (last 2 calls unanswered).
- Alternatives always offer the **same service** the clinician asked for. A different place or time inside the deadline needs only patient confirmation. A teleconsult instead of an in-person visit, a date after the deadline, or contacting a caregiver needs **clinician approval**.
- Proposals change nothing on their own. Barrier reports are screened for emergencies; a possible emergency escalates the task to a clinician immediately.
- The service directory and map are **simulated** and labelled as such everywhere.

### Approval rules (in [approval.service.js](backend/src/services/approval.service.js))

- Choosing an option books nothing. It waits for the clinician first (when it changes how or when care happens), then the patient: by phone, or recorded by staff with a note.
- Only when every approval is in is the slot booked: idempotently, with the slot re-checked at that moment. The booking engine's confirmation is recorded as `booking_confirmed` evidence by `system`.
- A slot taken at the last moment fails safely: no booking, task back to Blocked. Repeated technical failure escalates to a clinician. A booking that can't be attached to its task is cancelled.
- A patient's uploaded document is not evidence until a clinician verifies it.
- The agent can never approve, verify, or answer for the patient.

### Agent rules (in [orchestratorActions.js](backend/src/services/orchestratorActions.js))

- For each task, the server builds the list of allowed actions. Nothing on it completes a task, approves, verifies, or answers for the patient.
- The rules engine or the LLM picks one action with a reason. An LLM answer counts only if it is JSON naming an action on the list; otherwise the rules decide, and the fallback is logged.
- Failing actions are retried 3× with backoff, then the task is escalated with the error.
- The agent escalates on its own when:
  - the patient hasn't answered for 48 h;
  - 3 options in a row failed;
  - no permitted option exists.
- Patient names are removed from LLM prompts.
- Free text from patients or staff about medicines, doses or conflicting instructions is escalated to a clinician ([clinicalScreen.js](backend/src/config/clinicalScreen.js)). Emergency words take priority and trigger the 112 advice.

---

## Project structure

```
backend/
  src/
    config/        env (+ production safety check), db, indexes, clinic, emergency, care-plan templates
    repositories/  MongoDB access per collection
    services/      booking, slots, auth, confirmations, voice agent tools, Ultravox, outbound calls,
                   PlanPilot: taskStateMachine, carePlan, feasibilityRules, feasibility, approval,
                   documentSubmission, reviewQueue, patientCarePlan, orchestratorActions, orchestrator, llmClient
    routes/        auth, providers, availability, appointments, voice (incl. PlanPilot care calls), patient API,
                   PlanPilot: patient registry, care plans/tasks, directory, review queue/approvals/documents,
                   patient care plan
    middleware/    clinician/patient auth, Twilio signature verification
    scripts/       seed:all, seed:users, seed:appointments, seed:directory, seed:patients, seed:care-plans
    utils/         timezone helpers, synthetic-data guards, ObjectId helpers, retry, fault injection (tests)
  test/            node:test suites + in-memory MongoDB harness
  eval/            npm run eval: the 10 synthetic evaluation cases
frontend/
  src/
    components/    LoginView, ClinicianWorkspace, CarePlansPanel, ReviewQueuePanel, DemoLabPanel, PatientPortal, PatientCarePlan
    services/      api.js (reads VITE_API_URL)
```

---

## API overview

| Prefix | Auth | Endpoints |
|---|---|---|
| `/api/health` | none | `GET /`, `GET /db` |
| `/api/auth` | none / session | `POST /login`, `POST /logout`, `GET /me`, `POST /patient/login`, `POST /patient/logout`, `GET /patient/me` |
| `/api/providers` | clinician | `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `GET /:id/availability`, `POST /:id/availability` |
| `/api/availability` | clinician | `DELETE /:id` (refused if it contains confirmed bookings) |
| `/api/appointments` | clinician | `GET /slots`, `GET /`, `POST /`, `GET /:id`, `POST /:id/cancel`, `POST /:id/reschedule` |
| `/api/patient` | patient | `GET /appointments`, `GET /appointments/:id`, `POST /appointments/:id/reschedule`, `POST /appointments/:id/cancel`, `GET /slots`, `GET /emergency-guidance`, `GET /clinic-info`, `GET`/`POST /callback-consent` |
| `/api/voice` | Twilio signature | `POST /inbound`, `POST /status`, `POST /callback/gather-consent` |
| `/api/voice` | clinician | `GET /config`, `GET /calls`, `POST /outbound`, `POST /callback/retry`, `GET`/`POST /callback/consent` |
| `/api/patients` | clinician | `GET /`, `GET /:id`, `POST /`, `PATCH /:id/logistics`: patient records (with the phone PlanPilot calls) |
| `/api/care-plans` | clinician | `GET /meta` (includes the active agent decider), `GET /templates`, `GET /`, `POST /` (`{ patientId, templateId }` or a custom `tasks` JSON), `GET /:id`, `POST /:id/feasibility-check`, `POST /:id/agent-run`, `GET /:id/agent-runs` |
| `/api/care-tasks` | clinician | `POST /:id/transition` (`{ to, reason }`), `POST /:id/evidence` (`{ type, reference, note }`), `POST /:id/feasibility-check`, `POST /:id/barriers` (`{ code, detail }`), `POST /:id/barriers/:barrierId/resolve`, `POST /:id/approvals` (`{ proposalId, alternativeId, slotStartAt }`), `POST /:id/planned-booking`, `POST /:id/documents` (on the patient's behalf) |
| `/api/review-queue` | clinician | `GET /`: everything waiting on a person |
| `/api/approvals` | clinician | `POST /:id/decision` (`{ decision: approve\|reject, note }`), `POST /:id/patient-response` (`{ decision: confirm\|decline, note }`, staff recording the patient's answer), `POST /:id/cancel` |
| `/api/document-submissions` | clinician | `GET /:id/file` (sandboxed), `POST /:id/review` (`{ decision: verify\|reject, note }`) |
| `/api/patient/care` | patient | `GET /plans`, `POST /approvals/:id/respond` (`{ decision, note }`), `POST /tasks/:id/documents` (`{ fileName, mimeType, contentBase64 }`), `POST /tasks/:id/barriers` (`{ problem, detail, maxTravelKm?, hasOwnTransport? }`) |
| `/api/demo` | clinician, **not in production** | `GET /status`, `POST /faults` (`{ name, times }`), `POST /faults/clear`, `POST /approvals/:id/reply`, `POST /patients/:id/missed-calls`, `POST /tasks/:id/upload`, `POST /tasks/:id/report`, `POST /reset` |
| `/api/directory` | clinician | `GET /?category=clinic\|lab`: the simulated service directory |
| `/api/voice/tools/:toolName` | per-call HMAC tool token | `find_providers`, `get_available_slots`, `get_appointment_status`, `prepare_`/`confirm_booking`, `prepare_`/`confirm_cancellation`, `prepare_`/`confirm_reschedule` |

Booking accepts an `Idempotency-Key` header; a replay with the same payload returns the original booking.

---

## PlanPilot agent setup (optional)

The agent works without any AI service: the built-in rules engine decides. To let Gemini decide (the rules stay as the fallback), set these in `backend/.env`:

```
PLANPILOT_LLM_PROVIDER=gemini
GEMINI_API_KEY=your-key
PLANPILOT_LLM_MODEL=gemini-2.5-flash      # any Gemini model that supports JSON output
PLANPILOT_AGENT_INTERVAL_MINUTES=15       # optional: re-check active plans automatically (0 = off)
```

## Live phone setup (patients talk to PlanPilot by phone)

1. In `backend/.env`, fill in the Twilio, Ultravox and MongoDB values, set `VOICE_MOCK_MODE=false`, and use `PORT=5050` (port 5000 is often taken by AirPlay on macOS).
2. Install ngrok, log in once, and expose the backend:
   ```bash
   brew install ngrok
   ngrok config add-authtoken <your token from dashboard.ngrok.com>
   ngrok http 5050 --url=<your-static-domain>.ngrok-free.dev
   ```
   Set `PUBLIC_URL` to that https address. In Twilio, set the number's voice webhook to `{PUBLIC_URL}/api/voice/inbound` and the status callback to `{PUBLIC_URL}/api/voice/status`.
3. Run `cd backend && npm run dev`, then `cd frontend && npm run dev` (with `frontend/.env` set to `VITE_API_URL=http://localhost:5050`).
4. In the website, go to **Care Plans → Add Patient** and add yourself with your phone number (a Twilio trial can only call verified numbers). Then create a care plan for yourself and press **Run PlanPilot agent**. PlanPilot phones you to confirm the option it chose. You can also call the Twilio number and ask about your care plan.

## Live voice setup (appointments)

1. Fill the Twilio and Ultravox values in `backend/.env` and set `VOICE_MOCK_MODE=false`.
2. Expose the backend over HTTPS (Ultravox tool webhooks require it): `ngrok http 5000`, then set `PUBLIC_URL` to the HTTPS URL.
3. In the Twilio console, point your number's **A call comes in** webhook to `POST {PUBLIC_URL}/api/voice/inbound` and **Call status changes** to `POST {PUBLIC_URL}/api/voice/status`.
4. Call the number. The agent greets in Hindi and switches language with the caller.
5. Set `VOICE_CALLBACK_ENABLED=true` for missed-call callback mode (the caller is asked for consent on the keypad, then called back).

---

## Safety and data

- Synthetic data only. Never seed real patient details or real phone numbers.
- Production refuses to start with a placeholder `JWT_SECRET` or with `VOICE_MOCK_MODE=true`.
- The voice agent never diagnoses, prescribes, or changes treatment; emergencies get the regional number (112 in India) immediately.
- Pending voice confirmations are stored in MongoDB, expire after 5 minutes, and are cancelled when the call ends.
- These are application-level safeguards, not a regulatory compliance certification.
