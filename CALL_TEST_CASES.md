# Health call test cases

Five phone tests for the CareLoop health check-in. In each one, you play the patient and answer exactly as written. The assistant asks only what it still needs, one short question at a time (usually 1 to 3 questions), then gives a short answer. You can answer in Hindi, English, or Hinglish.

## Before you start
- Run the backend, the website, and ngrok (see README, "Live phone setup").
- **To get a call:** open **Health Calls**, enter your name and your Twilio-verified number, and click **Call now**. Answer, and press any key after the Twilio trial message.
- **Or call in:** dial **+1 562 837 2032** and say "mujhe tabiyat theek nahi lag rahi" (I'm not feeling well).
- After each call, open **Health Calls**. The result appears within about 10 seconds.

---

## Case 1: Mild headache (self-care)
| The assistant asks | You answer |
|---|---|
| Any health problem right now? | "Haan, halka sir dard hai, kal se." (Yes, a mild headache since yesterday.) |
| Is the pain sudden and very severe, or any trouble speaking or seeing? | "Nahi." (No.) |
| Your age, and any long-term illness or medicine allergy? | "28, kuch nahi." (28, none.) |

**Expected:**
- About 3 short sentences: rest and water; paracetamol, following the dose on the pack; call CareLoop if it lasts more than 3 days.
- Then: *"Shall I book a CareLoop doctor for you, or will you try this first?"* Say "pehle dawai try karunga" (I'll try the medicine first) to finish, or "haan, book karo" (yes, book it) to get a CareLoop doctor slot.
- The result is **Self-care at home**.

## Case 2: Cold and cough (self-care)
| The assistant asks | You answer |
|---|---|
| Any health problem right now? | "Zukaam aur khaansi hai, teen din se, halka." (A mild cold and cough, for three days.) |
| Any difficulty breathing or chest pain? | "Nahi." (No.) |
| Your age, and any long-term illness or medicine allergy? | "32, nahi." (32, no.) |

**Expected:**
- Honey in warm water and fluids; cough syrup or lozenges, and paracetamol if needed (follow the pack).
- Then the CareLoop doctor offer, as in Case 1.
- The result is **Self-care at home**.

## Case 3: Heart problem, breathless for 2 weeks (urgent appointment)
| The assistant asks | You answer |
|---|---|
| Any health problem right now? | "Mujhe dil ki bimari hai, do hafte se seedhiyan chadhne par saans phoolti hai aur seene mein jakdan hoti hai." (I have heart disease; for two weeks I get breathless and chest tightness on stairs.) |
| Is it happening right now? | "**Abhi nahi, abhi theek hoon.**" (Not now, I'm fine right now.) |

**Expected:**
- "This needs a CareLoop heart specialist soon. Dr. Rajesh Iyer is free … Shall I book it?"
- Say **"haan"**. It replies "Done", gives the reference, says to come 10 minutes early, and to call 112 only if severe chest pain or breathlessness starts.
- The result is **Urgent doctor visit**, with the booking. It also shows in **Review Required**.

## Case 4: Chest pain and can't breathe right now (emergency)
| The assistant asks | You answer |
|---|---|
| Any health problem right now? | "**Abhi mere seene mein bahut tez dard hai aur saans nahi aa rahi.**" (Right now I have severe chest pain and can't breathe.) |

**Expected:** at once: "This needs emergency help right now. Please call 112 immediately. Our CareLoop doctor will call you back too." No more questions. The result is **Emergency: dial 112**, and it appears in **Review Required**.

## Case 5: Stomach pain (self-care, with a CareLoop doctor offered)
| The assistant asks | You answer |
|---|---|
| Any health problem right now? | "Pet mein dard hai, kal se, halka." (A mild stomach pain since yesterday.) |
| Any blood, or can't keep water down? | "Nahi." (No.) |
| Your age, and any long-term illness or medicine allergy? | "30, nahi." (30, no.) |

**Expected:**
- Eat light, avoid spicy food, sip warm water; you can take an antacid (follow the pack).
- Then *"Shall I book a CareLoop doctor for you, or will you try this first?"*
- **No 112.** If you say the pain is very severe, it books an **urgent CareLoop doctor** instead.

---

### When does it say 112?
Only for these life-threatening signs **happening right now**:
- can't breathe, or chest pain with breathlessness;
- fainting;
- face drooping, slurred speech, or weakness on one side;
- seizure;
- heavy bleeding.

Everything else is handled by booking CareLoop's own doctors.

### Why case 4 doesn't book an appointment
For chest pain with breathlessness happening now, the safe action is emergency care, not a clinic slot. Case 3 shows the "serious but not happening right now" route, which books a cardiology appointment.

### Safety notes
- The assistant only asks the questions. Fixed rules decide the outcome ([triageRules.js](backend/src/services/triageRules.js)), and the only advice it can give comes from [triageProtocol.js](backend/src/config/triageProtocol.js).
- The thresholds follow NHS guidance; sources are listed in the protocol file and on the Health Calls tab.
- This is demo content. A licensed clinician must review the protocol before any real patient uses it.
