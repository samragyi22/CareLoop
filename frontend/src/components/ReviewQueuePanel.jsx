import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import {
  ShieldCheck,
  FileText,
  Siren,
  HelpCircle,
  FileCheck2,
  Hourglass,
  XCircle,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  ArrowRight,
  PhoneCall
} from 'lucide-react';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function age(hours) {
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Section({ icon: Icon, title, count, tone, hint, children }) {
  const tones = {
    violet: 'text-violet-700',
    rose: 'text-rose-700',
    orange: 'text-orange-700',
    teal: 'text-teal-700',
    sky: 'text-sky-700',
    slate: 'text-slate-600'
  };
  return (
    <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-3 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-3">
        <h3 className={`text-xs font-semibold flex items-center gap-2 ${tones[tone]}`}>
          <Icon className="w-4 h-4" />
          <span>{title} ({count})</span>
        </h3>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {count === 0 ? <p className="text-center py-4 text-xs text-slate-500">Nothing here.</p> : <div className="space-y-2">{children}</div>}
    </div>
  );
}

function Who({ item, onOpenPlan }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-600">
      <span className="text-slate-800 font-semibold">{item.patient?.name}</span>
      {item.patient?.isSynthetic && <span className="text-[9px] font-mono text-amber-700">SYNTHETIC</span>}
      <span>&bull;</span>
      <span>{item.task.title}</span>
      <button onClick={() => onOpenPlan(item.plan._id)} className="inline-flex items-center gap-0.5 text-teal-600 hover:text-teal-700 cursor-pointer">
        Open plan <ArrowRight className="w-3 h-3" />
      </button>
    </div>
  );
}

function InlineForm({ placeholder, required, submitLabel, busy, onSubmit, onCancel, children }) {
  const [note, setNote] = useState('');
  const disabled = busy || (required && note.trim().length < 3);
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (!disabled) onSubmit(note.trim()); }}
      className="flex flex-col sm:flex-row gap-2 text-[11px]"
    >
      {children}
      <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={placeholder} className="flex-1 p-1.5 bg-white border border-slate-200 rounded-lg text-slate-900" />
      <button type="submit" disabled={disabled} className="px-3 py-1 rounded-lg bg-slate-100 border border-slate-300 text-slate-800 font-semibold disabled:opacity-50 cursor-pointer">{submitLabel}</button>
      <button type="button" onClick={onCancel} className="px-3 py-1 rounded-lg text-slate-600 cursor-pointer">Cancel</button>
    </form>
  );
}

/**
 * Everything PlanPilot is waiting on a person for, built live from the server.
 * Clinician-only items are counted in the badge; items waiting on patients are shown for context.
 */
