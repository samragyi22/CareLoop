import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * PlanPilot evaluation (`npm run eval`): runs the 10 controlled synthetic cases from
 * PROJECT_CONTEXT §11 through the real services and agent (rules engine) on a throwaway database,
 * checks each against its expected outcome, and reports the metrics honestly. Time passing
 * (e.g. "48 hours later") is simulated by moving timestamps back. Not a clinical validation.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.resolve(here, '../../EVAL_RESULTS.md');
const HOUR = 60 * 60 * 1000;

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
Object.assign(process.env, {
  NODE_ENV: 'development',
  MONGODB_URI: replSet.getUri(),
  MONGODB_DB_NAME: 'careloop_eval',
  VOICE_MOCK_MODE: 'true',
  PLANPILOT_LLM_PROVIDER: 'none'
});

const quietLog = console.log;
console.log = () => {};

const { connectDb, closeDb, getDb } = await import('../src/config/db.js');
const { initAllIndexes } = await import('../src/config/indexes.js');
const { seedClinician } = await import('../src/scripts/seedUsers.js');
const { seedProvidersAndSchedules } = await import('../src/scripts/seedAppointments.js');
const { seedDirectory } = await import('../src/scripts/seedDirectory.js');
const { createPatientRecord } = await import('../src/repositories/patient.repository.js');
const { listCareTasksByPlan, findCareTaskById } = await import('../src/repositories/careTask.repository.js');
const { listBarriersByPlan } = await import('../src/repositories/barrier.repository.js');
const { listApprovalsByTask } = await import('../src/repositories/approval.repository.js');
const { createVoiceCall } = await import('../src/repositories/voiceCall.repository.js');
const { createCarePlan, transitionTask } = await import('../src/services/carePlan.service.js');
const { runAgentForPlan } = await import('../src/services/orchestrator.service.js');
const { respondAsPatient, decideAsClinician } = await import('../src/services/approval.service.js');
const { submitDocument, reviewDocumentSubmission } = await import('../src/services/documentSubmission.service.js');
const { reportBarrier } = await import('../src/services/feasibility.service.js');
const { requiredEvidenceFor, EVIDENCE_TYPES } = await import('../src/services/taskStateMachine.js');
const { armFault, clearFaults } = await import('../src/utils/faults.js');

await connectDb();
await initAllIndexes();
const clinicianUser = await seedClinician();
await seedProvidersAndSchedules();
await seedDirectory();
console.log = quietLog;

const CLINICIAN = { type: 'clinician', id: clinicianUser._id, name: clinicianUser.name };
const PDF = Buffer.from('%PDF-1.4\n% synthetic eval document\n%%EOF\n').toString('base64');
let phoneSeq = 200;

// ---------- helpers ----------

async function patient(name, { constraints, location, phone = true }) {
  return createPatientRecord({
    name,
    phone: phone ? `+1555010${String(phoneSeq++).padStart(4, '0')}` : null,
    constraints,
    location,
    isSynthetic: true
  });
}

async function plan(patientRecord, tasks) {
  const detail = await createCarePlan({
    patientId: patientRecord._id,
    title: `Eval plan for ${patientRecord.name}`,
    sourceText: 'Synthetic evaluation plan.',
    tasks,
    actor: CLINICIAN
  });
  return detail.plan._id;
}

async function planFromTemplate(patientRecord) {
  return (await createCarePlan({ patientId: patientRecord._id, templateId: 'post-discharge-chest-pain', actor: CLINICIAN })).plan._id;
}

const task = (key, type, title, requirement, extra = {}) => ({
  key, type, title, clinicalInstruction: `${title} (synthetic instruction).`, owner: 'patient', dueInDays: 3, dependsOn: [], serviceRequirement: requirement, ...extra
});
const GP_AT = (code) => ({ category: 'clinic', specialty: 'General Practice', facilityCode: code });
const LAB_AT = (code, service) => ({ category: 'lab', service, facilityCode: code });

async function tasksByKey(planId) {
  return Object.fromEntries((await listCareTasksByPlan(planId)).map(t => [t.key, t]));
}

async function agent(planId, ctx) {
  const run = await runAgentForPlan({ planId, trigger: 'eval' });
  ctx.runs.push(run);
  return run;
}

function stepsFor(ctx, taskId) {
  return ctx.runs.flatMap(r => r.steps).filter(s => s.taskId === taskId);
}

async function detectedCodes(planId, taskId) {
  return [...new Set((await listBarriersByPlan(planId)).filter(b => b.taskId === taskId).map(b => b.code))];
}

async function openApproval(taskId) {
  return (await listApprovalsByTask(taskId)).find(a => a.isOpen) || null;
}

