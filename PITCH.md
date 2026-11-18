# PlanPilot pitch outline (JAI 2026)

A slide-by-slide outline for the deck. Every claim here can be shown in the demo or in `EVAL_RESULTS.md`. Don't add numbers or novelty claims that aren't backed by one of those.

---

## 1. The problem
- A doctor's follow-up plan is often medically right but practically impossible for the patient: the clinic is too far, there's no transport, a document is missing, or nobody answers the phone.
- These failures are usually discovered *after* a step has been missed.
- *Before using any statistics on missed follow-ups, find a source and cite it. We have none yet.*

## 2. What PlanPilot does
One sentence: **it turns a clinician-approved care plan into tasks, notices when a step can't happen for this patient, offers a safe logistical alternative, gets the right approval, and marks a task done only with evidence.**

## 3. Demo
Follow [DEMO.md](DEMO.md). The demo includes a deliberate failure (the slot is taken at the last moment) and the recovery.

## 4. Safety by design (enforced in code, not just prompts)
- The agent picks only from a server-built list of allowed actions. It cannot complete tasks, approve, verify documents, or answer for the patient.
- Alternatives always offer the **same service**. A change in how care is delivered (e.g. a teleconsult) or a later date needs **clinician approval**.
- **Evidence before completion:**
  - a booking is not proof of a visit;
  - an uploaded document is not proof until a clinician verifies it;
  - a test proves no code path skips this.
- Emergency words lead to immediate escalation and the 112 advice. Medicine or treatment questions are escalated to a clinician.
- Every change is in an append-only audit log, with who decided and why.

## 5. Results (from `npm run eval`; see [EVAL_RESULTS.md](EVAL_RESULTS.md))
Use the table exactly as generated. It currently shows:
- 10/10 controlled synthetic cases met their expected outcome;
- planted blockers detected: 6/6;
- false completions: 0;
- unnecessary escalations: 0/7.

**Caveat to say on the slide:** these are cases we designed ourselves, on synthetic data, with the rules engine. They are not a clinical evaluation or an external benchmark.

## 6. How it's built
- React + Vite frontend; Node/Express API; MongoDB with transactions.
- The task state machine is plain code. An LLM (Gemini, optional) only chooses among server-validated actions.
- It sits on the existing CareLoop execution layer: the booking engine and the Hindi/English voice agent. Patients deal with PlanPilot by phone, both calls it places and calls they make; the website is for clinicians.

## 7. What's real vs. simulated
- **Real (working code):**
  - task engine, feasibility rules, replanning, approvals;
  - bookings through the real booking engine;
  - evidence gate, agent with retries and fallback;
  - phone conversations: hearing the care plan, confirming options, reporting problems;
  - audit log.
- **Simulated:**
  - clinic directory and map;
  - phone calls in the demo;
  - lab connections;
  - "time passing" in the evaluation.
- **Not yet tried live:** the Gemini connection (no key yet) and live Twilio/Ultravox calls.

## 8. Positioning: claim the combination, not the category
Care coordination, discharge planning and patient navigation already exist. Don't say "first" or "unprecedented".

The defensible claim is the **specific combination we can demonstrate**:
- feasibility checking before a step fails;
- patient-specific logistics;
- replanning that never touches clinical instructions;
- evidence-gated completion;
- human approval;
- recovery from repeated failures.

**Before the final deck, someone must check** existing patient-navigation and care-coordination products, closed-loop referral tools, and Indian public services (e.g. ABDM-linked health record apps and the government teleconsultation service eSanjeevani). Then write one honest line on what's different.

## 9. What's next
- Try Gemini live; add the LLM plan drafter (free-text plan → draft tasks → clinician approves).
- Voice tools so patients can report problems and confirm options by phone, in Hindi.
- A verified facility directory instead of the simulated one.

## Backup
Record a run of [DEMO.md](DEMO.md) before the event, in case the live demo fails. *Not done yet: someone needs to record it.*
