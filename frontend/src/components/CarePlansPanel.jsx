import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { readDocumentFile, ACCEPTED_DOCUMENT_TYPES } from '../utils/files';
import {
  ClipboardList,
  Plus,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Link2,
  ShieldCheck,
  FileCheck2,
  History,
  ChevronDown,
  ChevronRight,
  Lock,
  MapPin,
  Search,
  Pencil,
  Siren,
  Lightbulb,
  CalendarCheck,
  UserCheck,
  Upload,
  FileText,
  ExternalLink,
  Hourglass,
  Bot,
  Play,
  PhoneCall,
  UserPlus
} from 'lucide-react';

// Status colours: green only for evidence-backed completion, warm colours for anything needing a human
const STATUS_STYLES = {
  suggested: 'bg-slate-100 text-slate-700 border-slate-300',
  awaiting_patient: 'bg-sky-50 text-sky-700 border-sky-200',
  awaiting_approval: 'bg-violet-50 text-violet-700 border-violet-200',
  requested: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  confirmed: 'bg-teal-50 text-teal-700 border-teal-200',
  in_progress: 'bg-blue-50 text-blue-700 border-blue-200',
  completed_with_evidence: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  blocked: 'bg-amber-50 text-amber-700 border-amber-300',
  escalated: 'bg-rose-50 text-rose-700 border-rose-300',
  unable_to_verify: 'bg-orange-50 text-orange-700 border-orange-300'
};

// Moving into these needs a reason for the audit log (enforced by the server too)
const REASON_REQUIRED = new Set(['blocked', 'escalated', 'unable_to_verify']);

const OWNER_LABELS = {
  patient: 'Patient',
  clinic_staff: 'Clinic staff',
  clinician: 'Clinician',
  agent: 'PlanPilot agent'
};

const ALTERNATIVE_KIND_LABELS = {
  facility_change: 'Same service, different place',
  modality_change: 'Different way of delivering care',
  time_change: 'Later date',
  request_document: 'Get the missing document',
  follow_up_confirmation: 'Chase the confirmation',
  contact_caregiver: 'Reach the patient through a caregiver',
  escalate: 'Escalate to a clinician'
};

const APPROVAL_STYLES = {
  pending_clinician: 'bg-violet-50 text-violet-700 border-violet-300',
  pending_patient: 'bg-sky-50 text-sky-700 border-sky-300',
  approved: 'bg-teal-50 text-teal-700 border-teal-300',
  executing: 'bg-teal-50 text-teal-700 border-teal-300',
  executed: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  rejected: 'bg-rose-50 text-rose-700 border-rose-300',
  declined: 'bg-amber-50 text-amber-700 border-amber-300',
  failed: 'bg-rose-50 text-rose-700 border-rose-300',
  cancelled: 'bg-slate-100 text-slate-600 border-slate-300'
};

// Home areas on the simulated district map (see the service directory)
const HOME_AREAS = [
  { label: 'Sundarpur village', x: 14, y: 6 },
  { label: 'District town', x: 3, y: 2 },
  { label: 'Keshavganj outskirts', x: -7, y: -9 }
];

const NOTICE_STYLES = {
  success: 'bg-emerald-50 border-emerald-300 text-emerald-700',
  danger: 'bg-rose-100 border-rose-400 text-rose-800'
};