async function patientConfirms(approval, record, ctx) {
  ctx.humanActions++;
  return respondAsPatient({ approvalId: approval._id, decision: 'confirm', actor: { type: 'patient', id: null, name: `${record.name} (eval)` }, patientRecordId: record._id });
}

async function age(taskId, { taskHours = 0, checkHours = 0 } = {}) {
  const db = getDb();
  const { ObjectId } = await import('mongodb');
  const id = new ObjectId(taskId);
  if (taskHours) {
    const current = await db.collection('care_tasks').findOne({ _id: id });
    await db.collection('care_tasks').updateOne({ _id: id }, { $set: { updatedAt: new Date(current.updatedAt.getTime() - taskHours * HOUR) } });
  }
  if (checkHours) {
    await db.collection('task_events').updateMany({ taskId: id }, [{ $set: { at: { $subtract: ['$at', checkHours * HOUR] } } }]);
  }
}

const SUNDARPUR_NO_CAR = { constraints: { hasOwnTransport: false, maxTravelKm: 5, documentsHeld: ['aadhaar'] }, location: { label: 'Sundarpur village', x: 14, y: 6 } };
const TOWN_WITH_CAR = { constraints: { hasOwnTransport: true, maxTravelKm: 30, documentsHeld: ['aadhaar', 'discharge_summary'] }, location: { label: 'District town', x: 3, y: 2 } };

// ---------- the 10 cases ----------

