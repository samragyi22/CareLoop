import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startTestServer, createClient } from './helpers/testServer.js';
import { loginClinician } from './helpers/fixtures.js';
import { seedClinician } from '../src/scripts/seedUsers.js';
import { seedProvidersAndSchedules } from '../src/scripts/seedAppointments.js';
import { seedDirectory } from '../src/scripts/seedDirectory.js';
import { seedPatients } from '../src/scripts/seedPatientUsers.js';
import { seedCarePlans } from '../src/scripts/seedCarePlans.js';
import { armFault, clearFaults } from '../src/utils/faults.js';

const REJECTION_MARKER = '\n\nYour previous answer was rejected';

/**
 * A stand-in for the Gemini API. Each request takes the next scripted behaviour from `script`;
 * when the script is empty it answers sensibly, preferring a teleconsult when one is offered.
 */
function startFakeGemini() {
  const requests = [];
  const script = [];

  const answer = (res, text, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { candidates: [{ content: { parts: [{ text }] } }] } : { error: 'boom' }));
  };

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const prompt = body.contents[0].parts[0].text;
    requests.push({ url: req.url, apiKey: req.headers['x-goog-api-key'], body, prompt });

    const mode = script.shift() || 'smart';
    if (mode === 'garbage') return answer(res, 'I think the patient should go to the nearby clinic.');
    if (mode === 'forbidden') return answer(res, JSON.stringify({ actionId: 'complete_task', reason: 'Looks done to me' }));
    if (mode === 'http500') return answer(res, null, 500);
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 600));

    const { allowedActions } = JSON.parse(prompt.split(REJECTION_MARKER)[0]);
    const ids = allowedActions.map(a => a.id);
    const choice = ids.find(id => id === 'run_feasibility_check')
      || allowedActions.find(a => a.id.startsWith('choose_alternative') && a.description.includes('teleconsult'))?.id
      || ids.find(id => id.startsWith('choose_alternative'))
      || 'wait';
    return answer(res, JSON.stringify({ actionId: choice, reason: `Fake LLM chose ${choice}.` }));
  });

  return { server, requests, script };
}

