# CareLoop: 4-minute demo script (2 phone calls)

**Before recording:**
- Start backend, frontend and ngrok.
- Log in as `clinician@careloop.local`.
- Phone on speaker (+91 99170 44348).
- Do one practice call.
- In the edit, cut Twilio's "press any key" message and any pauses.

---

### 0:00–0:25 · The idea
`[Screen: Dashboard]`

> "Millions of patients in India never open a health app. Small problems become serious because nobody follows up, and even when a doctor writes a care plan, nobody checks whether the patient can actually do it.
> **CareLoop changes that with a simple phone call.** An AI that speaks Hindi and English, rules that keep it safe, and real CareLoop doctors behind it."

---

### 0:25–1:40 · Call 1: a patient with a health problem
`[Screen: Health Calls → type name and number → Call now]`

> "Let's have CareLoop call someone. They don't even need to be registered."

**On the call:**
| AI | You |
|---|---|
| "Kya aapko abhi koi tabiyat ki pareshani hai?" (Do you have any health problem right now?) | "Pet mein dard hai, do din se." (I've had a stomach ache for two days.) |
| "Khoon ya ulti?" (Any blood or vomiting?) | "Nahi." (No.) |
| "Umar aur koi bimari ya allergy?" (Your age, and any illness or allergy?) | "30, kuch nahi." (30, nothing.) |
| A care tip and an antacid, then: "Doctor book karoon, ya pehle dawai try karenge?" (Shall I book a doctor, or will you try the medicine first?) | "Doctor book kar do." (Please book a doctor.) |
| "Dr. Ananya Sharma … free hain, book kar doon?" (Dr. Ananya Sharma is free …, shall I book?) | "Haan." (Yes.) |
| "Ho gaya, reference CL…" (Done, reference CL…) | "Thank you." |

`[Screen: the new card on Health Calls → Appointments]`

> "Three quick questions, clear advice, and a CareLoop doctor booked on the same call. No app, no waiting, in the patient's own language."

---

### 1:40–2:05 · How it decides
`[Screen: Health Calls → the "How CareLoop decides" box]`

> "The AI doesn't decide on its own. It only collects the facts. **Fixed medical rules, based on NHS guidance, decide what happens:** home care for small problems, a CareLoop specialist for serious ones, and '112, right now' only for a real emergency. Urgent cases are flagged for the doctor instantly."

---

### 2:05–3:25 · Call 2: the doctor's care plan runs itself
`[Screen: Care Plans → Add Patient → New Care Plan → Run PlanPilot agent]`

> "Now the second idea: **PlanPilot.** After a hospital stay, the doctor approves a plan: a blood test, a follow-up visit, and documents. PlanPilot checks whether each step is actually possible for *this* patient.
> The clinic is 15 kilometres away, and she can travel only 5. So PlanPilot finds the same service just 1.4 kilometres away, with a real doctor's slot, and calls her."

**On the call:** PlanPilot offers the nearer clinic and the time → **"Haan, theek hai."** (Yes, that's fine.)

`[Screen: the booking task → "Completed with evidence"; the visit task → not done]`

> "Booked, with proof. But look: the visit itself is not marked done. A booking proves the booking, not the visit. Only the doctor can close that. PlanPilot never fakes progress, and never changes the doctor's instructions."

---

### 3:25–4:00 · Close
`[Screen: Dashboard]`

> "So that's CareLoop. One phone call, in the patient's own language. Small problems handled at home, serious ones sent straight to a CareLoop doctor, and every care plan carried through, with proof and with the doctor in control.
> **Care that doesn't stop when the patient leaves the clinic.** Thank you."
