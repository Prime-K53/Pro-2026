import React, { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { requestJsonRaw, SESSION_EXPIRED_EVENT } from '../services/http';

export type ServerCompanyRole =
  | 'Administrator'
  | 'Bookkeeper'
  | 'Accountant'
  | 'ProductionManager'
  | 'Read-Only';

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  displayName: string;
  mustChangePassword: boolean;
}

export interface AuthorizedCompany {
  id: number;
  slug: string;
  name: string;
  legalName?: string;
  currencySymbol?: string;
  baseCurrency?: string;
  role: ServerCompanyRole;
  isDefault?: boolean;
}

export interface ActiveCompanyContext {
  id: number;
  slug: string;
  name: string;
  role: ServerCompanyRole;
}

interface AuthContextValue {
  loading: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  activeCompany: ActiveCompanyContext | null;
  permissions: string[];
  companies: AuthorizedCompany[];
  authError: string | null;
  clearAuthError: () => void;
  hasPermission: (perm: string) => boolean;
  refreshStatus: () => Promise<void>;
  login: (identifier: string, password: string, companyId?: number) => Promise<boolean>;
  register: (payload: {
    username: string;
    email: string;
    displayName: string;
    password: string;
    companyName: string;
  }) => Promise<boolean>;
  acceptInvitation: (token: string, password: string) => Promise<{ ok: boolean; message?: string }>;
  requestPasswordRecovery: (
    email: string
  ) => Promise<{ ok: boolean; message: string; devRecoveryToken?: string }>;
  resetPassword: (token: string, newPassword: string) => Promise<{ ok: boolean; message: string }>;
  switchCompany: (companyId: number) => Promise<boolean>;
  createCompany: (payload: {
    name: string;
    legalName?: string;
    ein?: string;
    currencySymbol?: string;
    baseCurrency?: string;
  }) => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

async function apiJson<T>(url: string, options: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
  return requestJsonRaw<T>(url, options);
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [activeCompany, setActiveCompany] = useState<ActiveCompanyContext | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [companies, setCompanies] = useState<AuthorizedCompany[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);

  const applySessionPayload = useCallback((data: any) => {
    if (data?.authenticated) {
      setAuthenticated(true);
      setUser(data.user || null);
      setActiveCompany(data.activeCompany || null);
      setPermissions(Array.isArray(data.permissions) ? data.permissions : []);
      setCompanies(Array.isArray(data.companies) ? data.companies : []);
      setAuthError(null);
    } else {
      setAuthenticated(false);
      setUser(null);
      setActiveCompany(null);
      setPermissions([]);
      setCompanies([]);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const { ok, data } = await apiJson<any>('/api/auth/status', { method: 'GET' });
      if (ok && data?.authenticated) {
        applySessionPayload(data);
      } else {
        applySessionPayload({ authenticated: false });
      }
    } catch {
      applySessionPayload({ authenticated: false });
    } finally {
      setLoading(false);
    }
  }, [applySessionPayload]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Any API client that receives a 401 emits SESSION_EXPIRED_EVENT.
  // Re-verify the session so the app drops to the sign-in screen with a
  // clear message instead of showing a generic "Request failed".
  useEffect(() => {
    const onSessionExpired = () => {
      refreshStatus();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  }, [refreshStatus]);

  const login = async (identifier: string, password: string, companyId?: number) => {
    setAuthError(null);
    const { ok, data } = await apiJson<any>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password, ...(companyId ? { companyId } : {}) }),
    });
    if (!ok) {
      setAuthError(data?.error || 'Sign-in failed');
      return false;
    }
    applySessionPayload(data);
    return true;
  };

  const register = async (payload: {
    username: string;
    email: string;
    displayName: string;
    password: string;
    companyName: string;
  }) => {
    setAuthError(null);
    const { ok, data } = await apiJson<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!ok) {
      setAuthError(data?.error || 'Registration failed');
      return false;
    }
    applySessionPayload(data);
    return true;
  };

  const acceptInvitation = async (token: string, password: string) => {
    setAuthError(null);
    const { ok, data } = await apiJson<any>('/api/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
    if (!ok) {
      setAuthError(data?.error || 'Invitation acceptance failed');
      return { ok: false, message: data?.error || 'Invitation acceptance failed' };
    }
    return { ok: true, message: data?.message || 'Invitation accepted. You may now sign in.' };
  };

  const requestPasswordRecovery = async (email: string) => {
    setAuthError(null);
    const { ok, data } = await apiJson<any>('/api/auth/password-recovery', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (!ok) {
      setAuthError(data?.error || 'Unable to process recovery request');
      return { ok: false, message: data?.error || 'Unable to process recovery request' };
    }
    return {
      ok: true,
      message: data?.message || 'Recovery instructions issued.',
      devRecoveryToken: data?.devRecoveryToken,
    };
  };

  const resetPassword = async (token: string, newPassword: string) => {
    setAuthError(null);
    const { ok, data } = await apiJson<any>('/api/auth/password-reset', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    });
    if (!ok) {
      setAuthError(data?.error || 'Password reset failed');
      return { ok: false, message: data?.error || 'Password reset failed' };
    }
    return { ok: true, message: data?.message || 'Password updated.' };
  };

  const switchCompany = async (companyId: number) => {
    setAuthError(null);
    const { ok, status, data } = await apiJson<any>('/api/auth/switch-company', {
      method: 'POST',
      body: JSON.stringify({ companyId }),
    });
    if (!ok) {
      if (status === 401 || status === 403) {
        await refreshStatus();
      }
      setAuthError(data?.error || 'Company switch failed');
      return false;
    }
    setActiveCompany(data.activeCompany);
    setPermissions(data.permissions || []);
    setCompanies(data.companies || []);
    return true;
  };

  const createCompany = async (payload: {
    name: string;
    legalName?: string;
    ein?: string;
    currencySymbol?: string;
    baseCurrency?: string;
  }) => {
    setAuthError(null);
    const { ok, data } = await apiJson<any>('/api/companies', {
      method: 'POST',
      body: JSON.stringify({ ...payload, switchImmediately: true }),
    });
    if (!ok) {
      setAuthError(data?.error || 'Failed to create company');
      return false;
    }
    await refreshStatus();
    return true;
  };

  const logout = async () => {
    await apiJson('/api/auth/logout', { method: 'POST' });
    applySessionPayload({ authenticated: false });
  };

  const hasPermission = useCallback(
    (perm: string) => permissions.includes(perm),
    [permissions]
  );

  return (
    <AuthContext.Provider
      value={{
        loading,
        authenticated,
        user,
        activeCompany,
        permissions,
        companies,
        authError,
        clearAuthError: () => setAuthError(null),
        hasPermission,
        refreshStatus,
        login,
        register,
        acceptInvitation,
        requestPasswordRecovery,
        resetPassword,
        switchCompany,
        createCompany,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
