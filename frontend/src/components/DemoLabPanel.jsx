import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import {
  FlaskConical,
  UserRound,
  PhoneMissed,
  Upload,
  MessageSquareWarning,
  Zap,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  ThumbsUp,
  ThumbsDown,
  Bot
} from 'lucide-react';

// Ready-made reports for the demo: a logistics problem, a clinical question, and an emergency
const SAMPLE_REPORTS = [
  { label: 'No bus this week', code: 'TRANSPORT', detail: 'The bus to the district town is not running this week and my son is away.' },
  { label: 'Conflicting instructions (clinical)', code: 'OTHER', detail: 'The discharge letter says to stop the blood thinner but the care plan says continue. Which is right?' },
  { label: 'Emergency words', code: 'OTHER', detail: 'She has chest pain and cannot breathe properly since morning.' }
];

const LLM_FAULTS = new Set(['llm', 'llm_garbage']);

/**
 * Demo Lab: stand-ins for what happens outside the app during a live demo (a patient replying,
 * not answering the phone, sending a document, reporting a problem), failure switches, and reset.
 * Development only; everything done here is labelled as simulated in the audit log.
 */
export default function DemoLabPanel({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [patientId, setPatientId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.getDemoStatus();
      setStatus(res.data);
      // Start on the patient with the most to act on (the demo plan's patient), not the first alphabetically
      const busiest = [...res.data.patients].sort((a, b) =>
        (b.pendingConfirmations.length * 10 + b.openTasks.length) - (a.pendingConfirmations.length * 10 + a.openTasks.length))[0];
      setPatientId(current => (current && res.data.patients.some(p => p._id === current) ? current : busiest?._id || null));
    } catch (err) {
      setNotice({ tone: 'error', text: err.message || 'Demo Lab is unavailable.' });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (action, message) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await action();
      const data = res?.data || {};
      let text = typeof message === 'function' ? message(data) : message;
      let tone = 'success';
      if (data.emergency) {
        text = `Emergency words detected: the task was escalated to a clinician immediately. ${data.emergency.instructions}`;
        tone = 'error';
      } else if (data.clinicalReview) {
        text = `Clinical content detected (${data.clinicalReview.matched.slice(0, 3).join(', ')}): the task was escalated for clinician review instead of being acted on.`;
        tone = 'warning';
      } else if (data.failure) {
        text = data.failure.message;
        tone = 'warning';
      }
      setNotice({ tone, text });
      await load();
      onChanged?.();
    } catch (err) {
      setNotice({ tone: 'error', text: err.message || 'Action failed.' });
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="p-8 rounded-2xl bg-white border border-slate-200 text-center text-xs text-slate-600 shadow-sm">{notice?.text || 'Loading the Demo Lab...'}</div>;
  }

  const patient = status.patients.find(p => p._id === patientId);
  const llmOn = status.agent.llm.configured;
  const toneStyles = {
    success: 'bg-emerald-50 border-emerald-300 text-emerald-700',
    warning: 'bg-amber-50 border-amber-300 text-amber-800',
    error: 'bg-rose-50 border-rose-300 text-rose-800'
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-amber-700" />
          <span>Demo Lab</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-semibold">SIMULATION</span>
        </h2>
        <p className="text-xs text-slate-600">
          Make things happen that would normally happen on the phone or outside the app: a patient answers, misses calls, sends a document, or something breaks. Use this for synthetic patients; real patients answer PlanPilot's calls themselves.
          Everything here is marked as simulated in the audit log. Not available in production.
        </p>
      </div>

      {notice && (
        <div className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${toneStyles[notice.tone]}`}>
          {notice.tone === 'success' ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Patient simulator */}
        <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><UserRound className="w-4 h-4 text-teal-700" /> Simulate the patient</h3>
          <div className="flex flex-wrap gap-1.5">
            {status.patients.map(p => (
              <button
                key={p._id}
                onClick={() => setPatientId(p._id)}
                className={`px-3 py-1.5 rounded-lg text-xs border cursor-pointer ${p._id === patientId ? 'bg-teal-100 border-teal-400 text-teal-800' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`}
              >
                {p.name}{!p.hasPortalLogin && ' (phone only)'}
              </button>
            ))}
          </div>

          {patient && (
            <div className="space-y-4 text-xs">
              <div className="space-y-2">
                <div className="text-slate-600 font-semibold">Options waiting for {patient.name}'s answer</div>
                {patient.pendingConfirmations.length === 0 && <p className="text-slate-500">None right now. Run the PlanPilot agent on their care plan to get one.</p>}
                {patient.pendingConfirmations.map(item => (
                  <div key={item.approvalId} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                    <div className="text-slate-800"><span className="text-slate-500">{item.taskTitle}:</span> {item.description}</div>
                    <div className="flex gap-1.5">
                      <button disabled={busy} onClick={() => act(() => api.simulatePatientReply(item.approvalId, 'confirm'), (d) => d.executed ? 'Patient said yes: booked and recorded.' : 'Patient said yes.')}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-semibold disabled:opacity-50 cursor-pointer">
                        <ThumbsUp className="w-3 h-3" /> Patient says yes
                      </button>
                      <button disabled={busy} onClick={() => act(() => api.simulatePatientReply(item.approvalId, 'decline'), 'Patient said no. The task is back to Blocked; run the agent to find another option.')}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-50 cursor-pointer">
                        <ThumbsDown className="w-3 h-3" /> Patient says no
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {patient.phone && (
                <button disabled={busy} onClick={() => act(() => api.simulateMissedCalls(patient._id, 2), `${patient.name} missed 2 calls. The next feasibility check will find them unreachable.`)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-50 cursor-pointer">
                  <PhoneMissed className="w-3.5 h-3.5" /> Patient doesn't answer 2 calls
                </button>
              )}

              <div className="space-y-2">
                <div className="text-slate-600 font-semibold">Open tasks</div>
                {patient.openTasks.length === 0 && <p className="text-slate-500">No open care-plan tasks.</p>}
                {patient.openTasks.map(task => (
                  <div key={task.taskId} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-slate-800">{task.title}</span>
                      <span className="text-[10px] text-slate-500">{task.statusLabel}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {task.type === 'document_submission' && (
                        <button disabled={busy} onClick={() => act(() => api.simulateDocumentUpload(task.taskId), 'A sample document was uploaded as the patient. Verify it in Review Required.')}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-violet-300 text-violet-700 hover:bg-violet-50 text-[11px] disabled:opacity-50 cursor-pointer">
                          <Upload className="w-3 h-3" /> Upload sample document
                        </button>
                      )}
                      {task.status !== 'escalated' && SAMPLE_REPORTS.map(sample => (
                        <button key={sample.label} disabled={busy} title={sample.detail}
                          onClick={() => act(() => api.simulatePatientReport(task.taskId, sample), `Patient reported: "${sample.detail}"`)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50 text-[11px] disabled:opacity-50 cursor-pointer">
                          <MessageSquareWarning className="w-3 h-3" /> {sample.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {/* Failure switches */}
          <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-3 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><Zap className="w-4 h-4 text-rose-700" /> Failure switches</h3>
            <p className="text-[11px] text-slate-600">Arm a failure, then run the PlanPilot agent or confirm an option. Once: it should recover by retrying. Three times: it should hand the task to a clinician.</p>
            <ul className="space-y-1.5">
              {Object.entries(status.faultPoints).map(([name, description]) => {
                const armed = status.armedFaults.find(f => f.name === name);
                const inactive = LLM_FAULTS.has(name) && !llmOn;
                return (
                  <li key={name} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <div className={inactive ? 'text-slate-500' : 'text-slate-800'}>{description}</div>
                      {armed && <div className="text-[10px] text-rose-700">Armed: next {armed.remaining} time(s)</div>}
                      {inactive && <div className="text-[10px] text-slate-500">No LLM configured, so the rules engine decides and this has no effect.</div>}
                    </div>
                    <div className="flex gap-1.5 flex-shrink-0">
                      <button disabled={busy || inactive} onClick={() => act(() => api.armDemoFault(name, 1), `Armed once: ${description}.`)}
                        className="px-2 py-1 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-[11px] disabled:opacity-40 cursor-pointer">Once</button>
                      <button disabled={busy || inactive} onClick={() => act(() => api.armDemoFault(name, 3), `Armed 3 times: ${description}.`)}
                        className="px-2 py-1 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-[11px] disabled:opacity-40 cursor-pointer">3 times</button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {status.armedFaults.length > 0 && (
              <button disabled={busy} onClick={() => act(() => api.clearDemoFaults(), 'All failure switches cleared.')} className="text-[11px] text-slate-600 hover:text-slate-800 cursor-pointer">Clear all switches</button>
            )}
          </div>

          <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-2 text-xs shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><Bot className="w-4 h-4 text-teal-700" /> Agent</h3>
            <p className="text-slate-600">Decides with: <span className="text-slate-800">{status.agent.decider}</span></p>
            <p className="text-slate-500">{status.agent.schedulerMinutes ? `Re-checks every active plan every ${status.agent.schedulerMinutes} minutes.` : 'Runs when you press "Run PlanPilot agent" on a care plan.'}</p>
          </div>

          {/* Reset */}
          <div className="rounded-2xl bg-white border border-rose-200 p-5 space-y-2 text-xs shadow-sm">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><RotateCcw className="w-4 h-4 text-rose-700" /> Reset demo data</h3>
            <p className="text-slate-600">Deletes every care plan, booking, approval, document, and log, then reloads the synthetic demo data. Logins stay the same.</p>
            {confirmReset ? (
              <div className="flex gap-2">
                <button disabled={busy} onClick={async () => { setConfirmReset(false); await act(() => api.resetDemo(), 'Demo data reset. Sunita Devi\'s care plan is back to the start.'); }}
                  className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold disabled:opacity-50 cursor-pointer">Yes, reset everything</button>
                <button onClick={() => setConfirmReset(false)} className="px-3 py-1.5 rounded-lg text-slate-600 cursor-pointer">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmReset(true)} className="px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 cursor-pointer">Reset demo data</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