function formatDate(value, withTime = false) {
  if (!value) return '—';
  return new Date(value).toLocaleString([], withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' });
}

function formatTimeOption(time, timesAre) {
  const start = new Date(time.startAt);
  const day = start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (timesAre === 'opening_hours') {
    return `${day}, open ${clock(start)}–${clock(new Date(time.endAt))}`;
  }
  return `${day}, ${clock(start)}${time.providerName ? ` · ${time.providerName}` : ''}`;
}

function StatusBadge({ status, label }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${STATUS_STYLES[status] || STATUS_STYLES.suggested}`}>
      {label || status}
    </span>
  );
}

function SimulatedTag() {
  return <span className="text-[9px] font-mono text-amber-700">SIMULATED</span>;
}

function ProgressBar({ progress }) {
  const pct = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-[10px] text-slate-600">
        <span>{progress.completed}/{progress.total} completed with evidence</span>
        {progress.blocked > 0 && <span className="text-amber-700">{progress.blocked} blocked</span>}
        {progress.escalated > 0 && <span className="text-rose-700">{progress.escalated} escalated</span>}
        {progress.unableToVerify > 0 && <span className="text-orange-700">{progress.unableToVerify} unverified</span>}
        {progress.openBarriers > 0 && <span className="text-amber-700">{progress.openBarriers} open barrier(s)</span>}
        {progress.openApprovals > 0 && <span className="text-sky-700">{progress.openApprovals} waiting for approval</span>}
        {progress.documentsToReview > 0 && <span className="text-violet-700">{progress.documentsToReview} document(s) to verify</span>}
      </div>
    </div>
  );
}

function PatientLogistics({ patient, meta, busy, onSave }) {
  const [form, setForm] = useState(null);
  const constraints = patient?.constraints || {};
  const documentLabels = meta?.documentLabels || {};
  const docName = (code) => documentLabels[code] || code;

  if (!patient) return null;

  const startEditing = () => setForm({
    hasOwnTransport: Boolean(constraints.hasOwnTransport),
    maxTravelKm: constraints.maxTravelKm ?? 10,
    documentsHeld: [...(constraints.documentsHeld || [])],
    caregiverName: constraints.caregiverName || ''
  });

  const toggleDocument = (code) => setForm(f => ({
    ...f,
    documentsHeld: f.documentsHeld.includes(code) ? f.documentsHeld.filter(d => d !== code) : [...f.documentsHeld, code]
  }));

  const save = (e) => {
    e.preventDefault();
    onSave(patient._id, { ...form, maxTravelKm: Number(form.maxTravelKm), caregiverName: form.caregiverName.trim() || null });
    setForm(null);
  };

  if (!form) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-slate-500">Logistics:</span>
        {patient.location && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">Lives in {patient.location.label}</span>}
        <span className={`px-1.5 py-0.5 rounded ${constraints.hasOwnTransport ? 'bg-slate-100 text-slate-700' : 'bg-amber-50 text-amber-700'}`}>
          {constraints.hasOwnTransport ? 'Has own transport' : 'No own transport'}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">Can travel up to {constraints.maxTravelKm} km</span>
        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
          Documents: {constraints.documentsHeld?.length ? constraints.documentsHeld.map(docName).join(', ') : 'none'}
        </span>
        {constraints.caregiverName && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">Caregiver: {constraints.caregiverName}</span>}
        <button onClick={startEditing} className="inline-flex items-center gap-1 text-teal-600 hover:text-teal-700 cursor-pointer">
          <Pencil className="w-3 h-3" /> Edit
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-slate-700 cursor-pointer">
          <input type="checkbox" checked={form.hasOwnTransport} onChange={(e) => setForm(f => ({ ...f, hasOwnTransport: e.target.checked }))} />
          Has own transport
        </label>
        <label className="flex items-center gap-1.5 text-slate-700">
          Can travel up to
          <input type="number" min="0" max="500" value={form.maxTravelKm} onChange={(e) => setForm(f => ({ ...f, maxTravelKm: e.target.value }))} className="w-16 p-1 bg-white border border-slate-200 rounded text-slate-900" />
          km
        </label>
        <label className="flex items-center gap-1.5 text-slate-700">
          Caregiver
          <input value={form.caregiverName} onChange={(e) => setForm(f => ({ ...f, caregiverName: e.target.value }))} placeholder="Name (relation)" className="p-1 bg-white border border-slate-200 rounded text-slate-900" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-slate-600">Documents the patient has:</span>
        {Object.keys(documentLabels).map(code => (
          <label key={code} className="flex items-center gap-1 text-slate-700 cursor-pointer">
            <input type="checkbox" checked={form.documentsHeld.includes(code)} onChange={() => toggleDocument(code)} />
            {docName(code)}
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="px-3 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-semibold disabled:opacity-50 cursor-pointer">Save</button>
        <button type="button" onClick={() => setForm(null)} className="px-3 py-1 rounded-lg text-slate-600 cursor-pointer">Cancel</button>
      </div>
    </form>
  );
}

function BarrierList({ task, busy, onResolve }) {
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  const [resolution, setResolution] = useState('');

  const open = task.barriers.filter(b => !b.resolvedAt);
  const resolved = task.barriers.filter(b => b.resolvedAt);
  if (task.barriers.length === 0) return null;

  const submit = (e, barrier) => {
    e.preventDefault();
    if (!resolution.trim()) return;
    onResolve(task, barrier, resolution.trim());
    setResolvingId(null);
  };

  return (
    <div className="space-y-1.5">
      {open.map(barrier => (
        <div
          key={barrier._id}
          className={`p-2.5 rounded-lg border text-[11px] space-y-1.5 ${barrier.emergencyFlag ? 'bg-rose-50 border-rose-400' : 'bg-amber-50 border-amber-300'}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-0.5">
              <div className={`font-semibold flex items-center gap-1.5 ${barrier.emergencyFlag ? 'text-rose-700' : 'text-amber-700'}`}>
                {barrier.emergencyFlag ? <Siren className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                <span>{barrier.label}{barrier.emergencyFlag ? ' · possible emergency' : ''}</span>
              </div>
              <div className="text-slate-700">{barrier.detail}</div>
              <div className="text-[10px] text-slate-500">
                {barrier.source === 'feasibility_check' ? 'Found by feasibility check' : `Reported by ${barrier.reportedBy?.name || barrier.reportedBy?.type}`}
                {' · '}{formatDate(barrier.detectedAt, true)}
              </div>
            </div>
            {resolvingId !== barrier._id && (
              <button
                onClick={() => { setResolvingId(barrier._id); setResolution(''); }}
                className="px-2 py-0.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 text-[10px] whitespace-nowrap cursor-pointer"
              >
                Mark resolved
              </button>
            )}
          </div>
          {resolvingId === barrier._id && (
            <form onSubmit={(e) => submit(e, barrier)} className="flex flex-col sm:flex-row gap-2">
              <input
                autoFocus
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                placeholder="How was it resolved?"
                className="flex-1 p-1.5 bg-white border border-slate-200 rounded-lg text-slate-900"
              />
              <button type="submit" disabled={!resolution.trim() || busy} className="px-3 py-1 rounded-lg bg-slate-100 border border-slate-300 text-slate-800 font-semibold disabled:opacity-50 cursor-pointer">Save</button>
              <button type="button" onClick={() => setResolvingId(null)} className="px-3 py-1 rounded-lg text-slate-600 cursor-pointer">Cancel</button>
            </form>
          )}
        </div>
      ))}

      {resolved.length > 0 && (
        <div>
          <button onClick={() => setShowResolved(s => !s)} className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-700 cursor-pointer">
            {showResolved ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {resolved.length} resolved barrier(s)
          </button>
          {showResolved && (
            <ul className="mt-1 space-y-1">
              {resolved.map(barrier => (
                <li key={barrier._id} className="text-[10px] text-slate-500">
                  <span className="line-through">{barrier.label}: {barrier.detail}</span>
                  <span className="text-slate-600"> → {barrier.resolution}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ProposalView({ task, proposal, meta, busy, onChoose }) {
  const [slotChoice, setSlotChoice] = useState({});
  if (!proposal) return null;
  const modalityLabel = (m) => meta?.modalityLabels?.[m] || m;
  const prerequisitesOpen = task.dependencies.some(dep => dep.status !== 'completed_with_evidence');

  return (
    <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-200 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-indigo-700">
        <Lightbulb className="w-3.5 h-3.5" />
        <span>Proposed alternatives</span>
        <span className="font-normal text-slate-500">· nothing has been booked or changed</span>
      </div>

      {proposal.recommendation === 'escalate' && (
        <p className="text-[11px] text-rose-700">{proposal.note}</p>
      )}

      {proposal.alternatives.map(alt => (
        <div key={alt.id} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-semibold text-slate-900">{alt.facility?.name || ALTERNATIVE_KIND_LABELS[alt.kind]}</span>
            {alt.facility?.isSimulated && <SimulatedTag />}
            <span className="text-slate-500">{ALTERNATIVE_KIND_LABELS[alt.kind]}</span>
            {alt.facility && (
              <span className="text-slate-600">
                · {alt.facility.modality === 'in_person' ? `${alt.facility.distanceKm} km away` : modalityLabel(alt.facility.modality)}
              </span>
            )}
          </div>
          <div className="text-slate-600">{alt.rationale}</div>
          {alt.times?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {alt.times.map((time, index) => {
                const bookable = alt.timesAre === 'bookable_slots';
                const selected = bookable && (slotChoice[alt.id] ?? alt.times[0].startAt) === time.startAt;
                return bookable ? (
                  <button
                    key={time.startAt + (time.providerId || '')}
                    type="button"
                    onClick={() => setSlotChoice(c => ({ ...c, [alt.id]: time.startAt }))}
                    className={`px-1.5 py-0.5 rounded border text-[10px] cursor-pointer ${selected ? 'border-teal-400 bg-teal-50 text-teal-800' : 'border-slate-300 text-slate-700 hover:border-slate-500'}`}
                    title={index === 0 ? 'Earliest slot' : undefined}
                  >
                    {formatTimeOption(time, alt.timesAre)}
                  </button>
                ) : (
                  <span key={time.startAt} className="px-1.5 py-0.5 rounded border border-slate-300 text-slate-700 text-[10px]">
                    {formatTimeOption(time, alt.timesAre)}
                  </span>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {alt.requiresPatientConfirmation && (
              <span className="px-1.5 py-0.5 rounded-full border border-sky-300 bg-sky-50 text-sky-700 text-[10px]">Needs patient confirmation</span>
            )}
            {alt.requiresClinicianApproval && (
              <span className="px-1.5 py-0.5 rounded-full border border-violet-300 bg-violet-50 text-violet-700 text-[10px]">Needs clinician approval</span>
            )}
            {!alt.requiresPatientConfirmation && !alt.requiresClinicianApproval && alt.kind !== 'escalate' && (
              <span className="px-1.5 py-0.5 rounded-full border border-slate-300 text-slate-600 text-[10px]">No approval needed</span>
            )}
            {(alt.kind === 'escalate' || !prerequisitesOpen) && (
              <button
                type="button"
                onClick={() => onChoose(task, proposal, alt, alt.timesAre === 'bookable_slots' ? (slotChoice[alt.id] ?? alt.times[0]?.startAt) : null)}
                disabled={busy}
                className="ml-auto px-2.5 py-1 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-[10px] font-semibold disabled:opacity-50 cursor-pointer"
              >
                {alt.kind === 'escalate' ? 'Escalate' : 'Choose this option'}
              </button>
            )}
          </div>
          {alt.approvalReason && <div className="text-[10px] text-violet-700">{alt.approvalReason}</div>}
        </div>
      ))}

      <p className="text-[10px] text-slate-500">
        Checked {formatDate(proposal.slotsCheckedAt, true)}. Choosing an option books nothing until every approval it needs is given; the slot is checked again at booking time.
        {prerequisitesOpen && ' This task\'s prerequisites are not finished yet, so its options can\'t be chosen.'}
      </p>
    </div>
  );
}

function BookingLine({ task }) {
  if (!task.booking && !task.plannedFacility?.changedFrom) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {task.booking && (
        <>
          <CalendarCheck className="w-3.5 h-3.5 text-emerald-600" />
          <span className="text-slate-700">
            Booked <span className="font-mono text-teal-700">{task.booking.bookingReference}</span>: {formatDate(task.booking.startAt, true)} with {task.booking.providerName}
            {task.booking.facilityName && <> at {task.booking.facilityName}</>}
          </span>
        </>
      )}
      {task.plannedFacility?.changedFrom && (
        <span className="text-slate-500">(changed from {task.plannedFacility.changedFrom} through an approved option)</span>
      )}
    </div>
  );
}

function ApprovalCard({ approval, meta, busy, onDecide, onRecordPatient, onCancel, onCallPatient }) {
  const [mode, setMode] = useState(null); // 'approve' | 'reject' | 'patient' | 'cancel'
  const [note, setNote] = useState('');
  const [patientDecision, setPatientDecision] = useState('confirm');
  if (!approval) return null;

  const statusLabel = meta?.approvalStatusLabels?.[approval.status] || approval.status;
  const open = (next) => { setMode(next); setNote(''); };
  const noteRequired = mode === 'reject' || mode === 'patient' || mode === 'cancel';

  const submit = (e) => {
    e.preventDefault();
    if (noteRequired && note.trim().length < 3) return;
    if (mode === 'approve' || mode === 'reject') onDecide(approval, mode, note.trim());
    if (mode === 'patient') onRecordPatient(approval, patientDecision, note.trim());
    if (mode === 'cancel') onCancel(approval, note.trim());
    setMode(null);
  };

  const placeholder = {
    approve: 'Note (optional)',
    reject: 'Why is this option not appropriate?',
    patient: 'How did the patient answer? e.g. "Confirmed by phone"',
    cancel: 'Why withdraw this option?'
  }[mode];

  return (
    <div className="p-3 rounded-lg bg-sky-50 border border-sky-200 space-y-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <Hourglass className="w-3.5 h-3.5 text-sky-700" />
        <span className="font-semibold text-slate-900">Option waiting: {approval.description}</span>
        <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${APPROVAL_STYLES[approval.status]}`}>{statusLabel}</span>
        {approval.action?.facility?.isSimulated && <SimulatedTag />}
      </div>
      <div className="text-slate-600">{approval.action?.rationale}</div>
      {approval.action?.approvalReason && <div className="text-[10px] text-violet-700">{approval.action.approvalReason}</div>}
      <div className="text-[10px] text-slate-500">
        Chosen by {approval.requestedBy?.name || approval.requestedBy?.type} &bull; {formatDate(approval.createdAt, true)}
        {approval.clinicianDecision && <> &bull; Clinician approved ({approval.clinicianDecision.by?.name})</>}
      </div>

      {approval.status === 'pending_patient' && (
        <p className="text-sky-700">Waiting for the patient's answer. PlanPilot phones them to ask; nothing is booked until they say yes. If they told staff directly, record it below.</p>
      )}
      {['approved', 'executing'].includes(approval.status) && (
        <p className="text-teal-700">Every approval is in; this is being carried out.</p>
      )}

      {!mode && ['pending_clinician', 'pending_patient', 'approved'].includes(approval.status) && (
        <div className="flex flex-wrap gap-1.5">
          {approval.status === 'pending_clinician' && (
            <>
              <button onClick={() => open('approve')} disabled={busy} className="px-2.5 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold disabled:opacity-50 cursor-pointer">Approve</button>
              <button onClick={() => open('reject')} disabled={busy} className="px-2.5 py-1 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50 cursor-pointer">Reject</button>
            </>
          )}
          {approval.status === 'pending_patient' && (
            <>
              <button onClick={() => onCallPatient(approval)} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold disabled:opacity-50 cursor-pointer">
                <PhoneCall className="w-3 h-3" /> Call patient now
              </button>
              <button onClick={() => open('patient')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-sky-300 text-sky-700 hover:bg-sky-50 disabled:opacity-50 cursor-pointer">
                <UserCheck className="w-3 h-3" /> Record patient's answer
              </button>
            </>
          )}
          <button onClick={() => open('cancel')} disabled={busy} className="px-2.5 py-1 rounded-lg text-slate-600 hover:text-slate-800 cursor-pointer">Withdraw</button>
        </div>
      )}

      {mode && (
        <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2">
          {mode === 'patient' && (
            <select value={patientDecision} onChange={(e) => setPatientDecision(e.target.value)} className="p-1.5 bg-white border border-slate-200 rounded-lg text-slate-900">
              <option value="confirm">Patient confirmed</option>
              <option value="decline">Patient declined</option>
            </select>
          )}
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={placeholder}
            className="flex-1 p-1.5 bg-white border border-slate-200 rounded-lg text-slate-900"
          />
          <button type="submit" disabled={busy || (noteRequired && note.trim().length < 3)} className="px-3 py-1 rounded-lg bg-slate-100 border border-slate-300 text-slate-800 font-semibold disabled:opacity-50 cursor-pointer">
            Save
          </button>
          <button type="button" onClick={() => setMode(null)} className="px-3 py-1 rounded-lg text-slate-600 cursor-pointer">Cancel</button>
        </form>
      )}
    </div>
  );
}

function ApprovalHistory({ approvals, meta }) {
  const [open, setOpen] = useState(false);
  if (!approvals?.length) return null;
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-700 cursor-pointer">
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {approvals.length} earlier option(s)
      </button>
      {open && (
        <ul className="mt-1 space-y-1">
          {approvals.map(a => (
            <li key={a._id} className="text-[10px] text-slate-600 flex flex-wrap items-center gap-1.5">
              <span className={`px-1.5 py-0.5 rounded-full border ${APPROVAL_STYLES[a.status]}`}>{meta?.approvalStatusLabels?.[a.status] || a.status}</span>
              <span>{a.description}</span>
              {a.execution?.error && <span className="text-rose-700">&mdash; {a.execution.error}</span>}
              {a.clinicianDecision?.decision === 'rejected' && <span className="text-rose-700">&mdash; {a.clinicianDecision.note}</span>}
              {a.patientDecision?.decision === 'declined' && a.patientDecision.note && <span className="text-amber-700">&mdash; {a.patientDecision.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocumentSubmissions({ task, busy, onReview, onUpload }) {
  const [reviewing, setReviewing] = useState(null); // { id, decision }
  const [note, setNote] = useState('');
  const [uploadError, setUploadError] = useState('');
  if (task.type !== 'document_submission') return null;
  const isClosed = task.status === 'completed_with_evidence';

  const submitReview = (e) => {
    e.preventDefault();
    if (reviewing.decision === 'reject' && note.trim().length < 3) return;
    onReview(task, reviewing.id, reviewing.decision, note.trim());
    setReviewing(null);
  };

  const handleFile = async (e) => {
    setUploadError('');
    try {
      const file = await readDocumentFile(e.target.files?.[0]);
      onUpload(task, file);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
        <FileText className="w-3.5 h-3.5 text-violet-700" />
        <span>Submitted documents</span>
        <span className="font-normal text-slate-500">· a file only counts once a clinician verifies it</span>
      </div>
      {task.documentSubmissions.length === 0 && <p className="text-[11px] text-slate-500">Nothing submitted yet.</p>}
      {task.documentSubmissions.map(sub => (
        <div key={sub._id} className="p-2 rounded-lg bg-white border border-slate-200 text-[11px] space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <a href={api.documentFileUrl(sub._id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-teal-700 hover:text-teal-800">
              {sub.fileName} <ExternalLink className="w-3 h-3" />
            </a>
            <span className="text-slate-500">{Math.ceil(sub.sizeBytes / 1024)} KB &bull; from {sub.submittedBy?.type === 'patient' ? 'the patient' : sub.submittedBy?.name} &bull; {formatDate(sub.submittedAt, true)}</span>
            <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${
              sub.status === 'verified' ? 'border-emerald-300 text-emerald-700' : sub.status === 'rejected' ? 'border-rose-300 text-rose-700' : 'border-violet-300 text-violet-700'
            }`}>
              {sub.status === 'pending_review' ? 'Waiting for review' : sub.status === 'verified' ? 'Verified' : 'Not accepted'}
            </span>
            {sub.reviewNote && <span className="text-slate-500">&mdash; {sub.reviewNote}</span>}
          </div>
          {sub.status === 'pending_review' && !isClosed && (
            reviewing?.id === sub._id ? (
              <form onSubmit={submitReview} className="flex flex-col sm:flex-row gap-2">
                <input
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={reviewing.decision === 'verify' ? 'Note (optional)' : 'What is wrong? The patient will see this.'}
                  className="flex-1 p-1.5 bg-white border border-slate-200 rounded-lg text-slate-900"
                />
                <button type="submit" disabled={busy || (reviewing.decision === 'reject' && note.trim().length < 3)} className="px-3 py-1 rounded-lg bg-slate-100 border border-slate-300 text-slate-800 font-semibold disabled:opacity-50 cursor-pointer">
                  {reviewing.decision === 'verify' ? 'Verify' : 'Not accepted'}
                </button>
                <button type="button" onClick={() => setReviewing(null)} className="px-3 py-1 rounded-lg text-slate-600 cursor-pointer">Cancel</button>
              </form>
            ) : (
              <div className="flex gap-1.5">
                <button onClick={() => { setReviewing({ id: sub._id, decision: 'verify' }); setNote(''); }} disabled={busy} className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-50 cursor-pointer">Verify document</button>
                <button onClick={() => { setReviewing({ id: sub._id, decision: 'reject' }); setNote(''); }} disabled={busy} className="px-2.5 py-1 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50 cursor-pointer">Not accepted</button>
              </div>
            )
          )}
        </div>
      ))}
      {!isClosed && (
        <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 hover:text-slate-800 cursor-pointer">
          <Upload className="w-3.5 h-3.5" />
          <span>Upload on the patient's behalf (PDF, JPG, PNG)</span>
          <input type="file" accept={ACCEPTED_DOCUMENT_TYPES} onChange={handleFile} disabled={busy} className="hidden" />
        </label>
      )}
      {uploadError && <p className="text-[10px] text-rose-700">{uploadError}</p>}
    </div>
  );
}

function TaskCard({ task, meta, busy, handlers, events = [] }) {
  const {
    onTransition,
    onRecordEvidence,
    onCheckFeasibility,
    onReportBarrier,
    onResolveBarrier,
    onChoose,
    onDecide,
    onRecordPatient,
    onCancelApproval,
    onReviewDocument,
    onUploadDocument,
    onProposePlannedBooking,
    onCallPatient
  } = handlers;
  const [pendingReasonFor, setPendingReasonFor] = useState(null);
  const [reason, setReason] = useState('');
  const [evidenceType, setEvidenceType] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [evidenceNote, setEvidenceNote] = useState('');
  const [reporting, setReporting] = useState(false);
  const [barrierCode, setBarrierCode] = useState('TRANSPORT');
  const [barrierDetail, setBarrierDetail] = useState('');

  const evidenceLabel = (type) => meta?.evidenceTypes?.[type]?.label || type;
  const selectedEvidence = evidenceType || task.missingEvidence[0] || '';
  const needsReference = Boolean(meta?.evidenceTypes?.[selectedEvidence]?.requiresReference);
  const isClosed = task.status === 'completed_with_evidence';
  // While an option waits for approval, the only manual moves are the ones that withdraw it
  const transitions = task.openApproval
    ? task.nextTransitions.filter(o => ['blocked', 'escalated'].includes(o.to))
    : task.nextTransitions;

  const handleTransitionClick = (to) => {
    if (REASON_REQUIRED.has(to)) {
      setPendingReasonFor(to);
      setReason('');
      return;
    }
    onTransition(task, to, '');
  };

  const submitReason = (e) => {
    e.preventDefault();
    if (!reason.trim()) return;
    onTransition(task, pendingReasonFor, reason.trim());
    setPendingReasonFor(null);
  };

  const submitEvidence = (e) => {
    e.preventDefault();
    onRecordEvidence(task, { type: selectedEvidence, reference: evidenceReference.trim(), note: evidenceNote.trim() });
    setEvidenceReference('');
    setEvidenceNote('');
    setEvidenceType('');
  };

  const submitBarrier = (e) => {
    e.preventDefault();
    if (barrierDetail.trim().length < 3) return;
    onReportBarrier(task, { code: barrierCode, detail: barrierDetail.trim() });
    setBarrierDetail('');
    setReporting(false);
  };

  return (
    <div className={`p-4 rounded-xl border space-y-3 ${isClosed ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'}`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-slate-900">{task.title}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
            <span>{meta?.taskTypes?.[task.type]?.label || task.type}</span>
            <span>&bull;</span>
            <span>Owner: <span className="text-slate-700">{OWNER_LABELS[task.owner] || task.owner}</span></span>
            <span>&bull;</span>
            <span className={task.isOverdue ? 'text-amber-700 font-semibold' : ''}>
              Due {formatDate(task.dueAt)}{task.isOverdue ? ' (overdue)' : ''}
            </span>
          </div>
          {task.plannedFacility && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
              <MapPin className="w-3.5 h-3.5 text-slate-500" />
              <span>Planned at <span className="text-slate-800">{task.plannedFacility.name}</span></span>
              {task.plannedFacility.modality === 'in_person' && task.plannedFacility.distanceKm !== null && (
                <span>· {task.plannedFacility.distanceKm} km from the patient</span>
              )}
              {task.plannedFacility.isSimulated && <SimulatedTag />}
            </div>
          )}
          <BookingLine task={task} />
        </div>
        <StatusBadge status={task.status} label={task.statusLabel} />
      </div>

      {/* Clinician instruction: read-only */}
      <div className="p-2.5 rounded-lg bg-white border border-slate-200 text-[11px] space-y-0.5">
        <div className="flex items-center gap-1.5 text-slate-500 font-semibold uppercase tracking-wider text-[9px]">
          <Lock className="w-3 h-3" />
          <span>Clinician instruction (PlanPilot never changes this)</span>
        </div>
        <div className="text-slate-800">{task.clinicalInstruction}</div>
      </div>

      {/* Dependencies */}
      {task.dependencies.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
          <Link2 className="w-3.5 h-3.5 text-slate-500" />
          <span>Needs first:</span>
          {task.dependencies.map(dep => (
            <span
              key={dep._id}
              className={`px-1.5 py-0.5 rounded border text-[10px] ${dep.status === 'completed_with_evidence' ? 'border-emerald-300 text-emerald-700' : 'border-slate-300 text-slate-700'}`}
            >
              {dep.status === 'completed_with_evidence' ? '✓ ' : ''}{dep.title}
            </span>
          ))}
        </div>
      )}

      {/* Barriers and proposed alternatives */}
      <BarrierList task={task} busy={busy} onResolve={onResolveBarrier} />
      <ApprovalCard
        approval={task.openApproval}
        meta={meta}
        busy={busy}
        onDecide={(approval, decision, note) => onDecide(task, approval, decision, note)}
        onRecordPatient={(approval, decision, note) => onRecordPatient(task, approval, decision, note)}
        onCancel={(approval, reason) => onCancelApproval(task, approval, reason)}
        onCallPatient={(approval) => onCallPatient(approval)}
      />
      {!isClosed && !task.openApproval && (
        <ProposalView task={task} proposal={task.latestProposal} meta={meta} busy={busy} onChoose={onChoose} />
      )}
      <ApprovalHistory approvals={task.approvalHistory} meta={meta} />
      <DocumentSubmissions task={task} busy={busy} onReview={onReviewDocument} onUpload={onUploadDocument} />

      {/* Evidence */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
          <FileCheck2 className="w-3.5 h-3.5 text-teal-600" />
          <span>Evidence needed to complete</span>
        </div>
        <ul className="space-y-1">
          {task.requiredEvidence.map(type => {
            const record = task.evidence.find(e => e.type === type);
            return (
              <li key={type} className="flex items-start gap-2 text-[11px]">
                {record
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
                  : <XCircle className="w-3.5 h-3.5 text-slate-400 mt-0.5 flex-shrink-0" />}
                <div>
                  <span className={record ? 'text-slate-800' : 'text-slate-600'}>{evidenceLabel(type)}</span>
                  {record && (
                    <span className="text-slate-500">
                      {' '}&mdash; {record.recordedBy?.name || record.recordedBy?.type}, {formatDate(record.recordedAt, true)}
                      {record.reference && <span className="font-mono text-teal-600"> &bull; {record.reference}</span>}
                      {record.note && <span> &bull; {record.note}</span>}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {!isClosed && task.missingEvidence.length > 0 && (
          <form onSubmit={submitEvidence} className="flex flex-col sm:flex-row gap-2 pt-1">
            <select
              value={selectedEvidence}
              onChange={(e) => setEvidenceType(e.target.value)}
              className="p-1.5 bg-white border border-slate-200 rounded-lg text-[11px] text-slate-900"
            >
              {task.missingEvidence.map(type => (
                <option key={type} value={type}>{evidenceLabel(type)}</option>
              ))}
            </select>
            {needsReference && (
              <input
                value={evidenceReference}
                onChange={(e) => setEvidenceReference(e.target.value)}
                placeholder="e.g. CL-ABC123"
                required
                className="p-1.5 bg-white border border-slate-200 rounded-lg text-[11px] text-slate-900 font-mono sm:w-32"
              />
            )}
            <input
              value={evidenceNote}
              onChange={(e) => setEvidenceNote(e.target.value)}
              placeholder="Note (optional)"
              className="flex-1 p-1.5 bg-white border border-slate-200 rounded-lg text-[11px] text-slate-900"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-teal-50 hover:bg-teal-100 border border-teal-300 text-teal-700 text-[11px] font-semibold whitespace-nowrap disabled:opacity-50 cursor-pointer"
            >
              Record evidence
            </button>
          </form>
        )}
      </div>

      <TaskHistory events={events} meta={meta} />

      {/* Actions */}
      {!isClosed && (
        <div className="space-y-2 pt-1 border-t border-slate-200">
          <div className="flex flex-wrap gap-1.5 pt-2">
            <button
              onClick={() => onCheckFeasibility(task)}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border bg-indigo-50 hover:bg-indigo-100 border-indigo-300 text-indigo-700 disabled:opacity-50 cursor-pointer"
            >
              <Search className="w-3 h-3" /> Check feasibility
            </button>
            {task.type === 'appointment_booking' && task.status === 'suggested' && !task.openApproval && !task.evidence.length
              && task.barriers.every(b => b.resolvedAt) && (
              <button
                onClick={() => onProposePlannedBooking(task)}
                disabled={busy}
                title="Offers the earliest slot at the planned clinic before the deadline; the patient must confirm it"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border bg-teal-50 hover:bg-teal-100 border-teal-300 text-teal-700 disabled:opacity-50 cursor-pointer"
              >
                <CalendarCheck className="w-3 h-3" /> Offer earliest slot at planned clinic
              </button>
            )}
            <button
              onClick={() => setReporting(r => !r)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border bg-white hover:bg-slate-100 border-slate-300 text-slate-700 cursor-pointer"
            >
              <AlertTriangle className="w-3 h-3" /> Report a barrier
            </button>
            <span className="w-px bg-slate-100 mx-1" />
            {transitions.map(option => (
              <button
                key={option.to}
                onClick={() => handleTransitionClick(option.to)}
                disabled={!option.allowed || busy}
                title={option.allowed ? `Move to ${option.label}` : option.reason}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
                  option.allowed
                    ? 'bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-300 cursor-pointer'
                    : 'bg-white text-slate-400 border-slate-200 cursor-not-allowed'
                }`}
              >
                → {option.label}
              </button>
            ))}
          </div>
          {transitions
            .filter(o => !o.allowed && ['EVIDENCE_MISSING', 'DEPENDENCIES_INCOMPLETE'].includes(o.code))
            .slice(0, 1)
            .map(o => (
              <p key={o.to} className="text-[10px] text-slate-500">{o.reason}</p>
            ))}

          {reporting && (
            <form onSubmit={submitBarrier} className="flex flex-col sm:flex-row gap-2 text-[11px]">
              <select
                value={barrierCode}
                onChange={(e) => setBarrierCode(e.target.value)}
                className="p-1.5 bg-white border border-slate-200 rounded-lg text-slate-900"
              >
                {Object.entries(meta?.barrierCodes || {}).map(([code, def]) => (
                  <option key={code} value={code}>{def.label}</option>
                ))}
              </select>
              <input
                autoFocus
                value={barrierDetail}
                onChange={(e) => setBarrierDetail(e.target.value)}
                placeholder="What is stopping this task? (screened for emergencies)"
                className="flex-1 p-1.5 bg-white border border-amber-300 rounded-lg text-slate-900"
              />
              <button type="submit" disabled={barrierDetail.trim().length < 3 || busy} className="px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-700 font-semibold disabled:opacity-50 cursor-pointer">
                Report
              </button>
            </form>
          )}

          {pendingReasonFor && (
            <form onSubmit={submitReason} className="flex flex-col sm:flex-row gap-2">
              <input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={`Why is this task ${meta?.statusLabels?.[pendingReasonFor]?.toLowerCase() || pendingReasonFor}?`}
                className="flex-1 p-1.5 bg-white border border-amber-300 rounded-lg text-[11px] text-slate-900"
              />
              <button type="submit" disabled={!reason.trim() || busy} className="px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-700 text-[11px] font-semibold disabled:opacity-50 cursor-pointer">
                Confirm
              </button>
              <button type="button" onClick={() => setPendingReasonFor(null)} className="px-3 py-1.5 rounded-lg text-slate-600 text-[11px] cursor-pointer">
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

const OUTCOME_STYLES = {
  done: 'border-emerald-300 text-emerald-700',
  refused: 'border-amber-300 text-amber-700',
  failed_escalated: 'border-rose-300 text-rose-700',
  failed: 'border-rose-300 text-rose-700'
};

const OUTCOME_LABELS = {
  done: 'Done',
  refused: 'Refused by the rules (nothing changed)',
  failed_escalated: 'Kept failing; escalated',
  failed: 'Failed'
};

function DeciderBadge({ decidedBy, fallbackReason }) {
  const isLlm = decidedBy?.startsWith('llm:');
  return (
    <span
      title={fallbackReason || undefined}
      className={`px-1.5 py-0.5 rounded-full border text-[9px] font-semibold ${isLlm ? 'border-teal-300 text-teal-700' : fallbackReason ? 'border-amber-300 text-amber-700' : 'border-slate-300 text-slate-600'}`}
    >
      {isLlm ? `AI: ${decidedBy.split('/').pop()}` : fallbackReason ? 'Rules (AI answer unusable)' : 'Rules'}
    </span>
  );
}

function AgentRunView({ run, onClose }) {
  if (!run) return null;
  return (
    <div className="rounded-2xl p-5 bg-teal-50 border border-teal-200 space-y-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold text-teal-800 flex items-center gap-2">
            <Bot className="w-4 h-4" />
            <span>PlanPilot agent run</span>
          </h4>
          <p className="text-[11px] text-slate-600">{run.summary} &bull; Decided by: {run.decider} &bull; {formatDate(run.finishedAt, true)}</p>
        </div>
        <button onClick={onClose} className="text-[11px] text-slate-600 hover:text-slate-800 cursor-pointer">Hide</button>
      </div>

      {run.steps.length > 0 && (
        <ol className="space-y-1.5">
          {run.steps.map((step, i) => (
            <li key={i} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold text-slate-900">{step.taskTitle}</span>
                <span className="text-slate-500">&rarr;</span>
                <span className="text-slate-800">{step.label}</span>
                <DeciderBadge decidedBy={step.decidedBy} fallbackReason={step.fallbackReason} />
                <span className={`px-1.5 py-0.5 rounded-full border text-[9px] ${OUTCOME_STYLES[step.outcome] || OUTCOME_STYLES.failed}`}>
                  {OUTCOME_LABELS[step.outcome] || step.outcome}{step.attempts > 1 ? ` after ${step.attempts} attempts` : ''}
                </span>
              </div>
              <div className="text-slate-600">Why: {step.reason}</div>
              {step.detail && <div className="text-slate-500">Result: {step.detail}</div>}
              {step.fallbackReason && <div className="text-amber-700">{step.fallbackReason}</div>}
            </li>
          ))}
        </ol>
      )}

      {run.waiting.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-slate-600">Waiting (no safe action right now)</div>
          <ul className="space-y-0.5">
            {run.waiting.map(item => (
              <li key={item.taskId} className="text-[11px] text-slate-600">
                <span className="text-slate-800">{item.taskTitle}</span>: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[10px] text-slate-500">
        The agent only picks from actions the server allows for each task. It cannot complete tasks, approve options, verify documents, or answer for the patient.
      </p>
    </div>
  );
}

function describeEvent(event, label) {
  switch (event.kind) {
    case 'created':
      return <>created as {label(event.to)}</>;
    case 'transition':
      return <>{label(event.from)} → <strong>{label(event.to)}</strong></>;
    case 'evidence_recorded':
      return <>evidence recorded: {event.reason}</>;
    case 'feasibility_checked':
      return <>feasibility checked: {event.reason}</>;
    case 'barrier_detected':
      return <span className="text-amber-700">barrier: {event.reason}</span>;
    case 'barrier_resolved':
      return <>barrier resolved: {event.reason}</>;
    case 'replan_proposed':
      return <span className="text-indigo-700">alternatives: {event.reason}</span>;
    case 'approval_requested':
      return <span className="text-sky-700">{event.reason}</span>;
    case 'approval_granted':
    case 'patient_confirmed':
      return <span className="text-emerald-700">{event.reason}</span>;
    case 'approval_rejected':
    case 'patient_declined':
    case 'approval_cancelled':
      return <span className="text-amber-700">{event.reason}</span>;
    case 'approval_executed':
      return <span className="text-teal-700">{event.reason}</span>;
    case 'approval_failed':
      return <span className="text-rose-700">option failed: {event.reason}</span>;
    case 'logistics_updated':
      return <>logistics: {event.reason}</>;
    case 'document_submitted':
    case 'document_reviewed':
      return <span className="text-violet-700">document: {event.reason}</span>;
    case 'agent_decision':
      return (
        <span className="text-teal-800">
          agent decided: {event.reason}
          {event.decision?.decidedBy && <span className="text-slate-500"> ({event.decision.decidedBy}{event.decision.fallbackReason ? `; ${event.decision.fallbackReason}` : ''})</span>}
        </span>
      );
    default:
      return <>{event.kind}</>;
  }
}

const showsReasonSeparately = (kind) => ['created', 'transition'].includes(kind);

function TaskHistory({ events, meta }) {
  const [open, setOpen] = useState(false);
  const label = (status) => meta?.statusLabels?.[status] || status;
  if (!events.length) return null;
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-800 cursor-pointer">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <History className="w-3.5 h-3.5" />
        <span>History of this task ({events.length})</span>
      </button>
      {open && (
        <ol className="mt-2 ml-1.5 border-l border-slate-300 space-y-2">
          {events.map(event => (
            <li key={event._id} className="relative pl-4 text-[11px]">
              <span className={`absolute -left-[4.5px] top-1 w-2 h-2 rounded-full ${
                event.kind === 'transition' && event.to === 'completed_with_evidence' ? 'bg-emerald-400'
                  : ['barrier_detected', 'approval_failed'].includes(event.kind) ? 'bg-amber-400'
                    : event.kind === 'agent_decision' ? 'bg-teal-400' : 'bg-slate-500'
              }`} />
              <div className="text-slate-500 font-mono text-[10px]">{formatDate(event.at, true)} &bull; {event.actor?.name || event.actor?.type}</div>
              <div className="text-slate-700">
                {describeEvent(event, label)}
                {showsReasonSeparately(event.kind) && event.reason && <span className="text-slate-500"> &mdash; “{event.reason}”</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ActivityLog({ events, tasks, meta }) {
  const titleFor = (taskId) => tasks.find(t => t._id === taskId)?.title || 'Task';
  const label = (status) => meta?.statusLabels?.[status] || status;

  return (
    <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-3 shadow-sm">
      <h4 className="text-xs font-semibold text-slate-700 flex flex-wrap items-center gap-2">
        <History className="w-4 h-4 text-indigo-600" />
        <span>Audit log ({events.length})</span>
        <span className="text-[10px] font-normal text-slate-500">Append-only. Refused attempts change nothing and are not listed.</span>
      </h4>
      <ol className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
        {[...events].reverse().map(event => (
          <li key={event._id} className="text-[11px] flex flex-col sm:flex-row sm:items-baseline gap-x-3 border-l-2 border-slate-200 pl-2.5">
            <span className="font-mono text-slate-500 shrink-0">{formatDate(event.at, true)}</span>
            <span className="text-slate-700">
              <strong className="text-slate-900">{titleFor(event.taskId)}</strong>{': '}
              {describeEvent(event, label)}
              {showsReasonSeparately(event.kind) && event.reason && <span className="text-slate-500"> &mdash; “{event.reason}”</span>}
              <span className="text-slate-500"> &bull; {event.actor?.name || event.actor?.type}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function CarePlansPanel({ focusPlanId = null, onDataChanged = null }) {
  const [meta, setMeta] = useState(null);
  const [plans, setPlans] = useState([]);
  const [patients, setPatients] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedPlanId, setSelectedPlanId] = useState(focusPlanId);
  // Opened from the review queue: jump to that plan (adjusting state during render, per React docs)
  const [lastFocusPlanId, setLastFocusPlanId] = useState(focusPlanId);
  if (focusPlanId !== lastFocusPlanId) {
    setLastFocusPlanId(focusPlanId);
    if (focusPlanId) setSelectedPlanId(focusPlanId);
  }
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [showSource, setShowSource] = useState(false);
  const [lastRun, setLastRun] = useState(null);

  const [showCreate, setShowCreate] = useState(false);
  const [showAddPatient, setShowAddPatient] = useState(false);
  const [patientForm, setPatientForm] = useState(null);
  const [newPatientId, setNewPatientId] = useState('');
  const [newTemplateId, setNewTemplateId] = useState('');

  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const [metaRes, plansRes, patientsRes, templatesRes] = await Promise.all([
        api.getCarePlanMeta(),
        api.getCarePlans(),
        api.getPatientRecords(),
        api.getCarePlanTemplates()
      ]);
      setMeta(metaRes.data);
      setPlans(plansRes.data);
      setPatients(patientsRes.data);
      setTemplates(templatesRes.data);
      // Keep the selection unless that plan no longer exists (e.g. after a demo reset)
      setSelectedPlanId(current => (current && plansRes.data.some(p => p._id === current) ? current : plansRes.data[0]?._id || null));
    } catch (err) {
      setError(err.message || 'Failed to load care plans.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (planId) => {
    if (!planId) {
      setDetail(null);
      return;
    }
    try {
      const res = await api.getCarePlan(planId);
      setDetail(res.data);
    } catch (err) {
      // A plan removed by a demo reset is replaced by the list reload; don't show an error for it
      if (err.code !== 'PLAN_NOT_FOUND') setError(err.message || 'Failed to load the care plan.');
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    loadPlans();
  }, [loadPlans]);

  useEffect(() => {
    loadDetail(selectedPlanId);
  }, [selectedPlanId, loadDetail]);


  const refreshAll = async () => {
    await Promise.all([loadPlans(), loadDetail(selectedPlanId)]);
  };

  // successMessage may return a string or { text, tone } (tone: 'success' | 'danger')
  const runAction = async (action, successMessage) => {
    setBusy(true);
    setError('');
    setNotice(null);
    try {
      const result = await action();
      const message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
      setNotice(typeof message === 'string' ? { text: message, tone: 'success' } : message);
      await refreshAll();
      onDataChanged?.();
    } catch (err) {
      // Refusals from the state machine are expected and explain themselves
      setError(err.message || 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleTransition = (task, to, reason) => runAction(
    () => api.transitionCareTask(task._id, { to, reason }),
    (res) => res.data.planCompleted
      ? `"${task.title}" completed. Every task in this plan now has evidence; the plan is complete.`
      : `"${task.title}" moved to ${meta?.statusLabels?.[to] || to}.`
  );

  const handleRecordEvidence = (task, evidence) => runAction(
    () => api.recordTaskEvidence(task._id, evidence),
    `Evidence recorded for "${task.title}".`
  );

  const handleCheckTask = (task) => runAction(
    () => api.checkTaskFeasibility(task._id),
    (res) => {
      const { feasible, barriers, blocked, proposal } = res.data;
      if (feasible) return `"${task.title}": no barriers found.`;
      const found = barriers.map(b => b.label).join(', ');
      const options = proposal?.recommendation === 'escalate'
        ? 'No permitted alternative found; consider escalating.'
        : `${proposal?.alternatives.length || 0} alternative(s) proposed.`;
      return `"${task.title}": ${found}.${blocked ? ' Task marked Blocked.' : ''} ${options}`;
    }
  );

  const handleRunAgent = () => runAction(
    async () => {
      const res = await api.runPlanAgent(detail.plan._id);
      setLastRun(res.data);
      return res;
    },
    (res) => res.data.status === 'failed'
      ? { text: `PlanPilot agent stopped: ${res.data.error}`, tone: 'danger' }
      : `PlanPilot agent: ${res.data.summary}`
  );

  const handleCheckPlan = () => runAction(
    () => api.checkPlanFeasibility(detail.plan._id),
    (res) => `Checked ${res.data.checked} task(s): ${res.data.infeasible} with barriers, ${res.data.checked - res.data.infeasible} clear.`
  );

  const handleReportBarrier = (task, barrier) => runAction(
    () => api.reportTaskBarrier(task._id, barrier),
    (res) => res.data.emergency
      ? { text: `Possible emergency described. "${task.title}" was escalated to a clinician immediately. ${res.data.emergency.instructions}`, tone: 'danger' }
      : `Barrier recorded for "${task.title}".`
  );

  const handleResolveBarrier = (task, barrier, resolution) => runAction(
    () => api.resolveTaskBarrier(task._id, barrier._id, { resolution }),
    `Barrier "${barrier.label}" marked resolved. The task's status is unchanged; move it forward when ready.`
  );

  const describeOutcome = (task, data, waitingText) => {
    if (data.emergency) return { text: `Possible emergency described. "${task.title}" was escalated to a clinician. ${data.emergency.instructions}`, tone: 'danger' };
    if (data.failure) return { text: `"${task.title}": ${data.failure.message}`, tone: 'danger' };
    if (data.executed) {
      const booked = data.booking ? ` Booked ${data.booking.bookingReference}.` : '';
      return `"${task.title}": done.${booked}${data.completed ? ' The task is completed: the booking engine confirmed the booking.' : ''}`;
    }
    return waitingText;
  };

  const handleChoose = (task, proposal, alternative, slotStartAt) => runAction(
    () => api.chooseTaskAlternative(task._id, { proposalId: proposal._id, alternativeId: alternative.id, slotStartAt }),
    (res) => describeOutcome(task, res.data, `"${task.title}": option sent for ${alternative.requiresClinicianApproval ? 'clinician approval' : 'patient confirmation'}. Nothing is booked yet.`)
  );

  const handleProposePlannedBooking = (task) => runAction(
    () => api.proposePlannedBooking(task._id),
    `"${task.title}": earliest slot offered to the patient. Nothing is booked until they confirm.`
  );

  const handleDecide = (task, approval, decision, note) => runAction(
    () => api.decideApproval(approval._id, { decision, note }),
    (res) => decision === 'reject'
      ? `"${task.title}": option rejected. The task is back to Blocked.`
      : describeOutcome(task, res.data, `"${task.title}": approved. Now waiting for the patient to confirm.`)
  );

  const handleRecordPatient = (task, approval, decision, note) => runAction(
    () => api.recordPatientResponse(approval._id, { decision, note }),
    (res) => decision === 'decline'
      ? `"${task.title}": patient declined. The task is back to Blocked.`
      : describeOutcome(task, res.data, `"${task.title}": patient confirmation recorded.`)
  );

  const handleCancelApproval = (task, approval, reason) => runAction(
    () => api.cancelApproval(approval._id, { reason }),
    `"${task.title}": option withdrawn.`
  );

  const handleReviewDocument = (task, submissionId, decision, note) => runAction(
    () => api.reviewDocument(submissionId, { decision, note }),
    (res) => decision === 'reject'
      ? `"${task.title}": document not accepted. The patient will see your reason.`
      : `"${task.title}": document verified.${res.data.completed ? ' The task is completed with evidence.' : ''}`
  );

  const handleUploadDocument = (task, file) => runAction(
    () => api.uploadTaskDocument(task._id, file),
    `"${task.title}": ${file.fileName} uploaded. Verify it to count it as evidence.`
  );

  const handleCallPatient = (patientId, approvalId = null) => runAction(
    () => api.callPatient({ patientId, approvalId }),
    (res) => res.data.isMock
      ? `Simulated call to ${res.data.patient} (synthetic patient: no real phone rings).`
      : `PlanPilot is calling ${res.data.patient} now${res.data.about ? ` to ask about: ${res.data.about}` : ''}.`
  );

  const openAddPatient = () => {
    setPatientForm({ name: '', phone: '+91', preferredLanguage: 'hi', area: 0, hasOwnTransport: false, maxTravelKm: 5, documentsHeld: ['aadhaar'], caregiverName: '' });
    setShowAddPatient(true);
  };

  const handleAddPatient = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const area = HOME_AREAS[patientForm.area];
      const res = await api.createPatient({
        name: patientForm.name.trim(),
        phone: patientForm.phone.trim(),
        preferredLanguage: patientForm.preferredLanguage,
        location: { label: area.label, x: area.x, y: area.y },
        constraints: {
          hasOwnTransport: patientForm.hasOwnTransport,
          maxTravelKm: Number(patientForm.maxTravelKm),
          documentsHeld: patientForm.documentsHeld,
          caregiverName: patientForm.caregiverName.trim() || null
        }
      });
      setShowAddPatient(false);
      setNotice({ text: `${res.data.name} added. PlanPilot will phone ${res.data.phone} whenever an option needs their answer. Now create their care plan.`, tone: 'success' });
      await loadPlans();
      setNewPatientId(res.data._id);
      setShowCreate(true);
    } catch (err) {
      setError(err.message || 'Could not add the patient.');
    } finally {
      setBusy(false);
    }
  };

  const taskHandlers = {
    onTransition: (task, to, reason) => handleTransition(task, to, reason),
    onRecordEvidence: (task, evidence) => handleRecordEvidence(task, evidence),
    onCheckFeasibility: (task) => handleCheckTask(task),
    onReportBarrier: (task, barrier) => handleReportBarrier(task, barrier),
    onResolveBarrier: (task, barrier, resolution) => handleResolveBarrier(task, barrier, resolution),
    onChoose: handleChoose,
    onDecide: handleDecide,
    onRecordPatient: handleRecordPatient,
    onCancelApproval: handleCancelApproval,
    onReviewDocument: handleReviewDocument,
    onUploadDocument: handleUploadDocument,
    onProposePlannedBooking: handleProposePlannedBooking,
    onCallPatient: (approval) => handleCallPatient(detail.patient._id, approval._id)
  };

  const handleSaveLogistics = (patientId, constraints) => runAction(
    () => api.updatePatientLogistics(patientId, { constraints }),
    'Patient logistics updated. Run a feasibility check to see the effect.'
  );

  const handleCreatePlan = async (e) => {
    e.preventDefault();
    const patientId = newPatientId || patients[0]?._id;
    const templateId = newTemplateId || templates[0]?.id;
    if (!patientId || !templateId) return;

    setBusy(true);
    setError('');
    try {
      const res = await api.createCarePlan({ patientId, templateId });
      setShowCreate(false);
      setNotice({ text: `Care plan created with ${res.data.tasks.length} tasks. You are recorded as the approving clinician.`, tone: 'success' });
      setSelectedPlanId(res.data.plan._id);
      await loadPlans();
    } catch (err) {
      setError(err.message || 'Failed to create the care plan.');
    } finally {
      setBusy(false);
    }
  };

  const previewTemplate = templates.find(t => t.id === (newTemplateId || templates[0]?.id));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-teal-600" />
            <span>Care Plans</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200 font-semibold">PlanPilot</span>
          </h2>
          <p className="text-xs text-slate-600">
            Clinician-approved plans, tracked task by task. A task only counts as done when there is evidence.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshAll}
            className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={openAddPatient}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 cursor-pointer"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add Patient</span>
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl bg-teal-600 hover:bg-teal-500 text-white shadow-md shadow-teal-500/20 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Care Plan</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-50 border border-rose-300 text-rose-700 text-xs flex items-start justify-between gap-3">
          <div className="flex items-start gap-2"><AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /><span>{error}</span></div>
          <button onClick={() => setError('')} className="text-rose-600 hover:text-rose-800 cursor-pointer">Dismiss</button>
        </div>
      )}
      {notice && (
        <div className={`p-3 rounded-xl border text-xs flex items-start justify-between gap-3 ${NOTICE_STYLES[notice.tone] || NOTICE_STYLES.success}`}>
          <div className="flex items-start gap-2">
            {notice.tone === 'danger' ? <Siren className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />}
            <span>{notice.text}</span>
          </div>
          <button onClick={() => setNotice(null)} className="opacity-80 hover:opacity-100 cursor-pointer">Dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Plan list */}
        <div className="space-y-2">
          {plans.length === 0 && !loading && (
            <div className="p-6 rounded-2xl bg-white border border-slate-200 text-center text-xs text-slate-600 shadow-sm">
              No care plans yet. Click <strong>Add Patient</strong> (with their phone number), then create their care plan.
            </div>
          )}
          {plans.map(plan => (
            <button
              key={plan._id}
              onClick={() => { setSelectedPlanId(plan._id); setLastRun(null); }}
              className={`w-full text-left p-4 rounded-2xl border space-y-2 transition-colors cursor-pointer ${
                selectedPlanId === plan._id ? 'bg-teal-50 border-teal-400' : 'bg-white border-slate-200 hover:border-slate-300'
              } shadow-sm`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-900 truncate">{plan.patient?.name || 'Unknown patient'}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${plan.status === 'completed' ? 'border-emerald-300 text-emerald-700' : 'border-slate-300 text-slate-600'}`}>
                  {plan.status}
                </span>
              </div>
              <div className="text-[11px] text-slate-600 line-clamp-2">{plan.title}</div>
              <ProgressBar progress={plan.progress} />
              {plan.patient?.isSynthetic && <div className="text-[9px] font-mono text-amber-700">SYNTHETIC DEMO PATIENT</div>}
            </button>
          ))}
        </div>

        {/* Plan detail */}
        <div className="lg:col-span-2 space-y-4">
          {!detail ? (
            <div className="p-10 rounded-2xl bg-white border border-slate-200 text-center text-xs text-slate-600 shadow-sm">
              Select a care plan to see its tasks.
            </div>
          ) : (
            <>
              <div className="rounded-2xl p-5 bg-white border border-slate-200 space-y-3 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                  <div>
                    <h3 className="text-base font-bold text-slate-900">{detail.plan.title}</h3>
                    <p className="text-[11px] text-slate-600">
                      Patient: <span className="text-slate-800">{detail.patient?.name}</span>
                      {detail.patient?.phone && <span className="font-mono"> &bull; {detail.patient.phone}</span>}
                      {detail.patient?.preferredLanguage && <span> &bull; prefers {detail.patient.preferredLanguage === 'hi' ? 'Hindi' : 'English'}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-emerald-700">
                    <ShieldCheck className="w-4 h-4" />
                    <span>Approved by {detail.plan.approvedBy?.name} &bull; {formatDate(detail.plan.approvedAt)}</span>
                  </div>
                </div>
                <PatientLogistics patient={detail.patient} meta={meta} busy={busy} onSave={handleSaveLogistics} />
                <ProgressBar progress={detail.plan.progress} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    onClick={() => setShowSource(s => !s)}
                    className="flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-800 cursor-pointer"
                  >
                    {showSource ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    <span>Clinician's original plan (verbatim)</span>
                  </button>
                  {detail.plan.status === 'active' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={handleCheckPlan}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border bg-indigo-50 hover:bg-indigo-100 border-indigo-300 text-indigo-700 disabled:opacity-50 cursor-pointer"
                      >
                        <Search className="w-3.5 h-3.5" /> Check feasibility of all tasks
                      </button>
                      {detail.patient?.phone && (
                        <button
                          onClick={() => handleCallPatient(detail.patient._id)}
                          disabled={busy}
                          title="PlanPilot phones the patient about their care plan"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border bg-sky-50 hover:bg-sky-100 border-sky-300 text-sky-700 disabled:opacity-50 cursor-pointer"
                        >
                          <PhoneCall className="w-3.5 h-3.5" /> Call patient
                        </button>
                      )}
                      <button
                        onClick={handleRunAgent}
                        disabled={busy}
                        title={meta?.agent?.decider}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-50 cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5" /> Run PlanPilot agent
                      </button>
                    </div>
                  )}
                </div>
                {showSource && (
                  <pre className="whitespace-pre-wrap text-[11px] text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3 font-sans">
                    {detail.plan.sourceText}
                  </pre>
                )}
                {meta?.agent && (
                  <p className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                    <Bot className="w-3.5 h-3.5" />
                    <span>Agent decides with: {meta.agent.decider}</span>
                    <span>&bull; {meta.agent.schedulerMinutes ? `re-checks automatically every ${meta.agent.schedulerMinutes} min` : 'runs when you press Run'}</span>
                  </p>
                )}
              </div>

              <AgentRunView run={lastRun} onClose={() => setLastRun(null)} />

              <div className="space-y-3">
                {detail.tasks.map(task => (
                  <TaskCard
                    key={task._id}
                    task={task}
                    meta={meta}
                    busy={busy}
                    handlers={taskHandlers}
                    events={detail.events.filter(e => e.taskId === task._id)}
                  />
                ))}
              </div>

              <ActivityLog events={detail.events} tasks={detail.tasks} meta={meta} />
            </>
          )}
        </div>
      </div>

      {/* Add patient modal */}
      {showAddPatient && patientForm && (
        <div className="fixed inset-0 z-50 bg-slate-50 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={handleAddPatient} className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 space-y-3 shadow-2xl max-h-[90vh] overflow-y-auto text-xs">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Add Patient</h3>
              <button type="button" onClick={() => setShowAddPatient(false)} className="text-slate-600 hover:text-slate-900 text-sm cursor-pointer">&times;</button>
            </div>
            <p className="text-[11px] text-slate-600">Patients talk to PlanPilot by phone. With a real number, PlanPilot really calls them (a Twilio trial account can only call numbers verified in Twilio). Fictional +1 555 numbers are always simulated.</p>
            <label className="block space-y-1">
              <span className="text-slate-700 font-semibold">Name</span>
              <input required minLength={2} value={patientForm.name} onChange={(e) => setPatientForm(f => ({ ...f, name: e.target.value }))} className="w-full p-2 bg-white border border-slate-200 rounded-lg text-slate-900" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-slate-700 font-semibold">Phone (with country code)</span>
                <input required pattern="\+[1-9][0-9]{6,14}" value={patientForm.phone} onChange={(e) => setPatientForm(f => ({ ...f, phone: e.target.value.replace(/\s/g, '') }))} placeholder="+919876543210" className="w-full p-2 bg-white border border-slate-200 rounded-lg text-slate-900 font-mono" />
              </label>
              <label className="block space-y-1">
                <span className="text-slate-700 font-semibold">Language</span>
                <select value={patientForm.preferredLanguage} onChange={(e) => setPatientForm(f => ({ ...f, preferredLanguage: e.target.value }))} className="w-full p-2 bg-white border border-slate-200 rounded-lg text-slate-900">
                  <option value="hi">Hindi</option>
                  <option value="en">English</option>
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-slate-700 font-semibold">Lives in (demo map)</span>
                <select value={patientForm.area} onChange={(e) => setPatientForm(f => ({ ...f, area: Number(e.target.value) }))} className="w-full p-2 bg-white border border-slate-200 rounded-lg text-slate-900">
                  {HOME_AREAS.map((area, i) => <option key={area.label} value={i}>{area.label}</option>)}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-slate-700 font-semibold">Can travel up to (km)</span>
                <input type="number" min="0" max="500" value={patientForm.maxTravelKm} onChange={(e) => setPatientForm(f => ({ ...f, maxTravelKm: e.target.value }))} className="w-full p-2 bg-white border border-slate-200 rounded-lg text-slate-900" />
              </label>
            </div>
            <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
              <input type="checkbox" checked={patientForm.hasOwnTransport} onChange={(e) => setPatientForm(f => ({ ...f, hasOwnTransport: e.target.checked }))} />
              Has own transport
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-slate-700 font-semibold">Documents they have:</span>
              {Object.entries(meta?.documentLabels || {}).map(([code, label]) => (
                <label key={code} className="flex items-center gap-1 text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={patientForm.documentsHeld.includes(code)}
                    onChange={() => setPatientForm(f => ({ ...f, documentsHeld: f.documentsHeld.includes(code) ? f.documentsHeld.filter(d => d !== code) : [...f.documentsHeld, code] }))}
                  />
                  {label}
                </label>
              ))}
            </div>
            <label className="block space-y-1">
              <span className="text-slate-700 font-semibold">Caregiver (optional)</span>
              <input value={patientForm.caregiverName} onChange={(e) => setPatientForm(f => ({ ...f, caregiverName: e.target.value }))} placeholder="Name (relation)" className="w-full p-2 bg-white border border-slate-200 rounded-lg text-slate-900" />
            </label>
            <button type="submit" disabled={busy} className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-bold cursor-pointer">
              {busy ? 'Adding...' : 'Add patient, then create their care plan'}
            </button>
          </form>
        </div>
      )}

      {/* Create plan modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 bg-slate-50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="font-bold text-slate-900 text-sm">New Care Plan</h3>
              <button onClick={() => setShowCreate(false)} className="text-slate-600 hover:text-slate-900 text-sm cursor-pointer">&times;</button>
            </div>

            <form onSubmit={handleCreatePlan} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Patient</label>
                <select
                  value={newPatientId || patients[0]?._id || ''}
                  onChange={(e) => setNewPatientId(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-xl text-slate-900"
                >
                  {patients.map(p => (
                    <option key={p._id} value={p._id}>
                      {p.name}{p.userId ? '' : ' (phone only)'}{p.isSynthetic ? ' - synthetic' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Plan template</label>
                <select
                  value={newTemplateId || templates[0]?.id || ''}
                  onChange={(e) => setNewTemplateId(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-xl text-slate-900"
                >
                  {templates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                </select>
              </div>

              {previewTemplate && (
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <pre className="whitespace-pre-wrap text-[11px] text-slate-600 font-sans">{previewTemplate.sourceText}</pre>
                  <ul className="space-y-1 border-t border-slate-200 pt-2">
                    {previewTemplate.tasks.map(t => (
                      <li key={t.key} className="text-[11px] text-slate-700 flex items-center gap-2">
                        <Clock className="w-3 h-3 text-slate-500" />
                        <span>{t.title}</span>
                        <span className="text-slate-500">&bull; due in {t.dueInDays}d</span>
                        {t.dependsOn.length > 0 && <span className="text-slate-500">&bull; after {t.dependsOn.length} task(s)</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-[11px] text-slate-600">
                Creating this plan records you as the approving clinician. PlanPilot will coordinate the logistics only; it never changes clinical instructions.
              </p>

              <button
                type="submit"
                disabled={busy || patients.length === 0 || templates.length === 0}
                className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-bold cursor-pointer"
              >
                {busy ? 'Creating...' : 'Approve and Create Plan'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