const CASES = [
  {
    name: 'Fully feasible plan',
    planted: [],
    expectsHuman: false,
    recoverable: false,
    async run(ctx) {
      const record = await patient('Eval Feasible', TOWN_WITH_CAR);
      const planId = await planFromTemplate(record);
      await agent(planId, ctx);
      let t = await tasksByKey(planId);
      const approval = await openApproval(t.book_followup._id);
      if (approval) await patientConfirms(approval, record, ctx);
      t = await tasksByKey(planId);
      const barriers = (await listBarriersByPlan(planId)).length;
      return {
        planId,
        taskId: t.book_followup._id,
        detected: await detectedCodes(planId, t.book_followup._id),
        observed: `${barriers} barrier(s); booking task ${t.book_followup.status}; lab ${t.lipid_test.status}`,
        pass: barriers === 0 && t.book_followup.status === 'completed_with_evidence' && t.lipid_test.status === 'requested'
      };
    }
  },
  {
    name: 'Transport barrier',
    planted: ['TRANSPORT'],
    expectsHuman: false,
    recoverable: true,
    async run(ctx) {
      const record = await patient('Eval Transport', SUNDARPUR_NO_CAR);
      const planId = await plan(record, [task('book_visit', 'appointment_booking', 'Book GP follow-up', GP_AT('CARELOOP-DISTRICT'))]);
      await agent(planId, ctx);
      let t = await tasksByKey(planId);
      const approval = await openApproval(t.book_visit._id);
      if (approval) await patientConfirms(approval, record, ctx);
      t = await tasksByKey(planId);
      return {
        planId,
        taskId: t.book_visit._id,
        detected: await detectedCodes(planId, t.book_visit._id),
        recovered: t.book_visit.status === 'completed_with_evidence',
        observed: `chose ${approval?.action.facility?.name || 'nothing'}; task ${t.book_visit.status}`,
        pass: t.book_visit.status === 'completed_with_evidence' && t.book_visit.serviceRequirement.facilityCode === 'PHC-SUNDARPUR'
      };
    }
  },
  {
    name: 'Unavailable service',
    planted: ['SERVICE_UNAVAILABLE'],
    expectsHuman: false,
    recoverable: true,
    async run(ctx) {
      const record = await patient('Eval Service', SUNDARPUR_NO_CAR);
      const planId = await plan(record, [task('hba1c', 'lab_test', 'HbA1c blood test', LAB_AT('LAB-SUNDARPUR', 'hba1c'), { dueInDays: 6 })]);
      await agent(planId, ctx);
      let t = await tasksByKey(planId);
      const approval = await openApproval(t.hba1c._id);
      if (approval) await patientConfirms(approval, record, ctx);
      t = await tasksByKey(planId);
      return {
        planId,
        taskId: t.hba1c._id,
        detected: await detectedCodes(planId, t.hba1c._id),
        recovered: t.hba1c.status === 'requested',
        observed: `moved to ${t.hba1c.serviceRequirement.facilityCode}; task ${t.hba1c.status}`,
        pass: t.hba1c.status === 'requested' && t.hba1c.serviceRequirement.facilityCode !== 'LAB-SUNDARPUR'
      };
    }
  },
  {
    name: 'Missing document',
    planted: ['MISSING_DOCUMENT'],
    expectsHuman: false,
    recoverable: true,
    async run(ctx) {
      const record = await patient('Eval Document', { ...SUNDARPUR_NO_CAR });
      const planId = await plan(record, [task('summary', 'document_submission', 'Share discharge summary', { category: 'document', document: 'discharge_summary' }, { dueInDays: 6 })]);
      await agent(planId, ctx);
      let t = await tasksByKey(planId);
      const requested = t.summary.status === 'requested';
      const submission = await submitDocument({ taskId: t.summary._id, fileName: 'summary.pdf', mimeType: 'application/pdf', contentBase64: PDF, actor: { type: 'patient', id: null, name: 'eval' }, patientRecordId: record._id });
      ctx.humanActions++;
      await reviewDocumentSubmission({ submissionId: submission._id, decision: 'verify', note: 'eval', actor: CLINICIAN });
      t = await tasksByKey(planId);
      return {
        planId,
        taskId: t.summary._id,
        detected: await detectedCodes(planId, t.summary._id),
        recovered: t.summary.status === 'completed_with_evidence',
        observed: `agent requested the document: ${requested}; after clinician verified the upload: ${t.summary.status}`,
        pass: requested && t.summary.status === 'completed_with_evidence'
      };
    }
  },
  {
    name: 'Unconfirmed request (48 h later)',
    planted: ['UNCONFIRMED'],
    expectsHuman: false,
    recoverable: true,
    async run(ctx) {
      const record = await patient('Eval Unconfirmed', TOWN_WITH_CAR);
      const planId = await plan(record, [task('lab', 'lab_test', 'Lipid profile', LAB_AT('LAB-DISTRICT', 'lipid_profile'), { dueInDays: 10 })]);
      await agent(planId, ctx);
      let t = await tasksByKey(planId);
      const firstStatus = t.lab.status;
      await age(t.lab._id, { taskHours: 50, checkHours: 13 });
      await agent(planId, ctx);
      t = await tasksByKey(planId);
      const handled = (await listApprovalsByTask(t.lab._id)).some(a => a.status === 'executed' && a.action.kind === 'follow_up_confirmation');
      return {
        planId,
        taskId: t.lab._id,
        detected: await detectedCodes(planId, t.lab._id),
        recovered: handled && t.lab.status === 'requested',
        observed: `first run: ${firstStatus}; after 50 h: follow-up sent ${handled}, task ${t.lab.status}`,
        pass: firstStatus === 'requested' && handled && t.lab.status === 'requested'
      };
    }
  },
  {
    name: 'Failed patient contact',
    planted: ['NO_RESPONSE'],
    expectsHuman: true,
    recoverable: false,
    async run(ctx) {
      const record = await patient('Eval Unreachable', { ...TOWN_WITH_CAR, constraints: { ...TOWN_WITH_CAR.constraints, caregiverName: 'Asha (daughter)' } });
      for (let i = 0; i < 2; i++) {
        await createVoiceCall({ callSid: `EVAL-${record._id}-${i}`, from: 'CareLoop', to: record.phone, direction: 'outbound', status: 'no-answer', isMock: true });
      }
      const planId = await plan(record, [task('book_visit', 'appointment_booking', 'Book GP follow-up', GP_AT('CARELOOP-DISTRICT'))]);
      await agent(planId, ctx);
      const t = await tasksByKey(planId);
      const approval = await openApproval(t.book_visit._id);
      const human = approval?.status === 'pending_clinician' || t.book_visit.status === 'escalated';
      return {
        planId,
        taskId: t.book_visit._id,
        detected: await detectedCodes(planId, t.book_visit._id),
        human,
        observed: approval ? `${approval.description} → ${approval.status}` : `task ${t.book_visit.status}`,
        pass: human && approval?.action.kind === 'contact_caregiver'
      };
    }
  },
  {
    name: 'Conflicting source document',
    planted: [],
    expectsHuman: true,
    recoverable: false,
    async run(ctx) {
      const record = await patient('Eval Conflict', TOWN_WITH_CAR);
      const planId = await plan(record, [task('visit', 'follow_up_visit', 'Attend GP follow-up', GP_AT('CARELOOP-DISTRICT'), { dueInDays: 7 })]);
      let t = await tasksByKey(planId);
      await reportBarrier({
        taskId: t.visit._id,
        code: 'OTHER',
        detail: 'My discharge letter says to stop the blood thinner but this plan says continue it.',
        actor: { type: 'patient', id: null, name: 'eval patient' }
      });
      await agent(planId, ctx);
      t = await tasksByKey(planId);
      const agentActed = stepsFor(ctx, t.visit._id).length;
      return {
        planId,
        taskId: t.visit._id,
        detected: [],
        human: t.visit.status === 'escalated',
        observed: `task ${t.visit.status}; agent actions afterwards: ${agentActed}`,
        pass: t.visit.status === 'escalated' && agentActed === 0
      };
    }
  },
  {
    name: 'Needs clinician approval (teleconsult)',
    planted: ['TRANSPORT'],
    expectsHuman: true,
    recoverable: true,
    async run(ctx) {
      const record = await patient('Eval Teleconsult', { constraints: { hasOwnTransport: false, maxTravelKm: 3, documentsHeld: [] }, location: { label: 'Keshavganj outskirts', x: -7, y: -9 } });
      const planId = await plan(record, [task('book_visit', 'appointment_booking', 'Book GP follow-up', GP_AT('CARELOOP-DISTRICT'))]);
      await agent(planId, ctx);
      let t = await tasksByKey(planId);
      const approval = await openApproval(t.book_visit._id);
      const waitedForClinician = approval?.status === 'pending_clinician';
      if (waitedForClinician) {
        ctx.humanActions++;
        await decideAsClinician({ approvalId: approval._id, decision: 'approve', note: 'eval', actor: CLINICIAN });
        await patientConfirms(approval, record, ctx);
      }
      t = await tasksByKey(planId);
      return {
        planId,
        taskId: t.book_visit._id,
        detected: await detectedCodes(planId, t.book_visit._id),
        human: waitedForClinician,
        recovered: t.book_visit.status === 'completed_with_evidence',
        observed: `agent waited for clinician: ${waitedForClinician}; after approval + confirmation: ${t.book_visit.status}`,
        pass: waitedForClinician && t.book_visit.status === 'completed_with_evidence'
      };
    }
  },
  {
    name: 'Tool failure (directory down twice)',
    planted: [],
    expectsHuman: false,
    recoverable: true,
    async run(ctx) {
      const record = await patient('Eval Outage', TOWN_WITH_CAR);
      const planId = await plan(record, [task('lab', 'lab_test', 'Lipid profile', LAB_AT('LAB-DISTRICT', 'lipid_profile'), { dueInDays: 10 })]);
      armFault('directory', { times: 2 });
      await agent(planId, ctx);
      clearFaults();
      const t = await tasksByKey(planId);
      const check = stepsFor(ctx, t.lab._id).find(s => s.kind === 'run_feasibility_check');
      return {
        planId,
        taskId: t.lab._id,
        detected: [],
        recovered: check?.outcome === 'done' && t.lab.status === 'requested',
        observed: `check succeeded after ${check?.attempts} attempts; task ${t.lab.status}`,
        pass: check?.outcome === 'done' && check.attempts === 3 && t.lab.status === 'requested'
      };
    }
  },
  {
    name: 'Looks done but lacks evidence',
    planted: [],
    expectsHuman: false,
    recoverable: false,
    async run(ctx) {
      const record = await patient('Eval NoEvidence', TOWN_WITH_CAR);
      const planId = await plan(record, [task('visit', 'follow_up_visit', 'Attend GP follow-up', GP_AT('CARELOOP-DISTRICT'), { dueInDays: 1 })]);
      await agent(planId, ctx);
      let t = await tasksByKey(planId);
      let agentCompletionRefused = false;
      try {
        await transitionTask({ taskId: t.visit._id, to: 'completed_with_evidence', actor: { type: 'agent', id: null, name: 'eval' } });
      } catch (err) {
        agentCompletionRefused = err.code === 'ACTOR_NOT_ALLOWED';
      }
      const { ObjectId } = await import('mongodb');
      await getDb().collection('care_tasks').updateOne({ _id: new ObjectId(t.visit._id) }, { $set: { dueAt: new Date(Date.now() - 72 * HOUR) } });
      await agent(planId, ctx);
      t = await tasksByKey(planId);
      return {
        planId,
        taskId: t.visit._id,
        detected: [],
        observed: `agent completion refused: ${agentCompletionRefused}; 3 days overdue without evidence → ${t.visit.status}`,
        pass: agentCompletionRefused && t.visit.status === 'unable_to_verify'
      };
    }
  }
];

