import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import {
  Stethoscope,
  PhoneCall,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Siren,
  CalendarCheck,
  Pill,
  HeartPulse,
  ChevronDown,
  ChevronRight,
  ExternalLink
} from 'lucide-react';

// Care levels from the symptom-check protocol, least to most serious
const LEVEL_STYLES = {
  none: 'bg-slate-100 text-slate-700 border-slate-300',
  self_care: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  doctor_visit: 'bg-sky-50 text-sky-700 border-sky-300',
  urgent: 'bg-amber-50 text-amber-800 border-amber-300',
  emergency: 'bg-rose-50 text-rose-700 border-rose-300',
  call_back: 'bg-violet-50 text-violet-700 border-violet-300'
};

const LEVEL_EXPLAINED = [
  ['self_care', 'Mild problem, short duration, no danger signs: home advice and over-the-counter medicine names from a fixed list ("follow the dose on the pack").'],
  ['doctor_visit', 'Lasted longer than is safe at home, unknown symptom, or a higher-risk person: books a regular appointment.'],
  ['urgent', 'Danger signs not happening right now, chest or breathing symptoms, or severe pain: books the earliest slot (about 2 days) and alerts the clinic.'],
  ['emergency', 'Danger signs happening now (e.g. chest pain with breathlessness, fainting, stroke signs): "dial 112 now"; the clinic team is alerted.']
];

function maskPhone(phone) {
  return phone ? `${phone.slice(0, 3)}••••${phone.slice(-4)}` : 'unknown number';
}