describe('PlanPilot agent with an LLM: only allowed actions, and safe fallbacks', () => {
  let ctx;
  let clinician;
  let fake;
  let patients;

  const getPlan = async (planId) => (await clinician.get(`/api/care-plans/${planId}`)).data.data;
  const taskByKey = (detail, key) => detail.tasks.find(t => t.key === key);
  const planFor = async (name) => {
    const existing = (await clinician.get('/api/care-plans')).data.data.find(p => p.patient.name === name);
    if (existing) return existing._id;
    const res = await clinician.post('/api/care-plans', { patientId: patients.find(p => p.name === name)._id, templateId: 'post-discharge-chest-pain' });
    return res.data.data.plan._id;
  };
  const runAgent = async (planId) => {
    const res = await clinician.post(`/api/care-plans/${planId}/agent-run`, {});
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.data;
  };

  before(async () => {
    fake = startFakeGemini();
    fake.server.listen(0);
    await once(fake.server, 'listening');

    ctx = await startTestServer({
      envOverrides: {
        PLANPILOT_LLM_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'test-key',
        PLANPILOT_LLM_MODEL: 'test-model',
        PLANPILOT_LLM_BASE_URL: `http://127.0.0.1:${fake.server.address().port}/v1beta`,
        PLANPILOT_LLM_TIMEOUT_MS: 300
      }
    });
    await seedClinician();
    await seedProvidersAndSchedules();
    await seedDirectory();
    await seedPatients();
    await seedCarePlans();

    clinician = createClient(ctx.baseUrl);
    await loginClinician(clinician, { email: 'clinician@careloop.local', password: 'CareLoop2026!' });
    patients = (await clinician.get('/api/patients')).data.data;
  });

  after(async () => {
    clearFaults();
    Object.assign(ctx.env, { PLANPILOT_LLM_PROVIDER: 'none', GEMINI_API_KEY: '' });
    await ctx.stop();
    fake.server.close();
  });

  it('reports which decider is active', async () => {
    const meta = (await clinician.get('/api/care-plans/meta')).data.data;
    assert.match(meta.agent.decider, /gemini \(test-model\), rules as fallback/);
  });

  it('uses the LLM\'s choice when valid; unusable JSON falls back to the rules, and the fallback is logged', async () => {
    const planId = await planFor('Sunita Devi');
    fake.script.push('garbage', 'garbage');
    const run = await runAgent(planId);

    const [first, ...rest] = run.steps;
    assert.equal(first.decidedBy, 'rules');
    assert.match(first.fallbackReason, /not valid JSON/);
    assert.ok(rest.length > 0 && rest.every(s => s.decidedBy === 'llm:gemini/test-model'));

    const detail = await getPlan(planId);
    const logged = detail.events.find(e => e.kind === 'agent_decision' && e.decision.fallbackReason);
    assert.match(logged.decision.fallbackReason, /rules engine decided/);

    // The second try told the model what was wrong
    assert.ok(fake.requests[1].prompt.includes(REJECTION_MARKER.trim()));
  });

  it('the LLM\'s choice still goes through approvals: a teleconsult waits for the clinician', async () => {
    const book = taskByKey(await getPlan(await planFor('Sunita Devi')), 'book_followup');
    assert.equal(book.openApproval.action.kind, 'modality_change');
    assert.equal(book.openApproval.status, 'pending_clinician');
    assert.equal(book.status, 'awaiting_approval');
  });

  it('calls the configured model with the key, in JSON mode, without the patient\'s name', () => {
    const request = fake.requests.at(-1);
    assert.equal(request.url, '/v1beta/models/test-model:generateContent');
    assert.equal(request.apiKey, 'test-key');
    assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
    assert.match(request.body.systemInstruction.parts[0].text, /never change or second-guess/);
    assert.ok(fake.requests.every(r => !r.prompt.includes('Sunita') && !r.prompt.includes('+1555')));
  });

  it('an action that is not on the list (trying to complete the task) is refused and the rules decide', async () => {
    const planId = await planFor('Ramesh Kumar');
    fake.script.push('forbidden', 'forbidden');
    const run = await runAgent(planId);
    assert.equal(run.steps[0].decidedBy, 'rules');
    assert.match(run.steps[0].fallbackReason, /"complete_task" is not one of the allowed actions/);

    const detail = await getPlan(planId);
    assert.ok(detail.tasks.every(t => t.status !== 'completed_with_evidence'));
  });

  it('a slow answer times out and a server error is not retried forever; the rules decide', async () => {
    const planId = await planFor('Lakshmi Bai');
    fake.script.push('slow', 'http500');
    const run = await runAgent(planId);
    assert.equal(run.steps[0].decidedBy, 'rules');
    assert.match(run.steps[0].fallbackReason, /HTTP 500/);
    assert.equal(run.status, 'completed');
  });

  it('an LLM outage (injected) falls back to the rules without stopping the run', async () => {
    const planId = await planFor('Ramesh Kumar');
    const ramesh = taskByKey(await getPlan(planId), 'book_followup');
    // Give the agent something to decide: a manual barrier that clears, needing a re-check
    await clinician.post(`/api/care-tasks/${ramesh._id}/barriers`, { code: 'OTHER', detail: 'Clinic closed for a local holiday' });
    const barrier = taskByKey(await getPlan(planId), 'book_followup').barriers.find(b => !b.resolvedAt);
    await clinician.post(`/api/care-tasks/${ramesh._id}/barriers/${barrier._id}/resolve`, { resolution: 'Clinic reopened' });

    armFault('llm', { times: 2 });
    const run = await runAgent(planId);
    assert.equal(run.status, 'completed');
    // The first decision that needed the LLM hit the outage and was made by the rules instead
    const [first, ...rest] = run.steps;
    assert.equal(first.decidedBy, 'rules');
    assert.match(first.fallbackReason, /Injected failure/);
    assert.ok(rest.every(s => s.decidedBy.startsWith('llm:')), 'the LLM is used again once it recovers');
    assert.ok(run.steps.some(s => s.taskId === ramesh._id && s.kind === 'run_feasibility_check'));
  });
});
