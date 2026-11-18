import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import CarePlansPanel from './CarePlansPanel';
import ReviewQueuePanel from './ReviewQueuePanel';
import DemoLabPanel from './DemoLabPanel';
import HealthCallsPanel from './HealthCallsPanel';
import {
  ClipboardList,
  Activity, 
  LayoutDashboard, 
  Users, 
  Calendar, 
  CalendarClock, 
  AlertTriangle, 
  PhoneCall, 
  HeartPulse, 
  LogOut, 
  RefreshCw, 
  CheckCircle2, 
  XCircle, 
  AlertCircle, 
  Plus, 
  Clock, 
  Phone,
  Trash2,
  RotateCcw,
  ShieldCheck,
  Cpu,
  Terminal,
  ChevronRight,
  Stethoscope,
  FlaskConical
} from 'lucide-react';

// Call outcomes that mean nobody was reached and staff should follow up
const ATTENTION_CALL_STATUSES = ['no-answer', 'busy', 'failed', 'canceled'];

// Mirrors the backend outbound lock: non-terminal and younger than the 2-minute stale window
const IN_FLIGHT_LOCK_STATUSES = ['reserving', 'queued', 'initiated', 'ringing', 'in-progress'];
const STALE_LOCK_MS = 2 * 60 * 1000;

function isOutboundLockActive(lock) {
  if (!lock || !IN_FLIGHT_LOCK_STATUSES.includes(lock.status)) return false;
  const lockedAt = new Date(lock.lockedAt).getTime();
  return Number.isFinite(lockedAt) && Date.now() - lockedAt < STALE_LOCK_MS;
}