export default function ReviewQueuePanel({ onOpenPlan, onChanged, onCount }) {
  const [queue, setQueue] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openForm, setOpenForm] = useState(null); // { id, mode }
  const [patientDecision, setPatientDecision] = useState('confirm');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getReviewQueue();
      setQueue(res.data);
      onCount?.(res.data.actionRequired);
    } catch (err) {
      setError(err.message || 'Failed to load the review queue.');
    } finally {
      setLoading(false);
    }
  }, [onCount]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (action, message) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await action();
      const data = res?.data || {};
      if (data.failure) setError(data.failure.message);
      else setNotice(typeof message === 'function' ? message(data) : message);
      setOpenForm(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message || 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const isOpen = (id, mode) => openForm?.id === id && openForm?.mode === mode;

  if (!queue) {
    return (
      <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-xs text-slate-600 shadow-sm">
        {error || 'Loading the review queue...'}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600">
          <span className="text-slate-900 font-semibold">{queue.actionRequired}</span> item(s) need a clinician. PlanPilot never approves, verifies, or completes these on its own.
        </p>
        <button onClick={load} className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 cursor-pointer" title="Refresh">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-50 border border-rose-300 text-rose-700 text-xs flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-700 text-xs flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /><span>{notice}</span>
        </div>
      )}

      {queue.healthAlerts?.length > 0 && (
        <Section icon={Siren} title="Phone health checks: urgent, emergency, or call back" count={queue.healthAlerts.length} tone="rose" hint="Review these in Health Calls">
          {queue.healthAlerts.map(alert => (
            <div key={alert._id} className="p-3 rounded-xl bg-rose-50 border border-rose-200 space-y-1 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900">{alert.callerName || 'Unknown caller'}</span>
                <span className="text-slate-500">{alert.phone ? `${alert.phone.slice(0, 3)}••••${alert.phone.slice(-4)}` : ''}</span>
                <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${alert.careLevel === 'emergency' ? 'bg-rose-100 text-rose-800 border-rose-300' : 'bg-amber-50 text-amber-800 border-amber-300'}`}>{alert.careLevelLabel}</span>
              </div>
              {alert.reported?.symptoms && <div className="text-slate-800">“{alert.reported.symptoms}”</div>}
              <div className="text-slate-600">{alert.reason}{alert.appointment ? ` Booked ${alert.appointment.bookingReference}.` : ''}</div>
            </div>
          ))}
        </Section>
      )}

      <Section icon={ShieldCheck} title="Options needing your approval" count={queue.needsClinician.length} tone="violet" hint="Changes to how or when care happens">
        {queue.needsClinician.map(item => (
          <div key={item.approvalId} className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 text-xs">
            <Who item={item} onOpenPlan={onOpenPlan} />
            <div className="text-slate-900 font-semibold">{item.description}</div>
            {item.approvalReason && <div className="text-[11px] text-violet-700">{item.approvalReason}</div>}
            <div className="text-[11px] text-slate-500">{item.rationale} &bull; chosen by {item.requestedBy?.name || item.requestedBy?.type}, {age(item.ageHours)}</div>
            {isOpen(item.approvalId, 'approve') && (
              <InlineForm placeholder="Note (optional)" submitLabel="Approve" busy={busy} onCancel={() => setOpenForm(null)}
                onSubmit={(note) => act(() => api.decideApproval(item.approvalId, { decision: 'approve', note }),
                  (d) => d.executed ? 'Approved and carried out.' : 'Approved. Waiting for the patient to confirm.')} />
            )}
            {isOpen(item.approvalId, 'reject') && (
              <InlineForm placeholder="Why is this not appropriate?" required submitLabel="Reject" busy={busy} onCancel={() => setOpenForm(null)}
                onSubmit={(note) => act(() => api.decideApproval(item.approvalId, { decision: 'reject', note }), 'Rejected. The task is back to Blocked.')} />
            )}
            {!openForm || openForm.id !== item.approvalId ? (
              <div className="flex gap-1.5">
                <button onClick={() => setOpenForm({ id: item.approvalId, mode: 'approve' })} disabled={busy} className="px-2.5 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-semibold disabled:opacity-50 cursor-pointer">Approve</button>
                <button onClick={() => setOpenForm({ id: item.approvalId, mode: 'reject' })} disabled={busy} className="px-2.5 py-1 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-[11px] disabled:opacity-50 cursor-pointer">Reject</button>
              </div>
            ) : null}
          </div>
        ))}
      </Section>

      <Section icon={FileText} title="Documents to verify" count={queue.documents.length} tone="violet" hint="An upload is not evidence until you verify it">
        {queue.documents.map(item => (
          <div key={item.submissionId} className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 text-xs">
            <Who item={item} onOpenPlan={onOpenPlan} />
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <a href={api.documentFileUrl(item.submissionId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-teal-700 hover:text-teal-800">
                {item.fileName} <ExternalLink className="w-3 h-3" />
              </a>
              <span className="text-slate-500">{Math.ceil(item.sizeBytes / 1024)} KB &bull; from {item.submittedBy?.type === 'patient' ? 'the patient' : item.submittedBy?.name} &bull; {age(item.ageHours)}</span>
            </div>
            {isOpen(item.submissionId, 'verify') && (
              <InlineForm placeholder="Note (optional)" submitLabel="Verify" busy={busy} onCancel={() => setOpenForm(null)}
                onSubmit={(note) => act(() => api.reviewDocument(item.submissionId, { decision: 'verify', note }),
                  (d) => `Document verified.${d.completed ? ' The task is completed with evidence.' : ''}`)} />
            )}
            {isOpen(item.submissionId, 'reject') && (
              <InlineForm placeholder="What is wrong? The patient will see this." required submitLabel="Not accepted" busy={busy} onCancel={() => setOpenForm(null)}
                onSubmit={(note) => act(() => api.reviewDocument(item.submissionId, { decision: 'reject', note }), 'Marked not accepted. The patient will be asked again.')} />
            )}
            {(!openForm || openForm.id !== item.submissionId) && (
              <div className="flex gap-1.5">
                <button onClick={() => setOpenForm({ id: item.submissionId, mode: 'verify' })} disabled={busy} className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold disabled:opacity-50 cursor-pointer">Verify</button>
                <button onClick={() => setOpenForm({ id: item.submissionId, mode: 'reject' })} disabled={busy} className="px-2.5 py-1 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-[11px] disabled:opacity-50 cursor-pointer">Not accepted</button>
              </div>
            )}
          </div>
        ))}
      </Section>

      <Section icon={Siren} title="Escalated to a clinician" count={queue.escalated.length} tone="rose">
        {queue.escalated.map(item => (
          <div key={item.task._id} className="p-3 rounded-xl bg-rose-50 border border-rose-200 space-y-1 text-xs">
            <Who item={item} onOpenPlan={onOpenPlan} />
            <div className="text-rose-800">{item.reason || 'No reason recorded.'}</div>
            <div className="text-[11px] text-slate-500">Since {formatDate(item.since)} &bull; by {item.by?.name || item.by?.type}</div>
          </div>
        ))}
      </Section>

      <Section icon={HelpCircle} title="Unable to verify" count={queue.unableToVerify.length} tone="orange" hint="PlanPilot could not confirm these happened">
        {queue.unableToVerify.map(item => (
          <div key={item.task._id} className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1 text-xs">
            <Who item={item} onOpenPlan={onOpenPlan} />
            <div className="text-orange-800">{item.reason}</div>
            <div className="text-[11px] text-slate-500">Since {formatDate(item.since)}</div>
          </div>
        ))}
      </Section>

      <Section icon={FileCheck2} title="Evidence only a clinician can record" count={queue.evidenceToRecord.length} tone="teal">
        {queue.evidenceToRecord.map(item => (
          <div key={item.task._id} className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1 text-xs">
            <Who item={item} onOpenPlan={onOpenPlan} />
            <div className="text-slate-800">Missing: {item.missingEvidence.map(e => e.label).join(', ')}</div>
            <div className="text-[11px] text-slate-500">{item.why}{item.booking && <> Booking {item.booking.bookingReference}, {formatDate(item.booking.startAt)}.</>}</div>
          </div>
        ))}
      </Section>

      <Section icon={Hourglass} title="Waiting on the patient" count={queue.awaitingPatient.length} tone="sky" hint="PlanPilot phones the patient to ask; not counted above">
        {queue.awaitingPatient.map(item => (
          <div key={item.approvalId} className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 text-xs">
            <Who item={item} onOpenPlan={onOpenPlan} />
            <div className="text-slate-800">{item.description}</div>
            <div className="text-[11px] text-slate-500">Asked {age(item.ageHours)}{item.clinicianDecision && ' · already approved by a clinician'}</div>
            {isOpen(item.approvalId, 'patient') ? (
              <InlineForm placeholder='How did they answer? e.g. "Confirmed by phone"' required submitLabel="Save" busy={busy} onCancel={() => setOpenForm(null)}
                onSubmit={(note) => act(() => api.recordPatientResponse(item.approvalId, { decision: patientDecision, note }),
                  (d) => patientDecision === 'decline' ? 'Recorded: the patient declined.' : d.executed ? 'Recorded and carried out.' : 'Recorded.')}>
                <select value={patientDecision} onChange={(e) => setPatientDecision(e.target.value)} className="p-1.5 bg-white border border-slate-200 rounded-lg text-slate-900">
                  <option value="confirm">Patient confirmed</option>
                  <option value="decline">Patient declined</option>
                </select>
              </InlineForm>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => act(() => api.callPatient({ patientId: item.patient._id, approvalId: item.approvalId }),
                    (d) => d.isMock ? `Simulated call to ${d.patient} (synthetic patient).` : `PlanPilot is calling ${d.patient} now.`)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-semibold disabled:opacity-50 cursor-pointer"
                >
                  <PhoneCall className="w-3 h-3" /> Call patient now
                </button>
                <button onClick={() => { setOpenForm({ id: item.approvalId, mode: 'patient' }); setPatientDecision('confirm'); }} disabled={busy} className="px-2.5 py-1 rounded-lg border border-sky-300 text-sky-700 hover:bg-sky-50 text-[11px] disabled:opacity-50 cursor-pointer">
                  Record patient's answer
                </button>
              </div>
            )}
          </div>
        ))}
      </Section>

      {queue.recentFailures.length > 0 && (
        <Section icon={XCircle} title="Options that could not be carried out (last 72 h)" count={queue.recentFailures.length} tone="slate" hint="For awareness; PlanPilot re-checks these tasks">
          {queue.recentFailures.map(item => (
            <div key={item.approvalId} className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1 text-xs">
              <Who item={item} onOpenPlan={onOpenPlan} />
              <div className="text-slate-700">{item.description}</div>
              <div className="text-[11px] text-rose-700">{item.execution?.error}</div>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
