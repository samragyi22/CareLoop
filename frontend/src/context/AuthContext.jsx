import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Set while the server is starting or its database is still connecting
  const [waitingForServer, setWaitingForServer] = useState(null);
  const retryTimer = useRef(null);

  // Check current session on mount. If the server is still starting, keep waiting and retry, instead
  // of showing the login page (a login could not succeed yet anyway)
  const checkSession = useCallback(async () => {
    let retrying = false;
    try {
      setLoading(true);
      setError(null);
      const res = await api.getCurrentUser();
      setWaitingForServer(null);
      if (res && res.user) {
        setUser(res.user);
      } else {
        setUser(null);
      }
    } catch (err) {
      if (err.code === 'DB_CONNECTING' || err.code === 'BACKEND_UNREACHABLE') {
        retrying = true;
        setWaitingForServer(err.code === 'DB_CONNECTING'
          ? 'The server is up and its database is still connecting...'
          : 'Waiting for the CareLoop server to start...');
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(checkSession, 3000);
      } else {
        // 401 is normal for unauthenticated guests
        setWaitingForServer(null);
        setUser(null);
      }
    } finally {
      if (!retrying) setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
    return () => clearTimeout(retryTimer.current);
  }, [checkSession]);

  const login = async (email, password) => {
    setError(null);
    try {
      const res = await api.login(email, password);
      if (res && res.user) {
        setUser(res.user);
        return res.user;
      }
      throw new Error('Invalid authentication response from server.');
    } catch (err) {
      setError(err.message || 'Login failed.');
      throw err;
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch (err) {
      console.warn('Logout API error:', err.message);
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, error, waitingForServer, login, logout, checkSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
