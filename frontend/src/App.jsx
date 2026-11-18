import React from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginView from './components/LoginView';
import ClinicianWorkspace from './components/ClinicianWorkspace';
import { Activity, Loader2 } from 'lucide-react';

function MainApp() {
  // Clinician portal only: patients interact with PlanPilot by phone (see the voice agent), not the web
  const { user, loading, waitingForServer } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col items-center justify-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-teal-50 text-teal-600 flex items-center justify-center border border-teal-200 shadow-lg shadow-teal-500/10">
          <Activity className="w-6 h-6 stroke-[2.5] text-teal-600 animate-pulse" />
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600 font-medium">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-600" />
          <span>{waitingForServer || 'Verifying clinician session...'}</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginView />;
  }

  return <ClinicianWorkspace />;
}

export default function App() {
  return (
    <AuthProvider>
      <MainApp />
    </AuthProvider>
  );
}