function formatWhen(value) {
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function CheckCard({ check, levels, busy, onReview, onCallAgain }) {
  const needsReview = ['urgent', 'emergency', 'call_back'].includes(check.careLevel) && !check.reviewedAt;
  const advice = check.advice || {};
  return (
    <div className={`p-4 rounded-xl border bg-white shadow-sm space-y-2 text-xs ${check.careLevel === 'emergency' ? 'border-rose-300' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-900">
            {check.callerName || 'Unknown caller'} <span className="font-normal text-slate-500">· {maskPhone(check.phone)}</span>
            {check.isSynthetic && <span className="ml-2 text-[9px] font-mono text-amber-700">SYNTHETIC</span>}
          </div>
          <div className="text-[11px] text-slate-500">
            {formatWhen(check.createdAt)} · {check.channel === 'outbound_call' ? 'CareLoop called them' : check.channel === 'inbound_call' ? 'They called CareLoop' : 'Phone'}
          </div>
        </div>
        <span className={`px-2.5 py-1 rounded-full border text-[11px] font-semibold ${LEVEL_STYLES[check.careLevel] || LEVEL_STYLES.none}`}>
          {levels?.[check.careLevel]?.label || check.careLevelLabel}
        </span>
      </div>

      {check.reported?.symptoms && (
        <p className="text-slate-700">
          <span className="text-slate-500">Reported:</span> “{check.reported.symptoms}”
          {check.reported.durationDays !== null && check.reported.durationDays !== undefined && <> · {check.reported.durationDays} day(s)</>}
          {check.reported.severity && <> · {check.reported.severity}</>}
          {check.reported.age && <> · age {check.reported.age}</>}
        </p>
      )}
      <p className="text-slate-800"><span className="text-slate-500">Decision:</span> {check.reason}</p>

      {check.careLevel === 'emergency' && (
        <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2">
          <Siren className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>Told to call 112 immediately, and that a CareLoop doctor will call back. Please call this person.</span>
        </div>
      )}

      {check.careLevel === 'self_care' && (
        <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 space-y-1.5">
          {advice.selfCare?.length > 0 && (
            <ul className="list-disc pl-4 text-slate-700 space-y-0.5">
              {advice.selfCare.map(tip => <li key={tip}>{tip}</li>)}
            </ul>
          )}
          {advice.medicines?.length > 0 && (
            <div className="space-y-0.5">
              {advice.medicines.map(m => (
                <div key={m.name} className="flex items-start gap-1.5 text-slate-800">
                  <Pill className="w-3.5 h-3.5 text-emerald-700 mt-0.5 flex-shrink-0" />
                  <span><strong>{m.name}</strong> {m.use} · <span className="text-slate-600">{m.how}</span></span>
                </div>
              ))}
            </div>
          )}
          {advice.medicinesNote && <p className="text-amber-800">{advice.medicinesNote}</p>}
          {advice.seeDoctorIf && <p className="text-slate-700"><span className="font-semibold">See a doctor if</span> {advice.seeDoctorIf}.</p>}
          {check.followUpOn && <p className="text-slate-500">Suggested check-in: {new Date(check.followUpOn).toLocaleDateString([], { dateStyle: 'medium' })}</p>}
        </div>
      )}

      {check.appointment ? (
        <div className="p-2.5 rounded-lg bg-sky-50 border border-sky-200 text-slate-800 flex items-start gap-2">
          <CalendarCheck className="w-4 h-4 text-sky-700 flex-shrink-0 mt-0.5" />
          <span>
            Booked <span className="font-mono text-sky-800">{check.appointment.bookingReference}</span>: {check.appointment.providerName} ({check.appointment.specialty}),{' '}
            {formatWhen(check.appointment.startAt)} at {check.appointment.facilityName}
          </span>
        </div>
      ) : ['doctor_visit', 'urgent'].includes(check.careLevel) && (
        <p className="text-slate-600">
          {check.offeredSlots?.length
            ? `Offered ${check.offeredSlots[0].providerName} (${check.offeredSlots[0].specialty}), ${check.offeredSlots[0].spoken}; not booked on the call.`
            : 'No slot was free; the clinic should call back to arrange an appointment.'}
        </p>
      )}

      {needsReview && (
        <div className="flex flex-wrap gap-2">
          {check.careLevel === 'call_back' && check.phone && (
            <button onClick={() => onCallAgain(check)} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-semibold disabled:opacity-50 cursor-pointer">
              <PhoneCall className="w-3.5 h-3.5" /> Call again
            </button>
          )}
          <button onClick={() => onReview(check)} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-700 text-white text-[11px] font-semibold disabled:opacity-50 cursor-pointer">
            <CheckCircle2 className="w-3.5 h-3.5" /> Mark reviewed
          </button>
        </div>
      )}
      {check.reviewedAt && <p className="text-[11px] text-slate-500">Reviewed by {check.reviewedBy?.name} · {formatWhen(check.reviewedAt)}</p>}
    </div>
  );
}

/**
 * Health Calls: CareLoop phones a person (new or existing), asks whether they have a health
 * problem, and follows the symptom-check protocol: home advice, a doctor's appointment, or 112.
 */
export default function HealthCallsPanel({ onChanged }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ name: '', phone: '+91', preferredLanguage: 'hi' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [showProtocol, setShowProtocol] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.getHealthChecks();
      setData(res.data);
    } catch (err) {
      setNotice({ tone: 'error', text: err.message || 'Could not load health checks.' });
    }
  }, []);

  useEffect(() => {
    load();
    // Results arrive while calls are in progress, so keep the list fresh
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  const placeCall = async (details) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.startHealthCheckCall(details);
      setNotice({
        tone: 'success',
        text: res.data.isMock
          ? `Simulated call to ${res.data.person} (fictional number: no real phone rings).`
          : `Calling ${res.data.person} now. Results appear below as the conversation finishes.`
      });
      await load();
    } catch (err) {
      setNotice({ tone: 'error', text: err.message || 'Could not place the call.' });
    } finally {
      setBusy(false);
    }
  };

  const startCall = (e) => {
    e.preventDefault();
    placeCall(form);
  };

  const callAgain = (check) => placeCall({ name: check.callerName || '', phone: check.phone, preferredLanguage: form.preferredLanguage });

  const review = async (check) => {
    setBusy(true);
    try {
      await api.reviewHealthCheck(check._id);
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const checks = data?.checks || [];
  const levels = data?.protocol?.careLevels;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Stethoscope className="w-5 h-5 text-teal-700" />
            <span>Health Calls</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200 font-semibold">Symptom check</span>
          </h2>
          <p className="text-xs text-slate-600">
            CareLoop phones a person, asks about their health, and follows a fixed protocol: home advice for mild problems, a doctor&apos;s appointment for more, and 112 for emergencies.
          </p>
        </div>
        <button onClick={load} className="self-start p-2 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 cursor-pointer" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {notice && (
        <div className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${notice.tone === 'error' ? 'bg-rose-50 border-rose-300 text-rose-800' : 'bg-emerald-50 border-emerald-300 text-emerald-800'}`}>
          {notice.tone === 'error' ? <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <form onSubmit={startCall} className="rounded-2xl bg-white border border-slate-200 shadow-sm p-5 space-y-3 text-xs">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><PhoneCall className="w-4 h-4 text-sky-700" /> Call a person for a health check</h3>
          <label className="block space-y-1">
            <span className="text-slate-700 font-semibold">Name (optional)</span>
            <input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Kartik" className="w-full p-2 bg-white border border-slate-300 rounded-lg text-slate-900" />
          </label>
          <label className="block space-y-1">
            <span className="text-slate-700 font-semibold">Phone (with country code)</span>
            <input required pattern="\+[1-9][0-9]{6,14}" value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value.replace(/\s/g, '') }))} placeholder="+919876543210" className="w-full p-2 bg-white border border-slate-300 rounded-lg text-slate-900 font-mono" />
          </label>
          <label className="block space-y-1">
            <span className="text-slate-700 font-semibold">Language</span>
            <select value={form.preferredLanguage} onChange={(e) => setForm(f => ({ ...f, preferredLanguage: e.target.value }))} className="w-full p-2 bg-white border border-slate-300 rounded-lg text-slate-900">
              <option value="hi">Hindi</option>
              <option value="en">English</option>
            </select>
          </label>
          <button type="submit" disabled={busy} className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer">
            <PhoneCall className="w-4 h-4" /> {busy ? 'Calling...' : 'Call now'}
          </button>
          <p className="text-[11px] text-slate-500">
            The person does not need to be a patient yet; they are added automatically. A Twilio trial account can only call verified numbers. People can also call the clinic number and say they are unwell.
          </p>
        </form>

        <div className="lg:col-span-2 rounded-2xl bg-white border border-slate-200 shadow-sm p-5 space-y-3 text-xs">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><HeartPulse className="w-4 h-4 text-rose-600" /> How CareLoop decides</h3>
          <p className="text-slate-600">The voice assistant only asks the questions (what, how long, how bad, danger signs, age, long-term illness, allergies). Fixed rules on the server decide, and the assistant may only repeat the advice those rules return. It never diagnoses or gives doses.</p>
          <ul className="space-y-1.5">
            {LEVEL_EXPLAINED.map(([level, text]) => (
              <li key={level} className="flex items-start gap-2">
                <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${LEVEL_STYLES[level]}`}>{levels?.[level]?.label || level}</span>
                <span className="text-slate-700">{text}</span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setShowProtocol(s => !s)} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 cursor-pointer">
            {showProtocol ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} Sources and protocol version
          </button>
          {showProtocol && data?.protocol && (
            <div className="space-y-1 text-[11px] text-slate-600">
              <p>Protocol {data.protocol.version}. Thresholds follow NHS guidance. Demo content: a licensed clinician must review it before real use.</p>
              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                {data.protocol.sources.map(src => (
                  <li key={src.url}><a href={src.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-teal-700 hover:text-teal-900">{src.topic} <ExternalLink className="w-3 h-3" /></a></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Recent health checks ({checks.length})</h3>
        {checks.length === 0 && (
          <div className="p-8 rounded-2xl bg-white border border-slate-200 text-center text-xs text-slate-500">
            No health checks yet. Start a call above, or call the clinic number and say you are not feeling well.
          </div>
        )}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {checks.map(check => <CheckCard key={check._id} check={check} levels={levels} busy={busy} onReview={review} onCallAgain={callAgain} />)}
        </div>
      </div>
    </div>
  );
}