// ---------- run and measure ----------

const results = [];
for (const testCase of CASES) {
  const ctx = { runs: [], humanActions: 0 };
  let outcome;
  try {
    outcome = await testCase.run(ctx);
  } catch (err) {
    outcome = { observed: `ERROR: ${err.message}`, pass: false, detected: [] };
  }
  const task = outcome.taskId ? await findCareTaskById(outcome.taskId) : null;
  const escalated = task?.status === 'escalated';
  const clinicianApproval = outcome.taskId ? (await listApprovalsByTask(outcome.taskId)).some(a => a.requires?.clinician) : false;
  results.push({
    ...testCase,
    ...outcome,
    agentSteps: outcome.taskId ? stepsFor(ctx, outcome.taskId).length : 0,
    humanActions: ctx.humanActions,
    escalatedOrClinician: escalated || clinicianApproval
  });
}

const db = getDb();
const completed = await db.collection('care_tasks').find({ status: 'completed_with_evidence' }).toArray();
let completedWithoutEvidence = 0;
for (const t of completed) {
  const types = new Set((await db.collection('evidence').find({ taskId: t._id }).toArray()).map(e => e.type));
  const evidence = await db.collection('evidence').find({ taskId: t._id }).toArray();
  const allowed = evidence.every(e => EVIDENCE_TYPES[e.type].recordableBy.includes(e.recordedBy.type));
  if (!requiredEvidenceFor(t.type).every(type => types.has(type)) || !allowed) completedWithoutEvidence++;
}