export default function ClinicianWorkspace() {
  const { user, logout } = useAuth();
  const [currentTab, setCurrentTab] = useState('overview');
  // PlanPilot review queue: items only a clinician can clear, and the plan to open from the queue
  const [reviewCount, setReviewCount] = useState(0);
  const [focusPlanId, setFocusPlanId] = useState(null);
  const [planSummaries, setPlanSummaries] = useState([]);

  const refreshReviewCount = useCallback(async () => {
    try {
      const [queueRes, plansRes] = await Promise.all([api.getReviewQueue(), api.getCarePlans()]);
      setReviewCount(queueRes.data.actionRequired);
      setPlanSummaries(plansRes.data);
    } catch {
      // The badge is informational; the Review Required tab shows any loading error itself
    }
  }, []);

  const openPlanFromQueue = (planId) => {
    setFocusPlanId(planId);
    setCurrentTab('care-plans');
  };

  // Core Data States
  const [providers, setProviders] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [availableSlots, setAvailableSlots] = useState([]);
  const [voiceConfig, setVoiceConfig] = useState(null);
  const [voiceCalls, setVoiceCalls] = useState([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  // Diagnostics State
  const [apiHealth, setApiHealth] = useState({ loading: true, data: null, error: null, latencyMs: null });
  const [dbHealth, setDbHealth] = useState({ loading: true, data: null, error: null });
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // Modals & Forms State
  const [showBookModal, setShowBookModal] = useState(false);
  const [showAddProviderModal, setShowAddProviderModal] = useState(false);
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [reschedulingAppt, setReschedulingAppt] = useState(null);

  // Booking Form State
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [patientName, setPatientName] = useState('');
  const [patientPhone, setPatientPhone] = useState('');
  const [patientEmail, setPatientEmail] = useState('');
  const [bookingLoading, setBookingLoading] = useState(false);

  // Reschedule Form State
  const [rescheduleSlot, setRescheduleSlot] = useState(null);
  const [rescheduleLoading, setRescheduleLoading] = useState(false);

  // New Provider Form State
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderSpecialty, setNewProviderSpecialty] = useState('');
  const [providerSubmitting, setProviderSubmitting] = useState(false);

  // Outbound Reminder Call State (M5)
  const [showOutboundModal, setShowOutboundModal] = useState(false);
  const [outboundAppt, setOutboundAppt] = useState(null);
  const [outboundPhone, setOutboundPhone] = useState('');
  const [outboundConfirmed, setOutboundConfirmed] = useState(false);
  const [outboundSubmitting, setOutboundSubmitting] = useState(false);
  const [outboundError, setOutboundError] = useState('');
  const [outboundResult, setOutboundResult] = useState(null);

  // Fetch all core workspace data
  const loadWorkspaceData = useCallback(async () => {
    setDataLoading(true);
    setActionError('');
    try {
      const [providersRes, apptsRes, slotsRes, voiceConfigRes, voiceCallsRes] = await Promise.all([
        api.getProviders().catch(() => ({ data: [] })),
        api.getAppointments().catch(() => ({ data: [] })),
        api.getAvailableSlots().catch(() => ({ data: [] })),
        api.getVoiceConfig().catch(() => ({ data: null })),
        api.getVoiceCalls({ limit: 50 }).catch(() => ({ data: [] }))
      ]);

      const provs = providersRes.data || [];
      setProviders(provs);
      setAppointments(apptsRes.data || []);
      setAvailableSlots(slotsRes.data || []);
      setVoiceConfig(voiceConfigRes.data || null);
      setVoiceCalls(voiceCallsRes.data || []);

      if (provs.length > 0 && !selectedProviderId) {
        setSelectedProviderId(provs[0]._id);
      }
      await refreshReviewCount();
    } catch (err) {
      setActionError(err.message || 'Failed to load clinical workspace data');
    } finally {
      setDataLoading(false);
    }
  }, [selectedProviderId, refreshReviewCount]);

  // Diagnostics Health Refresh
  const refreshSystemHealth = useCallback(async () => {
    setApiHealth(prev => ({ ...prev, loading: true, error: null }));
    setDbHealth(prev => ({ ...prev, loading: true, error: null }));
    const start = performance.now();

    try {
      const data = await api.getHealth();
      const latency = Math.round(performance.now() - start);
      setApiHealth({ loading: false, data, error: null, latencyMs: latency });
    } catch (err) {
      setApiHealth({ loading: false, data: null, error: err.message, latencyMs: null });
    }

    try {
      const data = await api.getDbHealth();
      setDbHealth({ loading: false, data, error: null });
    } catch (err) {
      setDbHealth({ loading: false, data: null, error: err.message });
    }

    setLastRefreshed(new Date().toLocaleTimeString());
  }, []);

  useEffect(() => {
    loadWorkspaceData();
    refreshSystemHealth();
  }, [loadWorkspaceData, refreshSystemHealth]);

  // Filter slots for selected provider
  const providerSlots = availableSlots.filter(s => String(s.providerId) === String(selectedProviderId));

  // Handle Create Booking
  const handleCreateBooking = async (e) => {
    e.preventDefault();
    if (!selectedSlot || !patientName.trim()) {
      setActionError('Please select an available slot and enter patient name.');
      return;
    }

    setBookingLoading(true);
    setActionError('');
    setActionSuccess('');

    try {
      const result = await api.createAppointment({
        providerId: selectedSlot.providerId,
        startAt: selectedSlot.startAt,
        endAt: selectedSlot.endAt,
        patient: {
          name: patientName.trim(),
          phone: patientPhone.trim(),
          email: patientEmail.trim()
        },
        idempotencyKey: `MANUAL-${Date.now()}`
      });

      setActionSuccess(`Appointment confirmed! Reference: ${result.data.bookingReference}`);
      setShowBookModal(false);
      setSelectedSlot(null);
      setPatientName('');
      setPatientPhone('');
      setPatientEmail('');
      await loadWorkspaceData();
    } catch (err) {
      setActionError(err.message || 'Booking conflict: Slot is no longer available.');
    } finally {
      setBookingLoading(false);
    }
  };

  // Handle Cancel Booking
  const handleCancelBooking = async (id, ref) => {
    if (!window.confirm(`Are you sure you want to cancel appointment ${ref}?`)) return;

    try {
      await api.cancelAppointment(id, 'Clinician requested cancellation');
      setActionSuccess(`Appointment ${ref} cancelled successfully.`);
      await loadWorkspaceData();
    } catch (err) {
      setActionError(err.message || 'Failed to cancel appointment');
    }
  };

  // Handle Reschedule Booking
  const handleRescheduleSubmit = async (e) => {
    e.preventDefault();
    if (!rescheduleSlot || !reschedulingAppt) return;

    setRescheduleLoading(true);
    setActionError('');
    try {
      await api.rescheduleAppointment(reschedulingAppt._id, {
        newStartAt: rescheduleSlot.startAt,
        newEndAt: rescheduleSlot.endAt
      });

      setActionSuccess(`Appointment ${reschedulingAppt.bookingReference} successfully rescheduled!`);
      setShowRescheduleModal(false);
      setReschedulingAppt(null);
      setRescheduleSlot(null);
      await loadWorkspaceData();
    } catch (err) {
      setActionError(err.message || 'Reschedule conflict: Target slot unavailable.');
    } finally {
      setRescheduleLoading(false);
    }
  };

  // Handle Create Provider
  const handleCreateProvider = async (e) => {
    e.preventDefault();
    if (!newProviderName.trim() || !newProviderSpecialty.trim()) return;

    setProviderSubmitting(true);
    try {
      await api.createProvider({
        name: newProviderName.trim(),
        specialty: newProviderSpecialty.trim(),
        isActive: true
      });
      setNewProviderName('');
      setNewProviderSpecialty('');
      setShowAddProviderModal(false);
      setActionSuccess('New provider registered successfully.');
      await loadWorkspaceData();
    } catch (err) {
      setActionError(err.message || 'Failed to register provider');
    } finally {
      setProviderSubmitting(false);
    }
  };

  // Handle Outbound Call (M5)
  const handleOpenOutboundModal = (appt) => {
    setOutboundAppt(appt);
    setOutboundPhone(appt.patient?.phone || '');
    setOutboundConfirmed(false);
    setOutboundError('');
    setOutboundResult(null);
    setShowOutboundModal(true);
  };

  const handleInitiateOutboundCall = async (e) => {
    e.preventDefault();
    if (!outboundAppt || !outboundConfirmed) return;
    setOutboundSubmitting(true);
    setOutboundError('');
    setOutboundResult(null);

    try {
      const res = await api.placeOutboundCall({
        appointmentId: outboundAppt._id,
        phone: outboundPhone.trim(),
        confirmed: true
      });
      setOutboundResult(res.data);
      setActionSuccess(`Outbound reminder call placed: ${res.data.callSid} (${res.data.status})`);
      await loadWorkspaceData();
    } catch (err) {
      setOutboundError(err.message || 'Failed to initiate outbound call.');
    } finally {
      setOutboundSubmitting(false);
    }
  };

  // Handle Missed-Call Callback Retry (M8.2)
  const [retryingCallSid, setRetryingCallSid] = useState(null);

  const handleRetryCallback = async (callSid) => {
    setRetryingCallSid(callSid);
    try {
      const res = await api.retryCallbackCall({ callbackCallSid: callSid });
      setActionSuccess(`Callback retry initiated: ${res.data?.callSid || 'Queued'}`);
      await loadWorkspaceData();
    } catch (err) {
      setActionError(err.message || 'Callback retry failed.');
    } finally {
      setRetryingCallSid(null);
    }
  };

  const callsNeedingAttention = voiceCalls.filter(c => ATTENTION_CALL_STATUSES.includes(c.status));

  const navItems = [
    { id: 'overview', label: 'Dashboard Overview', icon: LayoutDashboard },
    { id: 'health-calls', label: 'Health Calls', icon: Stethoscope, badge: 'Symptom check', badgeColor: 'bg-sky-50 text-sky-700 border-sky-200' },
    { id: 'care-plans', label: 'Care Plans', icon: ClipboardList, badge: 'PlanPilot', badgeColor: 'bg-teal-50 text-teal-700 border-teal-200' },
    { id: 'appointments', label: 'Appointments & Booking', icon: Calendar, badge: `${appointments.filter(a => a.status === 'confirmed').length} Active`, badgeColor: 'bg-teal-50 text-teal-700 border-teal-200' },
    { id: 'providers', label: 'Providers & Schedules', icon: Users, badge: `${providers.length} Doctors` },
    { id: 'workflows', label: 'Follow-up Workflows', icon: CalendarClock, badge: `${voiceCalls.filter(c => c.direction === 'outbound').length} Calls`, badgeColor: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
    { id: 'agent-activity', label: 'Voice Agent Activity', icon: PhoneCall, badge: `${voiceCalls.length} Calls` },
    {
      id: 'review-required',
      label: 'Review Required',
      icon: AlertTriangle,
      badge: `${callsNeedingAttention.length + reviewCount} Pending`,
      badgeColor: callsNeedingAttention.length + reviewCount > 0
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-slate-100 text-slate-600 border border-slate-300'
    },
    { id: 'demo-lab', label: 'Demo Lab', icon: FlaskConical, badge: 'Simulation', badgeColor: 'bg-amber-50 text-amber-700 border-amber-200' },
    { id: 'system-status', label: 'System Health', icon: HeartPulse }
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col selection:bg-teal-500 selection:text-slate-900">
      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-teal-400 to-emerald-600 flex items-center justify-center shadow-md shadow-teal-500/20">
              <Activity className="w-5 h-5 text-slate-950 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-base tracking-tight text-slate-900">CareLoop</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 font-medium border border-teal-200">
                  Clinician Portal
                </span>
              </div>
              <p className="text-[11px] text-slate-600">AI care coordination by phone, in Hindi and English</p>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <div className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-300 text-xs">
              <span className={`w-2 h-2 rounded-full ${dbHealth.data?.status === 'connected' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`}></span>
              <span className="text-slate-700 text-[11px]">
                {dbHealth.data?.status === 'connected' ? 'System online' : 'Database offline'}
              </span>
            </div>


            <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-slate-100 border border-slate-300">
              <div className="w-7 h-7 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center font-bold text-xs">
                Dr
              </div>
              <div className="text-left">
                <div className="text-xs font-semibold text-slate-900 leading-tight">{user?.name}</div>
                <div className="text-[10px] text-teal-600 font-mono capitalize">Role: {user?.role}</div>
              </div>
            </div>

            <button
              onClick={logout}
              title="Sign Out"
              className="p-2 rounded-xl text-slate-600 hover:text-rose-700 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition-all cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Workspace Alerts */}
      <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 pt-4">
        {actionError && (
          <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-300 text-rose-700 text-xs flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
              <span>{actionError}</span>
            </div>
            <button onClick={() => setActionError('')} className="text-rose-600 hover:text-rose-800 text-xs">Dismiss</button>
          </div>
        )}
        {actionSuccess && (
          <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-700 text-xs flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
              <span>{actionSuccess}</span>
            </div>
            <button onClick={() => setActionSuccess('')} className="text-emerald-600 hover:text-emerald-800 text-xs">Dismiss</button>
          </div>
        )}
      </div>

      {/* Main Workspace Layout */}
      <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-4 flex flex-col md:flex-row gap-6">
        {/* Sidebar */}
        <aside className="w-full md:w-64 flex-shrink-0 space-y-4">
          <nav className="bg-white border border-slate-200 rounded-2xl p-2 space-y-1 shadow-sm">
            {navItems.map(item => {
              const Icon = item.icon;
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setCurrentTab(item.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                    isActive 
                      ? 'bg-teal-100 text-teal-700 border border-teal-300 shadow-sm' 
                      : 'text-slate-600 hover:text-slate-800 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Icon className={`w-4 h-4 ${isActive ? 'text-teal-600' : 'text-slate-600'}`} />
                    <span>{item.label}</span>
                  </div>
                  {item.badge && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-mono ${
                      item.badgeColor || 'bg-slate-100 text-slate-600 border border-slate-300'
                    }`}>
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="p-4 rounded-2xl bg-white border border-slate-200 text-xs text-slate-600 space-y-2 shadow-sm">
            <div className="flex items-center gap-2 text-teal-600 font-semibold">
              <ShieldCheck className="w-4 h-4" />
              <span>Safe by design</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-600">
              CareLoop never diagnoses. Emergencies are sent to 112, clinical changes need a doctor&apos;s approval, and a task only counts as done with proof.
            </p>
          </div>
        </aside>

        {/* Dynamic Content Area */}
        <main className="flex-1 min-w-0 space-y-6">
          {/* TAB 1: OVERVIEW */}
          {currentTab === 'overview' && (
            <div className="space-y-6">
              <div className="rounded-2xl p-6 bg-gradient-to-r from-white via-white to-teal-50 border border-slate-200 shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-teal-50 text-teal-700 text-xs border border-teal-200 font-medium">
                    <Cpu className="w-3 h-3 text-teal-600" />
                    <span>Live</span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
                    Clinical Supervision Dashboard
                  </h2>
                  <p className="text-xs sm:text-sm text-slate-600 max-w-xl">
                    Appointments, doctors, health calls, and care plans at a glance.
                  </p>
                </div>
                <button
                  onClick={loadWorkspaceData}
                  className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 transition-all cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${dataLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </button>
              </div>

              {/* PlanPilot at a glance */}
              {(() => {
                const active = planSummaries.filter(p => p.status === 'active');
                const sum = (key) => planSummaries.reduce((total, p) => total + (p.progress?.[key] || 0), 0);
                return (
                  <button
                    onClick={() => setCurrentTab('care-plans')}
                    className="w-full text-left rounded-2xl p-5 bg-teal-50 border border-teal-200 hover:border-teal-400 transition-colors cursor-pointer shadow-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        <ClipboardList className="w-4 h-4 text-teal-700" />
                        <span>PlanPilot care plans</span>
                      </div>
                      <span className="text-[11px] text-teal-700">Open Care Plans &rarr;</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                      <div><div className="text-xl font-bold text-slate-900">{active.length}</div><div className="text-slate-600">Active plans</div></div>
                      <div><div className="text-xl font-bold text-emerald-700">{sum('completed')}<span className="text-sm text-slate-500">/{sum('total')}</span></div><div className="text-slate-600">Tasks completed with evidence</div></div>
                      <div><div className="text-xl font-bold text-amber-700">{sum('blocked')}</div><div className="text-slate-600">Blocked</div></div>
                      <div><div className="text-xl font-bold text-rose-700">{sum('escalated')}</div><div className="text-slate-600">Escalated</div></div>
                      <div><div className="text-xl font-bold text-violet-700">{reviewCount}</div><div className="text-slate-600">Need a clinician</div></div>
                    </div>
                  </button>
                );
              })()}

              {/* 4 Live Metrics Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* 1. Confirmed Bookings */}
                <div className="rounded-2xl p-4 bg-white border border-slate-200 space-y-2 shadow-sm">
                  <div className="flex items-center justify-between text-teal-600">
                    <Calendar className="w-4 h-4" />
                    <span className="text-[10px] uppercase font-bold text-slate-600">Bookings</span>
                  </div>
                  <div className="text-2xl font-bold text-slate-900">
                    {appointments.filter(a => a.status === 'confirmed').length}
                  </div>
                  <div className="text-xs text-slate-700 font-medium">Active Appointments</div>
                  <div className="text-[11px] text-slate-600">{appointments.filter(a => a.status === 'cancelled').length} cancelled in history</div>
                </div>

                {/* 2. Registered Providers */}
                <div className="rounded-2xl p-4 bg-white border border-slate-200 space-y-2 shadow-sm">
                  <div className="flex items-center justify-between text-indigo-600">
                    <Users className="w-4 h-4" />
                    <span className="text-[10px] uppercase font-bold text-slate-600">Providers</span>
                  </div>
                  <div className="text-2xl font-bold text-slate-900">{providers.length}</div>
                  <div className="text-xs text-slate-700 font-medium">Medical Doctors</div>
                  <div className="text-[11px] text-slate-600">{providers.filter(p => p.isActive).length} active for scheduling</div>
                </div>

                {/* 3. Real-time Available Slots */}
                <div className="rounded-2xl p-4 bg-white border border-slate-200 space-y-2 shadow-sm">
                  <div className="flex items-center justify-between text-emerald-600">
                    <Clock className="w-4 h-4" />
                    <span className="text-[10px] uppercase font-bold text-slate-600">Slots</span>
                  </div>
                  <div className="text-2xl font-bold text-slate-900">{availableSlots.length}</div>
                  <div className="text-xs text-slate-700 font-medium">Valid Open Slots</div>
                  <div className="text-[11px] text-slate-600">Excludes past and booked times</div>
                </div>

                {/* 4. Calls Needing Follow-up */}
                <button
                  onClick={() => setCurrentTab('review-required')}
                  className="text-left rounded-2xl p-4 bg-white border border-slate-200 space-y-2 hover:border-amber-300 transition-colors cursor-pointer shadow-sm"
                >
                  <div className="flex items-center justify-between text-cyan-600">
                    <AlertTriangle className="w-4 h-4" />
                    <span className="text-[10px] uppercase font-bold text-slate-600">Needs Attention</span>
                  </div>
                  <div className="text-2xl font-bold text-slate-900">{callsNeedingAttention.length + reviewCount}</div>
                  <div className="text-xs text-slate-700 font-medium">Waiting on a Clinician</div>
                  <div className="text-[11px] text-slate-600">{reviewCount} care-plan item(s) &bull; {callsNeedingAttention.length} unreached call(s)</div>
                </button>
              </div>

              {/* Recent Bookings Quick Table */}
              <div className="rounded-2xl p-5 bg-white border border-slate-200 space-y-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-teal-600" />
                    <span>Recent Confirmed Bookings</span>
                  </h3>
                  <button
                    onClick={() => setCurrentTab('appointments')}
                    className="text-xs text-teal-600 hover:text-teal-700 flex items-center gap-1 cursor-pointer"
                  >
                    <span>View All</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                {appointments.length === 0 ? (
                  <div className="text-center py-8 text-xs text-slate-600 space-y-2">
                    <Calendar className="w-8 h-8 text-slate-300 mx-auto" />
                    <p>No appointments yet. Bookings made on calls or here will appear in this list.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-600">
                          <th className="pb-2.5 font-medium">Reference</th>
                          <th className="pb-2.5 font-medium">Patient</th>
                          <th className="pb-2.5 font-medium">Scheduled Time</th>
                          <th className="pb-2.5 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {appointments.slice(0, 5).map(appt => (
                          <tr key={appt._id} className="hover:bg-slate-100">
                            <td className="py-2.5 font-mono text-teal-700">{appt.bookingReference}</td>
                            <td className="py-2.5 text-slate-900 font-medium">{appt.patient?.name}</td>
                            <td className="py-2.5 text-slate-700 font-mono">
                              {new Date(appt.startAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                            </td>
                            <td className="py-2.5">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${
                                appt.status === 'confirmed' ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-slate-100 text-slate-600'
                              }`}>
                                {appt.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB: PLANPILOT CARE PLANS */}
          {currentTab === 'care-plans' && <CarePlansPanel focusPlanId={focusPlanId} onDataChanged={refreshReviewCount} />}

          {/* TAB 2: APPOINTMENTS & BOOKING */}
          {currentTab === 'appointments' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900 tracking-tight">Appointment Management</h2>
                  <p className="text-xs text-slate-600">Live booking engine, cancellation, and reschedule controls</p>
                </div>
                <button
                  id="open-book-modal-btn"
                  onClick={() => setShowBookModal(true)}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl bg-teal-600 hover:bg-teal-500 text-white shadow-md shadow-teal-500/20 transition-all cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Book Appointment</span>
                </button>
              </div>

              {/* Appointments List */}
              <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-4 shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                  <div className="text-xs font-semibold text-slate-700">
                    All Appointments ({appointments.length})
                  </div>
                  <button onClick={loadWorkspaceData} className="text-xs text-slate-600 hover:text-slate-900 flex items-center gap-1 cursor-pointer">
                    <RefreshCw className={`w-3.5 h-3.5 ${dataLoading ? 'animate-spin' : ''}`} />
                    <span>Refresh</span>
                  </button>
                </div>

                {appointments.length === 0 ? (
                  <div className="text-center py-12 text-xs text-slate-600 space-y-3">
                    <Calendar className="w-10 h-10 text-slate-300 mx-auto" />
                    <p className="font-medium text-slate-700">No appointments scheduled</p>
                    <p className="text-slate-500">Bookings created by clinicians or future voice agents will appear here.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {appointments.map(appt => {
                      const providerObj = providers.find(p => String(p._id) === String(appt.providerId));
                      const isConfirmed = appt.status === 'confirmed';

                      return (
                        <div key={appt._id} className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold text-teal-600">{appt.bookingReference}</span>
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                                isConfirmed 
                                  ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' 
                                  : 'bg-rose-50 text-rose-600 border border-rose-200'
                              }`}>
                                {appt.status}
                              </span>
                              {appt.rescheduledFrom && (
                                <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                                  Rescheduled
                                </span>
                              )}
                            </div>
                            <div className="text-sm font-semibold text-slate-900">{appt.patient?.name}</div>
                            <div className="text-xs text-slate-600 flex items-center gap-4 flex-wrap">
                              <span>Doctor: <strong className="text-slate-700">{providerObj?.name || 'Assigned Clinician'}</strong></span>
                              <span>&bull;</span>
                              <span className="font-mono text-slate-700">
                                {new Date(appt.startAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                              </span>
                              {(() => {
                                const callRecord = voiceCalls.find(c => 
                                  c.direction === 'outbound' && 
                                  (String(c.appointmentId) === String(appt._id) || c.bookingReference === appt.bookingReference)
                                );
                                if (!callRecord) return null;
                                return (
                                  <>
                                    <span>&bull;</span>
                                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                      callRecord.status === 'completed' 
                                        ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' 
                                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                                    }`}>
                                      Reminder: {callRecord.status} {callRecord.durationSeconds ? `(${callRecord.durationSeconds}s)` : ''}
                                    </span>
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${
                                      callRecord.isMock ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-teal-50 text-teal-700 border border-teal-200'
                                    }`}>
                                      {callRecord.isMock ? 'MOCK' : 'LIVE'}
                                    </span>
                                  </>
                                );
                              })()}
                            </div>
                          </div>

                          {/* Actions */}
                          {isConfirmed && (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleOpenOutboundModal(appt)}
                                className="px-3 py-1.5 rounded-lg bg-teal-50 hover:bg-teal-100 text-teal-700 text-xs font-medium border border-teal-200 transition-colors flex items-center gap-1.5 cursor-pointer"
                                title="Initiate AI Voice Reminder Call"
                              >
                                <PhoneCall className="w-3.5 h-3.5" />
                                <span>Call Reminder</span>
                              </button>
                              <button
                                onClick={() => {
                                  setReschedulingAppt(appt);
                                  setSelectedProviderId(appt.providerId);
                                  setShowRescheduleModal(true);
                                }}
                                className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium border border-slate-300 transition-colors flex items-center gap-1.5 cursor-pointer"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Reschedule</span>
                              </button>
                              <button
                                onClick={() => handleCancelBooking(appt._id, appt.bookingReference)}
                                className="px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-medium border border-rose-200 transition-colors flex items-center gap-1.5 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>Cancel</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: PROVIDERS & SCHEDULES */}
          {currentTab === 'providers' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900 tracking-tight">Healthcare Providers</h2>
                  <p className="text-xs text-slate-600">Manage registered doctors, specialties, and schedule availability</p>
                </div>
                <button
                  onClick={() => setShowAddProviderModal(true)}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl bg-teal-600 hover:bg-teal-500 text-white shadow-md shadow-teal-500/20 transition-all cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Register Provider</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {providers.map(prov => {
                  const slotsForProv = availableSlots.filter(s => String(s.providerId) === String(prov._id));
                  return (
                    <div key={prov._id} className="p-5 rounded-2xl bg-white border border-slate-200 space-y-4 flex flex-col justify-between shadow-sm">
                      <div className="space-y-2">
                        <div className="flex items-start justify-between">
                          <div className="w-10 h-10 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center font-bold text-sm">
                            <Stethoscope className="w-5 h-5" />
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            prov.isActive ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-slate-100 text-slate-600'
                          }`}>
                            {prov.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                        <div>
                          <div className="text-sm font-bold text-slate-900">{prov.name}</div>
                          <div className="text-xs text-teal-600 font-medium">{prov.specialty}</div>
                        </div>
                      </div>

                      <div className="border-t border-slate-200 pt-3 text-xs space-y-1 text-slate-600">
                        <div className="flex justify-between">
                          <span>Available Slots:</span>
                          <span className="font-mono text-slate-900 font-semibold">{slotsForProv.length}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 4: INBOUND VOICE AGENT SUPERVISION */}
          {currentTab === 'agent-activity' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900 tracking-tight">Inbound Voice Agent Supervision</h2>
                  <p className="text-xs text-slate-600">Twilio Telephony & Ultravox Real-Time Conversational AI Pipeline</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 ${
                    voiceConfig?.telephony?.isConfigured && voiceConfig?.voiceAgent?.isConfigured
                      ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                      : 'bg-amber-50 text-amber-700 border border-amber-200'
                  }`}>
                    <span className={`w-2 h-2 rounded-full ${
                      voiceConfig?.telephony?.isConfigured && voiceConfig?.voiceAgent?.isConfigured
                        ? 'bg-emerald-400 animate-pulse'
                        : 'bg-amber-400'
                    }`}></span>
                    <span>{voiceConfig?.isMockMode ? 'Simulation Mode Active' : 'Live Voice Pipeline'}</span>
                  </span>
                  <button
                    onClick={loadWorkspaceData}
                    className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs flex items-center gap-1 border border-slate-300 cursor-pointer"
                    title="Refresh Voice Logs"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${dataLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Status Metric Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Telephony Config */}
                <div className="p-4 rounded-2xl bg-white border border-slate-200 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700 flex items-center gap-2">
                      <Phone className="w-4 h-4 text-teal-600" />
                      <span>Telephony Carrier</span>
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                      {voiceConfig?.telephony?.provider || 'Twilio'}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="text-sm font-bold text-slate-900 font-mono">
                      {voiceConfig?.telephony?.phoneNumber || 'Not Configured'}
                    </div>
                    <p className="text-[11px] text-slate-600">Inbound Webhook Connected</p>
                  </div>
                  <div className="text-[10px] font-mono text-slate-500 truncate" title={voiceConfig?.webhooks?.inboundUrl}>
                    {voiceConfig?.webhooks?.inboundUrl || '/api/voice/inbound'}
                  </div>
                </div>

                {/* Ultravox Agent */}
                <div className="p-4 rounded-2xl bg-white border border-slate-200 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700 flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-emerald-600" />
                      <span>Voice Model</span>
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                      {voiceConfig?.voiceAgent?.provider || 'Ultravox'}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="text-sm font-bold text-slate-900 font-mono">
                      {voiceConfig?.voiceAgent?.model || 'ultravox-v0.7'}
                    </div>
                    <p className="text-[11px] text-slate-600">
                      Voice: <strong className="text-slate-700">{voiceConfig?.voiceAgent?.voice || 'Not configured'}</strong> &bull; Streaming WebSockets
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-600 font-medium">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Emergency Protocol Active ({voiceConfig?.emergencyGuidance?.region || 'IN'}: {voiceConfig?.emergencyGuidance?.emergencyNumber || '112'})</span>
                  </div>
                </div>

                {/* Call Stats */}
                <div className="p-4 rounded-2xl bg-white border border-slate-200 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700 flex items-center gap-2">
                      <Activity className="w-4 h-4 text-indigo-600" />
                      <span>Call Volume</span>
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                      Recent: {voiceCalls.length}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="text-sm font-bold text-slate-900">
                      {voiceCalls.filter(c => c.status === 'completed' || c.status === 'in-progress').length} Connected
                    </div>
                    <p className="text-[11px] text-slate-600">
                      {voiceCalls.filter(c => c.direction === 'inbound').length} inbound &bull; {voiceCalls.filter(c => c.direction === 'outbound').length} outbound
                    </p>
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {callsNeedingAttention.length} call(s) did not reach the patient
                  </div>
                </div>
              </div>

              {/* Call Activity Logs */}
              <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-4 shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                  <h3 className="text-xs font-semibold text-slate-700">Recent Voice Calls ({voiceCalls.length})</h3>
                  <span className="text-[11px] text-slate-500">Privacy Safeguards Active &bull; Numbers Masked</span>
                </div>

                {voiceCalls.length === 0 ? (
                  <div className="text-center py-12 text-xs text-slate-600 space-y-3">
                    <PhoneCall className="w-10 h-10 text-slate-300 mx-auto" />
                    <p className="font-medium text-slate-700">No inbound calls received yet</p>
                    <p className="text-slate-500 max-w-sm mx-auto">
                      Callers dialing your Twilio phone number will be routed to the Ultravox voice agent and appear in this live log.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-600 text-[11px]">
                          <th className="pb-2.5 font-medium">Time</th>
                          <th className="pb-2.5 font-medium">Call SID</th>
                          <th className="pb-2.5 font-medium">Direction</th>
                          <th className="pb-2.5 font-medium">From / To</th>
                          <th className="pb-2.5 font-medium">Duration</th>
                          <th className="pb-2.5 font-medium">Status</th>
                          <th className="pb-2.5 font-medium">Tool Activity</th>
                          <th className="pb-2.5 font-medium">Environment</th>
                          <th className="pb-2.5 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {voiceCalls.map(call => (
                          <tr key={call._id} className="text-slate-700 hover:bg-slate-100">
                            <td className="py-3 font-mono text-[11px] text-slate-600">
                              {new Date(call.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </td>
                            <td className="py-3 font-mono text-[11px] text-teal-600">
                              {call.callSid ? `${call.callSid.slice(0, 14)}...` : 'N/A'}
                            </td>
                            <td className="py-3">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                                call.direction === 'outbound'
                                  ? 'bg-purple-50 text-purple-700 border border-purple-200'
                                  : 'bg-cyan-50 text-cyan-700 border border-cyan-200'
                              }`}>
                                {call.direction || 'inbound'}
                              </span>
                              {call.callIntent === 'missed_call_callback' && (
                                <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-teal-50 text-teal-700 border border-teal-200">
                                  Callback
                                </span>
                              )}
                              {call.callIntent === 'planpilot_care' && (
                                <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-sky-50 text-sky-700 border border-sky-200">
                                  PlanPilot
                                </span>
                              )}
                            </td>
                            <td className="py-3 font-mono text-slate-800">
                              <div>{call.direction === 'outbound' ? `To: ${call.to}` : `From: ${call.from}`}</div>
                              {call.bookingReference && (
                                <div className="text-[10px] font-mono text-teal-600">Ref: {call.bookingReference}</div>
                              )}
                            </td>
                            <td className="py-3 font-mono text-slate-600">
                              {call.durationSeconds ? `${call.durationSeconds}s` : '--'}
                            </td>
                            <td className="py-3">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                                call.status === 'completed'
                                  ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                                  : call.status === 'in-progress' || call.status === 'initiated' || call.status === 'queued'
                                  ? 'bg-blue-50 text-blue-600 border border-blue-200 animate-pulse'
                                  : 'bg-rose-50 text-rose-600 border border-rose-200'
                              }`}>
                                {call.status}
                              </span>
                            </td>
                            <td className="py-3">
                              {call.toolEvents && call.toolEvents.length > 0 ? (
                                <div className="flex flex-wrap gap-1 max-w-xs">
                                  {call.toolEvents.map((evt, idx) => (
                                    <span
                                      key={idx}
                                      className={`text-[9px] px-1.5 py-0.5 rounded font-mono border ${
                                        evt.status === 'success' || evt.status === 'completed'
                                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                          : evt.status === 'needs_confirmation'
                                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                                          : evt.status === 'slot_conflict'
                                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                                          : 'bg-slate-100 text-slate-700 border-slate-300'
                                      }`}
                                      title={evt.bookingReference ? `Ref: ${evt.bookingReference}` : evt.toolName}
                                    >
                                      {evt.toolName}
                                      {evt.status === 'needs_confirmation' ? ' (pending)' : ''}
                                      {evt.status === 'slot_conflict' ? ' (conflict)' : ''}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-[10px] text-slate-400 font-mono">None</span>
                              )}
                            </td>
                            <td className="py-3">
                              <span className={`text-[10px] px-2 py-0.5 rounded-md font-mono ${
                                call.isMock
                                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                  : 'bg-teal-50 text-teal-700 border border-teal-200'
                              }`}>
                                {call.isMock ? 'Mock Call' : 'Real Telephony'}
                              </span>
                            </td>
                            <td className="py-3 text-right">
                              {call.direction === 'outbound' && call.callIntent === 'missed_call_callback' && ['failed', 'no-answer', 'busy'].includes(call.status) ? (
                                <button
                                  onClick={() => handleRetryCallback(call.callSid)}
                                  disabled={retryingCallSid === call.callSid}
                                  className="px-2 py-1 rounded bg-teal-50 hover:bg-teal-100 text-teal-700 border border-teal-300 text-[10px] font-semibold transition-all cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
                                  title="Retry callback under safe bounded policy"
                                >
                                  <RotateCcw className={`w-3 h-3 ${retryingCallSid === call.callSid ? 'animate-spin' : ''}`} />
                                  <span>{retryingCallSid === call.callSid ? 'Retrying...' : 'Retry'}</span>
                                </button>
                              ) : (
                                <span className="text-[10px] text-slate-400 font-mono">--</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: FOLLOW-UP WORKFLOWS (M7 End-to-End Supervision) */}
          {currentTab === 'workflows' && (() => {
            const confirmedAppts = appointments.filter(a => a.status === 'confirmed');
            const outboundCalls = voiceCalls.filter(c => c.direction === 'outbound');
            const completedCalls = outboundCalls.filter(c => c.status === 'completed');
            const inFlightCalls = outboundCalls.filter(c => ['queued', 'initiated', 'ringing', 'in-progress'].includes(c.status));
            const exceptionCalls = outboundCalls.filter(c => ['no-answer', 'busy', 'failed', 'canceled'].includes(c.status));
            const isSimulation = Boolean(voiceConfig?.isMockMode) || !voiceConfig?.telephony?.isConfigured;

            return (
              <div className="space-y-6">
                {/* Header Banner */}
                <div className="rounded-2xl p-6 bg-gradient-to-r from-white via-indigo-50 to-white border border-slate-200 shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs border border-indigo-200 font-medium">
                      <CalendarClock className="w-3.5 h-3.5 text-indigo-600" />
                      <span>Reminder calls</span>
                    </div>
                    <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
                      Outbound Follow-up & Voice Reminder Supervision
                    </h2>
                    <p className="text-xs sm:text-sm text-slate-600 max-w-2xl">
                      Dispatch AI voice appointment reminders, monitor live Twilio/Ultravox call lifecycles, and supervise patient outcomes in real time.
                    </p>
                  </div>
                  <button
                    onClick={loadWorkspaceData}
                    className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 transition-all cursor-pointer self-start sm:self-auto"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${dataLoading ? 'animate-spin' : ''}`} />
                    <span>Refresh</span>
                  </button>
                </div>

                {/* Telephony Environment Indicator */}
                <div className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs ${
                  isSimulation 
                    ? 'bg-amber-50 border-amber-200 text-amber-800' 
                    : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                }`}>
                  <div className="flex items-center gap-2.5">
                    <span className={`w-2.5 h-2.5 rounded-full ${isSimulation ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`}></span>
                    <div>
                      <span className="font-semibold text-slate-900">
                        {isSimulation ? 'Simulation mode' : 'Live calling'}
                      </span>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        {isSimulation 
                          ? 'Calls are simulated; no real phone rings.'
                          : `Real calls from ${voiceConfig?.telephony?.phoneNumber || 'the clinic number'}, with the Hindi/English AI voice assistant.`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      isSimulation ? 'bg-amber-100 text-amber-700 border border-amber-300' : 'bg-emerald-100 text-emerald-700 border border-emerald-300'
                    }`}>
                      {isSimulation ? 'Simulated' : 'Live'}
                    </span>
                  </div>
                </div>

                {/* 4 Supervision Metrics Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="rounded-2xl p-4 bg-white border border-slate-200 space-y-2 shadow-sm">
                    <div className="flex items-center justify-between text-indigo-600">
                      <Calendar className="w-4 h-4" />
                      <span className="text-[10px] uppercase font-bold text-slate-600">Target Queue</span>
                    </div>
                    <div className="text-2xl font-bold text-slate-900">{confirmedAppts.length}</div>
                    <div className="text-xs text-slate-700 font-medium">Confirmed Appointments</div>
                    <div className="text-[11px] text-slate-600">Eligible for AI follow-up reminders</div>
                  </div>

                  <div className="rounded-2xl p-4 bg-white border border-slate-200 space-y-2 shadow-sm">
                    <div className="flex items-center justify-between text-emerald-600">
                      <CheckCircle2 className="w-4 h-4" />
                      <span className="text-[10px] uppercase font-bold text-slate-600">Delivered</span>
                    </div>
                    <div className="text-2xl font-bold text-emerald-600">{completedCalls.length}</div>
                    <div className="text-xs text-slate-700 font-medium">Calls Completed</div>
                    <div className="text-[11px] text-slate-600">Call connected and ended. Does not confirm attendance.</div>
                  </div>

                  <div className="rounded-2xl p-4 bg-white border border-slate-200 space-y-2 shadow-sm">
                    <div className="flex items-center justify-between text-blue-600">
                      <PhoneCall className={`w-4 h-4 ${inFlightCalls.length > 0 ? 'animate-bounce' : ''}`} />
                      <span className="text-[10px] uppercase font-bold text-slate-600">In-Flight</span>
                    </div>
                    <div className="text-2xl font-bold text-blue-600">{inFlightCalls.length}</div>
                    <div className="text-xs text-slate-700 font-medium">Active Calls</div>
                    <div className="text-[11px] text-slate-600">Queued, ringing, or connected</div>
                  </div>

                  <div className="rounded-2xl p-4 bg-white border border-slate-200 space-y-2 shadow-sm">
                    <div className="flex items-center justify-between text-rose-600">
                      <AlertCircle className="w-4 h-4" />
                      <span className="text-[10px] uppercase font-bold text-slate-600">Exceptions</span>
                    </div>
                    <div className="text-2xl font-bold text-slate-900">{exceptionCalls.length}</div>
                    <div className="text-xs text-slate-700 font-medium">Failed / Unanswered</div>
                    <div className="text-[11px] text-slate-600">Eligible for clinician redial</div>
                  </div>
                </div>

                {/* Follow-up Supervision Table */}
                <div className="rounded-2xl p-5 bg-white border border-slate-200 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                        <PhoneCall className="w-4 h-4 text-indigo-600" />
                        <span>Appointment Follow-up Roster</span>
                      </h3>
                      <p className="text-[11px] text-slate-600">
                        Tracks confirmed bookings and their outbound AI reminder status. Concurrency lock prevents duplicate dials.
                      </p>
                    </div>
                    <span className="text-xs text-slate-600 font-mono">
                      {confirmedAppts.length} Patient{confirmedAppts.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  {confirmedAppts.length === 0 ? (
                    <div className="text-center py-10 text-xs text-slate-600 space-y-2">
                      <CalendarClock className="w-8 h-8 text-slate-300 mx-auto" />
                      <p>No confirmed appointments found to supervise.</p>
                      <button
                        onClick={() => setCurrentTab('appointments')}
                        className="text-indigo-600 hover:text-indigo-700 font-semibold"
                      >
                        Create a test booking in Appointments tab →
                      </button>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-600">
                            <th className="pb-3 font-medium">Appointment & Patient</th>
                            <th className="pb-3 font-medium">Scheduled Time</th>
                            <th className="pb-3 font-medium">Follow-up Status</th>
                            <th className="pb-3 font-medium">Mode</th>
                            <th className="pb-3 font-medium">Call Details</th>
                            <th className="pb-3 font-medium text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                          {confirmedAppts.map(appt => {
                            // Find latest outbound call for this appointment
                            const apptCalls = outboundCalls.filter(c => String(c.appointmentId) === String(appt._id));
                            const latestCall = apptCalls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
                            const lock = appt.outboundCallLock;
                            const isLocked = isOutboundLockActive(lock);
                            const status = latestCall?.status || (isLocked ? 'queued' : 'not_dispatched');
                            const isMockCall = latestCall ? latestCall.isMock : isSimulation;

                            return (
                              <tr key={appt._id} className="hover:bg-slate-100 transition-colors">
                                <td className="py-3">
                                  <div className="font-mono text-indigo-700 font-semibold">{appt.bookingReference}</div>
                                  <div className="text-slate-900 font-medium">{appt.patient?.name}</div>
                                  <div className="text-[11px] text-slate-600 font-mono">{appt.patient?.phone || 'No phone'}</div>
                                </td>
                                <td className="py-3">
                                  <div className="text-slate-800 font-medium">
                                    {new Date(appt.startAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                                  </div>
                                  <div className="text-[11px] text-slate-600 font-mono">
                                    {new Date(appt.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </div>
                                </td>
                                <td className="py-3">
                                  {status === 'completed' && (
                                    <span
                                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-600 border border-emerald-200"
                                      title="The call connected and ended. This does not confirm the patient will attend."
                                    >
                                      <CheckCircle2 className="w-3 h-3" />
                                      <span>Call Completed</span>
                                    </span>
                                  )}
                                  {['queued', 'initiated'].includes(status) && (
                                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                                      <Clock className="w-3 h-3 animate-spin" />
                                      <span>Queued</span>
                                    </span>
                                  )}
                                  {status === 'ringing' && (
                                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 animate-pulse">
                                      <PhoneCall className="w-3 h-3" />
                                      <span>Ringing</span>
                                    </span>
                                  )}
                                  {status === 'in-progress' && (
                                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 animate-pulse">
                                      <PhoneCall className="w-3 h-3" />
                                      <span>In Progress</span>
                                    </span>
                                  )}
                                  {['no-answer', 'busy'].includes(status) && (
                                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-600 border border-amber-200">
                                      <AlertCircle className="w-3 h-3" />
                                      <span className="capitalize">{status}</span>
                                    </span>
                                  )}
                                  {['failed', 'canceled'].includes(status) && (
                                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-600 border border-rose-200">
                                      <XCircle className="w-3 h-3" />
                                      <span className="capitalize">{status}</span>
                                    </span>
                                  )}
                                  {status === 'not_dispatched' && (
                                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-300">
                                      <span>Not Dispatched</span>
                                    </span>
                                  )}
                                </td>
                                <td className="py-3">
                                  {latestCall ? (
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                                      isMockCall 
                                        ? 'bg-amber-50 text-amber-700 border-amber-200' 
                                        : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    }`}>
                                      {isMockCall ? 'Simulation' : 'Live Call'}
                                    </span>
                                  ) : (
                                    <span className="text-[11px] text-slate-500">—</span>
                                  )}
                                </td>
                                <td className="py-3">
                                  {latestCall ? (
                                    <div>
                                      <div className="font-mono text-[11px] text-slate-700 truncate max-w-[120px]" title={latestCall.callSid}>
                                        {latestCall.callSid}
                                      </div>
                                      <div className="text-[10px] text-slate-600">
                                        {latestCall.durationSeconds ? `${latestCall.durationSeconds}s duration` : new Date(latestCall.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                      </div>
                                    </div>
                                  ) : (
                                    <span className="text-[11px] text-slate-500">Ready to initiate</span>
                                  )}
                                </td>
                                <td className="py-3 text-right">
                                  {isLocked ? (
                                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 text-slate-600 text-[11px] font-medium border border-slate-300" title="Outbound call is currently active or locked">
                                      <Clock className="w-3 h-3 animate-spin text-blue-600" />
                                      <span>In-Flight Lock</span>
                                    </span>
                                  ) : (
                                    <button
                                      onClick={() => handleOpenOutboundModal(appt)}
                                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                                        latestCall
                                          ? 'bg-slate-100 hover:bg-slate-200 text-indigo-700 border border-indigo-300 hover:border-indigo-400'
                                          : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-600/20'
                                      }`}
                                    >
                                      <PhoneCall className="w-3 h-3" />
                                      <span>{latestCall ? 'Redial / Retry' : 'Dispatch Reminder'}</span>
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Outbound Telephony Logs */}
                {outboundCalls.length > 0 && (
                  <div className="rounded-2xl p-5 bg-white border border-slate-200 space-y-3 shadow-sm">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-slate-800 uppercase tracking-wider flex items-center gap-2">
                        <Terminal className="w-3.5 h-3.5 text-teal-600" />
                        <span>Outbound Call Telephony Ledger</span>
                      </h4>
                      <span className="text-[11px] text-slate-600 font-mono">
                        {outboundCalls.length} Total Outbound Dispatches
                      </span>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-600">
                            <th className="pb-2 font-medium">Call SID</th>
                            <th className="pb-2 font-medium">Destination</th>
                            <th className="pb-2 font-medium">Status</th>
                            <th className="pb-2 font-medium">Duration</th>
                            <th className="pb-2 font-medium">Engine Mode</th>
                            <th className="pb-2 font-medium text-right">Timestamp</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                          {outboundCalls.slice(0, 10).map(call => (
                            <tr key={call._id || call.callSid} className="hover:bg-slate-100">
                              <td className="py-2 font-mono text-indigo-700">{call.callSid}</td>
                              <td className="py-2 text-slate-700 font-mono">{call.to}</td>
                              <td className="py-2">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-medium capitalize ${
                                  call.status === 'completed' ? 'bg-emerald-50 text-emerald-600' :
                                  ['queued', 'ringing', 'in-progress'].includes(call.status) ? 'bg-blue-50 text-blue-600' :
                                  'bg-rose-50 text-rose-600'
                                }`}>
                                  {call.status}
                                </span>
                              </td>
                              <td className="py-2 text-slate-600 font-mono">
                                {call.durationSeconds ? `${call.durationSeconds}s` : '0s'}
                              </td>
                              <td className="py-2">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${
                                  call.isMock ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'
                                }`}>
                                  {call.isMock ? 'Mock' : 'Live'}
                                </span>
                              </td>
                              <td className="py-2 text-slate-600 font-mono text-right">
                                {new Date(call.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* TAB 6: REVIEW REQUIRED */}
          {currentTab === 'review-required' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold text-slate-900 tracking-tight">Review Required</h2>
                <p className="text-xs text-slate-600">
                  Care-plan options waiting for approval, documents to verify, escalations, and calls that did not reach the patient.
                </p>
              </div>

              <ReviewQueuePanel onOpenPlan={openPlanFromQueue} onChanged={refreshReviewCount} onCount={setReviewCount} />

              <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-4 shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                  <h3 className="text-xs font-semibold text-slate-700">Calls Not Reached ({callsNeedingAttention.length})</h3>
                  <span className="text-[11px] text-slate-500">From the {voiceCalls.length} most recent calls</span>
                </div>

                {callsNeedingAttention.length === 0 ? (
                  <p className="text-center py-8 text-xs text-slate-600">
                    No unreached calls among recent calls.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {callsNeedingAttention.map(call => (
                      <div key={call._id} className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-amber-50 text-amber-700 border border-amber-200">
                              {call.status}
                            </span>
                            <span className="text-slate-700 capitalize">{call.direction}</span>
                            {call.callIntent === 'missed_call_callback' && (
                              <span className="text-[10px] font-mono text-teal-700">Callback</span>
                            )}
                            {call.callIntent === 'planpilot_care' && (
                              <span className="text-[10px] font-mono text-sky-700">PlanPilot</span>
                            )}
                            {call.isMock && (
                              <span className="text-[10px] font-mono text-amber-700">Simulated</span>
                            )}
                          </div>
                          <div className="text-slate-600 font-mono">
                            {call.direction === 'outbound' ? `To: ${call.to}` : `From: ${call.from}`}
                            {call.bookingReference && <span className="text-teal-600"> &bull; Ref: {call.bookingReference}</span>}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {new Date(call.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                          </div>
                        </div>
                        {call.direction === 'outbound' && call.callIntent === 'missed_call_callback' && ['failed', 'no-answer', 'busy'].includes(call.status) && (
                          <button
                            onClick={() => handleRetryCallback(call.callSid)}
                            disabled={retryingCallSid === call.callSid}
                            className="px-3 py-1.5 rounded-lg bg-teal-50 hover:bg-teal-100 text-teal-700 border border-teal-300 font-semibold transition-all cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5 self-start sm:self-auto"
                          >
                            <RotateCcw className={`w-3.5 h-3.5 ${retryingCallSid === call.callSid ? 'animate-spin' : ''}`} />
                            <span>{retryingCallSid === call.callSid ? 'Retrying...' : 'Retry Callback'}</span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Phone health checks (symptom check) */}
          {currentTab === 'health-calls' && <HealthCallsPanel onChanged={refreshReviewCount} />}

          {/* PlanPilot Demo Lab (development only) */}
          {currentTab === 'demo-lab' && (
            <DemoLabPanel onChanged={() => { setFocusPlanId(null); refreshReviewCount(); }} />
          )}

          {/* TAB 7: SYSTEM HEALTH */}
          {currentTab === 'system-status' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-900">System Health</h3>
                  {lastRefreshed && <p className="text-[11px] text-slate-500">Last checked {lastRefreshed}</p>}
                </div>
                <button
                  onClick={refreshSystemHealth}
                  className="px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold"
                >
                  Check again
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                {[
                  {
                    name: 'Backend service',
                    ok: apiHealth.data?.status === 'ok',
                    detail: apiHealth.data ? `Running for ${Math.floor((apiHealth.data.uptimeSeconds || 0) / 60)} min${apiHealth.latencyMs ? ` · responds in ${apiHealth.latencyMs} ms` : ''}` : apiHealth.error
                  },
                  {
                    name: 'Database',
                    ok: dbHealth.data?.status === 'connected',
                    detail: dbHealth.data ? (dbHealth.data.status === 'connected' ? 'Connected and responsive' : dbHealth.data.message) : dbHealth.error
                  },
                  {
                    name: 'Phone calls',
                    ok: Boolean(voiceConfig?.telephony?.isConfigured && voiceConfig?.voiceAgent?.isConfigured),
                    detail: voiceConfig?.isMockMode ? 'Simulation mode (no real calls)' : voiceConfig?.telephony?.isConfigured ? `Live from ${voiceConfig.telephony.phoneNumber}` : 'Not configured'
                  }
                ].map(item => (
                  <div key={item.name} className="p-4 rounded-2xl bg-white border border-slate-200 shadow-sm space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-900">{item.name}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${item.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                        {item.ok ? 'Healthy' : 'Attention'}
                      </span>
                    </div>
                    <p className="text-slate-600">{item.detail || '—'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* MODAL 1: BOOK APPOINTMENT MODAL */}
      {showBookModal && (
        <div className="fixed inset-0 z-50 bg-slate-50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Book Appointment</h3>
              <button onClick={() => setShowBookModal(false)} className="text-slate-600 hover:text-slate-900 text-sm cursor-pointer">&times;</button>
            </div>

            <form onSubmit={handleCreateBooking} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Select Provider</label>
                <select
                  value={selectedProviderId}
                  onChange={(e) => {
                    setSelectedProviderId(e.target.value);
                    setSelectedSlot(null);
                  }}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-xl text-slate-900"
                >
                  {providers.map(p => (
                    <option key={p._id} value={p._id}>{p.name} ({p.specialty})</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Choose Available Slot</label>
                {providerSlots.length === 0 ? (
                  <p className="text-amber-600 text-[11px] p-2 bg-amber-50 rounded-lg">No slots available for this provider.</p>
                ) : (
                  <div className="max-h-36 overflow-y-auto space-y-1.5 p-1">
                    {providerSlots.slice(0, 15).map((slot, idx) => (
                      <button
                        type="button"
                        key={idx}
                        onClick={() => setSelectedSlot(slot)}
                        className={`w-full text-left p-2 rounded-lg text-[11px] font-mono transition-colors ${
                          selectedSlot === slot 
                            ? 'bg-teal-100 text-teal-700 border border-teal-400' 
                            : 'bg-white hover:bg-slate-100 text-slate-700'
                        }`}
                      >
                        {new Date(slot.startAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} ({slot.durationMinutes}m)
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Synthetic Patient Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Sunita Devi"
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-xl text-slate-900"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Patient Phone (E.164)</label>
                <input
                  type="tel"
                  placeholder="e.g. +15550100101 (synthetic) or +91…"
                  value={patientPhone}
                  onChange={(e) => setPatientPhone(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-xl text-slate-900"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Patient Email <span className="font-normal text-slate-500">(optional, links to their portal account)</span></label>
                <input
                  type="email"
                  placeholder="e.g. patient@careloop.local"
                  value={patientEmail}
                  onChange={(e) => setPatientEmail(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-xl text-slate-900"
                />
              </div>

              <button
                type="submit"
                disabled={bookingLoading || !selectedSlot}
                className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-bold transition-all cursor-pointer"
              >
                {bookingLoading ? 'Reserving...' : 'Confirm Booking'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: RESCHEDULE MODAL */}
      {showRescheduleModal && reschedulingAppt && (
        <div className="fixed inset-0 z-50 bg-slate-50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Reschedule {reschedulingAppt.bookingReference}</h3>
              <button onClick={() => setShowRescheduleModal(false)} className="text-slate-600 hover:text-slate-900 text-sm cursor-pointer">&times;</button>
            </div>

            <form onSubmit={handleRescheduleSubmit} className="space-y-4 text-xs">
              <p className="text-slate-700">
                Patient: <strong>{reschedulingAppt.patient?.name}</strong>
              </p>

              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Select Alternative Slot</label>
                <div className="max-h-48 overflow-y-auto space-y-1.5 p-1">
                  {providerSlots.slice(0, 15).map((slot, idx) => (
                    <button
                      type="button"
                      key={idx}
                      onClick={() => setRescheduleSlot(slot)}
                      className={`w-full text-left p-2 rounded-lg text-[11px] font-mono transition-colors ${
                        rescheduleSlot === slot 
                          ? 'bg-teal-100 text-teal-700 border border-teal-400' 
                          : 'bg-white hover:bg-slate-100 text-slate-700'
                      }`}
                    >
                      {new Date(slot.startAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={rescheduleLoading || !rescheduleSlot}
                className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-bold transition-all cursor-pointer"
              >
                {rescheduleLoading ? 'Updating...' : 'Confirm Reschedule'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: ADD PROVIDER MODAL */}
      {showAddProviderModal && (
        <div className="fixed inset-0 z-50 bg-slate-50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Register New Provider</h3>
              <button onClick={() => setShowAddProviderModal(false)} className="text-slate-600 hover:text-slate-900 text-sm cursor-pointer">&times;</button>
            </div>

            <form onSubmit={handleCreateProvider} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Doctor Full Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Dr. Jane Smith"
                  value={newProviderName}
                  onChange={(e) => setNewProviderName(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-xl text-slate-900"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-700 font-semibold">Specialty</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Pediatrics, Cardiology"
                  value={newProviderSpecialty}
                  onChange={(e) => setNewProviderSpecialty(e.target.value)}
                  className="w-full p-2.5 bg-white border border-slate-200 rounded-xl text-slate-900"
                />
              </div>

              <button
                type="submit"
                disabled={providerSubmitting}
                className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-bold transition-all cursor-pointer"
              >
                {providerSubmitting ? 'Saving...' : 'Register'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 4: OUTBOUND REMINDER CALL MODAL (M5) */}
      {showOutboundModal && outboundAppt && (
        <div className="fixed inset-0 z-50 bg-slate-50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-teal-50 text-teal-600 flex items-center justify-center">
                  <PhoneCall className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">Place Voice Reminder Call</h3>
                  <p className="text-[11px] text-slate-600">AI reminder call</p>
                </div>
              </div>
              <button 
                onClick={() => setShowOutboundModal(false)} 
                className="text-slate-600 hover:text-slate-900 text-sm cursor-pointer"
                disabled={outboundSubmitting}
              >
                &times;
              </button>
            </div>

            {outboundError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{outboundError}</span>
              </div>
            )}

            {outboundResult ? (
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2 text-xs">
                <div className="flex items-center gap-2 text-emerald-600 font-semibold">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Outbound Call Queued Successfully</span>
                </div>
                <div className="space-y-1 font-mono text-[11px] text-slate-700">
                  <div>Call SID: <strong className="text-teal-600">{outboundResult.callSid}</strong></div>
                  <div>Status: <span className="uppercase text-emerald-600">{outboundResult.status}</span></div>
                  <div>Recipient: <span>{outboundResult.to}</span></div>
                  <div>Booking Ref: <span className="text-teal-600">{outboundResult.bookingReference}</span></div>
                  <div>Mode: <span>{outboundResult.isMock ? 'Simulation (MOCK)' : 'Live Telephony'}</span></div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowOutboundModal(false)}
                  className="w-full mt-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold cursor-pointer transition-colors"
                >
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={handleInitiateOutboundCall} className="space-y-4 text-xs">
                {/* Appointment Overview */}
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <div className="flex items-center justify-between text-slate-700">
                    <span className="text-slate-600">Appointment:</span>
                    <span className="font-mono font-bold text-teal-600">{outboundAppt.bookingReference}</span>
                  </div>
                  <div className="flex items-center justify-between text-slate-700">
                    <span className="text-slate-600">Patient:</span>
                    <span className="font-semibold text-slate-900">{outboundAppt.patient?.name}</span>
                  </div>
                  <div className="flex items-center justify-between text-slate-700">
                    <span className="text-slate-600">Physician:</span>
                    <span className="text-slate-800">
                      {providers.find(p => String(p._id) === String(outboundAppt.providerId))?.name || 'Assigned Clinician'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-700">
                    <span className="text-slate-600">Scheduled Time:</span>
                    <span className="font-mono text-slate-800">
                      {new Date(outboundAppt.startAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </div>
                </div>

                {/* Recipient Phone */}
                <div className="space-y-1">
                  <label className="text-slate-700 font-semibold flex items-center justify-between">
                    <span>Destination Phone Number (E.164)</span>
                    <span className="text-[10px] text-slate-500 font-normal">e.g. +919876543210</span>
                  </label>
                  <input
                    type="tel"
                    required
                    placeholder="+919876543210 or +15551234567"
                    value={outboundPhone}
                    onChange={(e) => setOutboundPhone(e.target.value)}
                    disabled={outboundSubmitting}
                    className="w-full p-2.5 bg-white border border-slate-200 rounded-xl text-slate-900 font-mono placeholder:text-slate-400 focus:outline-none focus:border-teal-500"
                  />
                  <p className="text-[10px] text-slate-500">
                    Validated against standard international E.164 formatting before dialing.
                  </p>
                </div>

                {/* Explicit Staff Confirmation Checkbox */}
                <div className="p-3 rounded-xl bg-teal-50 border border-teal-200 space-y-2">
                  <label className="flex items-start gap-2.5 cursor-pointer text-slate-800">
                    <input
                      type="checkbox"
                      checked={outboundConfirmed}
                      onChange={(e) => setOutboundConfirmed(e.target.checked)}
                      disabled={outboundSubmitting}
                      className="mt-0.5 rounded border-slate-300 bg-white text-teal-600 focus:ring-teal-500 cursor-pointer"
                    />
                    <span className="text-[11px] leading-tight">
                      <strong>Explicit Staff Confirmation:</strong> I confirm dispatching an automated CareLoop AI voice reminder call to this patient.
                    </span>
                  </label>
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={outboundSubmitting || !outboundConfirmed || !outboundPhone.trim()}
                  className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-teal-500/20"
                >
                  {outboundSubmitting ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Placing Outbound Call...</span>
                    </>
                  ) : (
                    <>
                      <PhoneCall className="w-4 h-4" />
                      <span>Place Reminder Call</span>
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
