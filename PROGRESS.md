# CareLoop + PlanPilot: what it is and what's built

## What this project is

**CareLoop** is a healthcare coordination app for patients in rural and semi-urban India. It books appointments and talks to patients by phone in Hindi or English. The website is for clinicians only; **patients deal with everything by phone**.

**PlanPilot** is the part built on top of it for JAI 2026. A doctor approves a care plan (for example, "blood test, then a follow-up visit within 7 days"). PlanPilot:
- turns the plan into tasks;
- spots when a task can't happen for this patient (too far, no transport, missing document, no free slot);
- finds a practical alternative and gets the right approval;
- marks a task done **only when there is proof**.

It never makes medical decisions. Anything clinical goes to a doctor.

---

## Features built

### Care plans and tasks
- Doctors create a care plan from a template. The doctor's original instruction is stored word for word and never changed.
- Each task has an owner, a due date, and the tasks that must finish before it.
- Strict status rules decide every change (e.g. a task can't jump from "Suggested" to "Done").
- A permanent audit log records every change: who, what, when, and why.

### Spotting problems and suggesting alternatives
- Each patient has a logistics profile: home location, transport, how far they can travel, the documents they hold, and their caregiver.
- A feasibility check finds problems:
  - the place is too far;
  - the service isn't offered there;
  - a document is missing;
  - there's no slot before the deadline;
  - a request has gone unconfirmed;
  - the patient isn't answering calls.
- Alternatives always offer the **same service**: a nearer clinic, home sample collection, a teleconsult, or requesting the missing document. Each one shows the approval it needs.

### Approvals and proof
- Choosing an option books nothing until everyone needed has agreed:
  - a doctor first, if how or when care happens changes (e.g. a teleconsult or a later date);
  - then the patient.
- Once everyone has agreed, the slot is booked automatically. The booking system's confirmation is saved as proof.
- A booking is **not** proof of a visit. A doctor must mark the visit attended.
- If the slot is taken at the last moment, the booking fails safely and a new option is offered.
- Patients can upload documents. An upload only counts as proof once a doctor verifies it.

### The PlanPilot agent
- A **Run PlanPilot agent** button checks every task and takes the next safe step, with a written reason for each.
- It can only choose from actions the server allows. It can never mark a task done, approve something, or answer for the patient.
- It decides with built-in rules by default. Google Gemini can be switched on, and the rules take over if the AI's answer is unusable.
- It retries failed steps 3 times, then hands the task to a doctor.
- It escalates on its own when the patient hasn't replied for 2 days, when 3 options in a row have failed, or when no allowed option exists.
- It can also re-check plans automatically on a timer (off by default).

### Health calls: symptom check by phone (for anyone, even if they aren't a patient yet)
- From **Health Calls**, CareLoop phones a person and asks whether they have a health problem. People can also call the clinic number and say they're unwell.
- The assistant asks, one at a time: what the problem is, how many days, how bad, whether it's happening now, danger signs, age, long-term illness, and allergies.
- **Fixed rules decide** (based on NHS guidance), never the AI:
  - **Self-care:** home advice plus over-the-counter medicine names from a fixed list ("follow the dose on the pack").
  - **See a doctor / urgent:** books the right doctor (e.g. cardiology for heart symptoms) after the person says yes.
  - **Emergency:** "dial 112 now", and the clinic team is alerted.
- New callers are added as patients automatically. Urgent and emergency results appear in **Review Required**.
- Test it with the four scripts in [CALL_TEST_CASES.md](CALL_TEST_CASES.md). The medical content is demo-only and needs a clinician's review before real use.

### For clinicians (the only website)
- **Add Patient** with their phone number (a real number gets real calls; fictional +1 555 numbers are simulated).
- **Care Plans** screen:
  - tasks, problems and suggestions, each with the approval it needs;
  - the proof checklist, booking details and history for each task;
  - the full audit log.
- **Review Required** tab: everything waiting for a doctor (options to approve, documents to verify, escalations, tasks PlanPilot couldn't verify).
- **Dashboard** card: active plans, tasks done with proof, blocked, escalated, and items needing a doctor.

### For patients: everything by phone (Hindi / English)
- **PlanPilot calls the patient automatically** whenever an option needs their yes or no. Staff can also press **Call patient now**.
- **Patients can call the clinic number.** The phone agent recognises them by their number and tells them their care plan and next steps.
- On the call, the patient can:
  - say yes to an option, which books it straight away, with the details read back;
  - say no, or report a problem ("I can't get there", "the time doesn't work"). PlanPilot re-plans during the call and offers a new option.
- Emergency words get "dial 112" immediately. Questions about medicines go to the doctor; the agent never advises.
- Missed calls are tracked. Two in a row mark the patient as unreachable, and PlanPilot suggests the caregiver or a doctor.
- Documents can't be sent by phone, so patients bring them to the clinic, where staff upload and verify them.

### Existing CareLoop features (made safer in this project)
- Appointment booking that can't double-book; reschedule and cancel (with the reason recorded).
- A Hindi/English phone agent that confirms every booking change before making it.
- Reminder calls and missed-call callbacks, with patient consent.
- Separate clinician and patient logins.
- Security fixes, including a production start-up check that refuses an unsafe secret key or pretend calling.

### Demo and evaluation
- `npm run demo` starts everything with one command; no database install needed.
- **Demo Lab** tab:
  - acts out the patient (says yes or no, misses calls, uploads, reports problems);
  - failure switches (slot taken, directory down, booking error, bad AI answer);
  - one-click reset.
- `npm run eval` runs 10 prepared test situations and saves the results to [EVAL_RESULTS.md](EVAL_RESULTS.md). Currently:
  - 10 of 10 behave as expected;
  - every planted problem is found;
  - no task is marked done without proof.

  These are our own synthetic cases, not a medical study.

---

## Simulated or not done yet
- **Simulated:**
  - the clinic directory and map;
  - phone calls in the demo;
  - lab connections;
  - all patient data (synthetic).
- **Needs a valid key:** Gemini. The current value isn't an API key, so the rules engine decides for now.
- **Twilio trial account:** it can only call verified numbers, and calls start with a short trial message.
- **Not built (optional):** the AI plan drafter, HealthPassport.
- **Needs a person:** check similar existing products before claiming anything is new; record a backup demo video.

---

## Try it
**Quick demo (simulated calls, no setup):** `npm run demo`, then open http://localhost:5173.

**Live calls:** see "Live phone setup" in [README.md](README.md). You need the backend, the frontend and ngrok running; then add yourself as a patient with your phone number.

Clinician login: `clinician@careloop.local` / `CareLoop2026!`

**More:**
- [DEMO.md](DEMO.md): demo script
- [PITCH.md](PITCH.md): pitch outline
- [PLAN.md](PLAN.md): full plan
- [README.md](README.md): setup and technical details