const allTasks = await db.collection('care_tasks').find({}).toArray();
let inconsistentTrails = 0;
for (const t of allTasks) {
  const events = await db.collection('task_events').find({ taskId: t._id, kind: { $in: ['created', 'transition'] } }).sort({ at: 1, _id: 1 }).toArray();
  let status = events[0]?.to;
  let ok = events[0]?.kind === 'created';
  for (const e of events.slice(1)) {
    if (e.from !== status) ok = false;
    status = e.to;
  }
  if (!ok || status !== t.status) inconsistentTrails++;
}

const planted = results.flatMap(r => r.planted.map(code => ({ code, found: (r.detected || []).includes(code) })));
const recoverable = results.filter(r => r.recoverable);
const humanExpected = results.filter(r => r.expectsHuman);
const humanNotExpected = results.filter(r => !r.expectsHuman);
const recoveredSteps = recoverable.filter(r => r.recovered).map(r => r.agentSteps);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');

const metrics = [
  ['Cases passing their expected outcome', `${results.filter(r => r.pass).length}/${results.length}`],
  ['Blocker detection (planted blockers found)', `${planted.filter(p => p.found).length}/${planted.length} (${pct(planted.filter(p => p.found).length, planted.length)})`],
  ['Recovery success (recoverable cases recovered)', `${recoverable.filter(r => r.recovered).length}/${recoverable.length} (${pct(recoverable.filter(r => r.recovered).length, recoverable.length)})`],
  ['False completion rate (completed without required evidence)', `${completedWithoutEvidence}/${completed.length} (${pct(completedWithoutEvidence, completed.length)})`],
  ['Escalation correctness (human involved where required)', `${humanExpected.filter(r => r.human).length}/${humanExpected.length}`],
  ['Unnecessary escalations (human involved where not required)', `${humanNotExpected.filter(r => r.escalatedOrClinician).length}/${humanNotExpected.length}`],
  ['Task-state consistency (audit trails that replay exactly)', `${allTasks.length - inconsistentTrails}/${allTasks.length}`],
  ['Agent steps to recover (average, recovered cases)', recoveredSteps.length ? (recoveredSteps.reduce((a, b) => a + b, 0) / recoveredSteps.length).toFixed(1) : 'n/a'],
  ['Human actions needed (patient replies, approvals, verifications)', String(results.reduce((sum, r) => sum + r.humanActions, 0))]
];

const lines = [];
lines.push('# PlanPilot evaluation results', '');
lines.push(`Generated by \`npm run eval\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, rules engine, synthetic data only.`);
lines.push('These are results of controlled synthetic cases (PROJECT_CONTEXT §11), not a clinical validation.', '');
lines.push('## Cases', '', '| # | Case | Expected human? | Observed | Result |', '|---|---|---|---|---|');
results.forEach((r, i) => lines.push(`| ${i + 1} | ${r.name} | ${r.expectsHuman ? 'yes' : 'no'} | ${r.observed} | ${r.pass ? 'PASS' : 'FAIL'} |`));
lines.push('', '## Metrics', '', '| Metric | Result |', '|---|---|');
metrics.forEach(([name, value]) => lines.push(`| ${name} | ${value} |`));
lines.push('');
const report = lines.join('\n');

writeFileSync(reportPath, report);
quietLog(report);
quietLog(`\nSaved to ${reportPath}`);

await closeDb();
await replSet.stop();
process.exit(0);
