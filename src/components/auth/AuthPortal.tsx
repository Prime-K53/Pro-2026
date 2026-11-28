import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { DEMO_MODE } from '../../config/featureFlags';
import { Building2, KeyRound, Lock, Mail, ShieldCheck, UserPlus, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';

type AuthTab = 'signin' | 'register' | 'invite' | 'recovery';

const TABS: { id: AuthTab; label: string }[] = [
  { id: 'signin', label: 'Sign In' },
  { id: 'register', label: 'Register Company' },
  { id: 'invite', label: 'Accept Invite' },
  { id: 'recovery', label: 'Reset Password' },
];

const TRUST_POINTS = [
  {
    icon: Building2,
    title: 'Strict Tenant Isolation',
    body: 'Active company membership is verified on every API call and enforced at the database layer.',
  },
  {
    icon: ShieldCheck,
    title: 'Five-Role RBAC Matrix',
    body: 'Administrator, Bookkeeper, Accountant, Production Manager, and Read-Only roles with field-level redaction.',
  },
  {
    icon: Lock,
    title: 'Revocable Sessions & Audit Trail',
    body: 'Membership revocations, role changes, and password resets take effect immediately across active sessions.',
  },
];

const labelClass = 'app-label';
const inputClass = 'app-input';

export const AuthPortal: React.FC = () => {
  const {
    login,
    register,
    acceptInvitation,
    requestPasswordRecovery,
    resetPassword,
    authError,
    twoFactorRequired,
    clearAuthError,
  } = useAuth();

  const [tab, setTab] = useState<AuthTab>('signin');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Sign-In state
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');

  // Register state
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regCompanyName, setRegCompanyName] = useState('');

  // Invite accept state
  const [inviteToken, setInviteToken] = useState('');
  const [invitePassword, setInvitePassword] = useState('');

  // Password recovery state
  const [recEmail, setRecEmail] = useState('');
  const [recToken, setRecToken] = useState('');
  const [recNewPassword, setRecNewPassword] = useState('');

  const switchTab = (next: AuthTab) => {
    setTab(next);
    setNotice(null);
    clearAuthError();
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    await login(identifier, password, undefined, twoFactorCode.trim() || undefined);
    setSubmitting(false);
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    await register({
      username: regUsername,
      email: regEmail,
      displayName: regDisplayName || regUsername,
      password: regPassword,
      companyName: regCompanyName,
    });
    setSubmitting(false);
  };

  const handleAcceptInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    const res = await acceptInvitation(inviteToken, invitePassword);
    setSubmitting(false);
    if (res.ok) {
      setNotice(res.message || 'Invitation accepted. Sign in with your new credentials.');
      setInviteToken('');
      setInvitePassword('');
      setTab('signin');
    }
  };

  const handleRequestRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    const res = await requestPasswordRecovery(recEmail);
    setSubmitting(false);
    if (res.ok) {
      if (res.devRecoveryToken) {
        setRecToken(res.devRecoveryToken);
        setNotice(`${res.message} Recovery token generated for preview use.`);
      } else {
        setNotice(res.message);
      }
    }
  };

  const handleCompleteReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    const res = await resetPassword(recToken, recNewPassword);
    setSubmitting(false);
    if (res.ok) {
      setNotice(res.message);
      setRecToken('');
      setRecNewPassword('');
      setTab('signin');
    }
  };

  const fillDemoUser = (userIdentifier: string) => {
    setIdentifier(userIdentifier);
    setPassword('PrintingAdmin#2026');
    clearAuthError();
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f8fafc] p-4 text-slate-900 md:p-8 dark:bg-[#070b14] dark:text-slate-100">
      {/* Ambient brand glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-[34rem] w-[68rem] -translate-x-1/2 rounded-full bg-brand-500/15 blur-3xl"
      />

      <div className="relative grid w-full max-w-5xl grid-cols-1 overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-pop lg:grid-cols-12 dark:border-white/10 dark:bg-slate-900">
        {/* Left Institutional Context Panel */}
        <div className="relative isolate overflow-hidden bg-gradient-to-br from-brand-700 via-brand-800 to-brand-950 p-8 text-slate-100 lg:col-span-5 lg:flex lg:flex-col lg:justify-between">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.18]">
            <div className="absolute -top-24 -right-16 h-72 w-72 rounded-full bg-brand-400 blur-3xl" />
            <div className="absolute -bottom-24 -left-10 h-64 w-64 rounded-full bg-emerald-400/60 blur-3xl" />
          </div>

          <div className="relative space-y-7">
            <div className="flex items-center gap-3">
              <span className="brand-mark">PM</span>
              <span className="text-base font-bold tracking-tight text-white">
                Printing Management System
              </span>
            </div>

            <div className="space-y-3">
              <h1
                className="text-2xl font-bold leading-snug tracking-tight text-white"
                style={{ textWrap: 'balance' }}
              >
                Multi-Company Bookkeeping &amp; Print Production Control
              </h1>
              <p className="text-sm leading-relaxed text-brand-100">
                Sign in with your company credentials. Server-side PostgreSQL Row-Level Security keeps
                each printing house and accounting ledger strictly isolated.
              </p>
            </div>

            <div className="space-y-4 border-t border-white/15 pt-6">
              {TRUST_POINTS.map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15 ring-inset">
                    <Icon className="h-4 w-4 text-brand-100" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-white">{title}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-brand-200">{body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative mt-8 border-t border-white/15 pt-5 text-[11px] text-brand-200">
            Printing Management System · Double-Entry Accounting &amp; Exam Production
          </div>
        </div>

        {/* Right Interactive Authentication Panel */}
        <div className="flex flex-col justify-between p-6 md:p-8 lg:col-span-7">
          <div>
            {/* Segmented Mode Tabs */}
            <div
              role="tablist"
              aria-label="Authentication mode"
              className="mb-6 flex flex-wrap items-center gap-1 rounded-2xl bg-slate-100 p-1 dark:bg-white/[0.05]"
            >
              {TABS.map(t => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => switchTab(t.id)}
                  className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all ${
                    tab === t.id
                      ? 'bg-white text-slate-900 shadow-xs dark:bg-white/10 dark:text-white'
                      : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {authError && (
              <div
                role="alert"
                className="mb-5 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{authError}</span>
              </div>
            )}

            {notice && (
              <div
                role="status"
                className="mb-5 flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300"
              >
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            {tab === 'signin' && (
              <form onSubmit={handleSignIn} className="space-y-5">
                <div className="space-y-1.5">
                  <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                    Sign in to your workspace
                  </h2>
                  <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    Your server session determines your active company and role permissions.
                  </p>
                </div>

                <div>
                  <label className={labelClass} htmlFor="auth-identifier">
                    Username or Email
                  </label>
                  <input
                    id="auth-identifier"
                    type="text"
                    required
                    value={identifier}
                    onChange={e => setIdentifier(e.target.value)}
                    placeholder="admin@primepress.zm"
                    className={inputClass}
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor="auth-password">
                    Password
                  </label>
                  <input
                    id="auth-password"
                    type="password"
                    required
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className={inputClass}
                  />
                </div>

                {twoFactorRequired && (
                  <div>
                    <label className={labelClass} htmlFor="auth-2fa-code">
                      Two-Factor Authentication Code
                    </label>
                    <input
                      id="auth-2fa-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      required
                      value={twoFactorCode}
                      onChange={e => setTwoFactorCode(e.target.value)}
                      placeholder="Enter the 6-digit code from your authenticator"
                      className={inputClass}
                    />
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      You can also use one of your saved backup codes.
                    </p>
                  </div>
                )}

                <button type="submit" disabled={submitting} className="btn btn-primary w-full py-2.5">
                  {submitting ? 'Signing in...' : 'Sign In'}
                  {!submitting && <ArrowRight className="h-4 w-4" />}
                </button>

                {/* Demo credential quick-fill strip for evaluating each RBAC role.
                    Only rendered when the build is explicitly in demo mode
                    (see src/config/featureFlags.ts). */}
                {DEMO_MODE && (
                  <div className="border-t border-slate-200/80 pt-5 dark:border-white/[0.06]">
                    <div className="mb-2.5 text-[10px] font-bold tracking-[0.09em] text-slate-500 uppercase dark:text-slate-400">
                      Evaluate Role-Based Access (fills login fields)
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { label: 'Administrator', user: 'admin' },
                        { label: 'Bookkeeper', user: 'bookkeeper' },
                        { label: 'Accountant', user: 'accountant' },
                        { label: 'Production Manager', user: 'production' },
                      ].map(d => (
                        <button
                          key={d.user}
                          type="button"
                          onClick={() => fillDemoUser(d.user)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium whitespace-nowrap text-slate-600 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300 dark:hover:border-brand-500/40 dark:hover:bg-white/[0.08] dark:hover:text-white"
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </form>
            )}

            {tab === 'register' && (
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="space-y-1.5">
                  <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                    Create User &amp; Isolated Company
                  </h2>
                  <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    Initializes a separate company ledger with default Chart of Accounts and assigns you as
                    Administrator.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                  <div>
                    <label className={labelClass} htmlFor="reg-company">
                      Company Name
                    </label>
                    <input
                      id="reg-company"
                      type="text"
                      required
                      value={regCompanyName}
                      onChange={e => setRegCompanyName(e.target.value)}
                      placeholder="Ndola Litho Printers"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="reg-name">
                      Full Name
                    </label>
                    <input
                      id="reg-name"
                      type="text"
                      required
                      value={regDisplayName}
                      onChange={e => setRegDisplayName(e.target.value)}
                      placeholder="Mwila Chisanga"
                      className={inputClass}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                  <div>
                    <label className={labelClass} htmlFor="reg-username">
                      Username
                    </label>
                    <input
                      id="reg-username"
                      type="text"
                      required
                      minLength={3}
                      value={regUsername}
                      onChange={e => setRegUsername(e.target.value)}
                      placeholder="mwila"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="reg-email">
                      Work Email
                    </label>
                    <input
                      id="reg-email"
                      type="email"
                      required
                      value={regEmail}
                      onChange={e => setRegEmail(e.target.value)}
                      placeholder="mwila@ndolalitho.zm"
                      className={inputClass}
                    />
                  </div>
                </div>

                <div>
                  <label className={labelClass} htmlFor="reg-password">
                    Password (minimum 8 characters)
                  </label>
                  <input
                    id="reg-password"
                    type="password"
                    required
                    minLength={8}
                    value={regPassword}
                    onChange={e => setRegPassword(e.target.value)}
                    className={inputClass}
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="btn btn-primary w-full py-2.5"
                >
                  <UserPlus className="h-4 w-4" />
                  <span>{submitting ? 'Provisioning Company...' : 'Create Account & Company'}</span>
                </button>
              </form>
            )}

            {tab === 'invite' && (
              <form onSubmit={handleAcceptInvite} className="space-y-5">
                <div className="space-y-1.5">
                  <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                    Accept Company Invitation
                  </h2>
                  <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    Redeem a one-time invitation token provided by your Administrator and choose your own
                    password.
                  </p>
                </div>
                <div>
                  <label className={labelClass} htmlFor="invite-token">
                    Invitation Token
                  </label>
                  <input
                    id="invite-token"
                    type="text"
                    required
                    value={inviteToken}
                    onChange={e => setInviteToken(e.target.value)}
                    placeholder="Paste one-time invitation token"
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="invite-password">
                    Set New Password (min 8 characters)
                  </label>
                  <input
                    id="invite-password"
                    type="password"
                    required
                    minLength={8}
                    value={invitePassword}
                    onChange={e => setInvitePassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <button type="submit" disabled={submitting} className="btn btn-primary w-full py-2.5">
                  <KeyRound className="h-4 w-4" />
                  <span>{submitting ? 'Activating Membership...' : 'Accept Invitation & Activate'}</span>
                </button>
              </form>
            )}

            {tab === 'recovery' && (
              <div className="space-y-6">
                <form onSubmit={handleRequestRecovery} className="space-y-3.5">
                  <div className="space-y-1.5">
                    <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                      Password Recovery
                    </h2>
                    <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                      Resetting your password immediately invalidates all prior active sessions.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="email"
                      required
                      value={recEmail}
                      onChange={e => setRecEmail(e.target.value)}
                      placeholder="Account email address"
                      className={`${inputClass} flex-1`}
                    />
                    <button
                      type="submit"
                      disabled={submitting}
                      className="btn btn-secondary shrink-0 whitespace-nowrap"
                    >
                      <Mail className="h-3.5 w-3.5" />
                      <span>Issue Recovery</span>
                    </button>
                  </div>
                </form>

                <form
                  onSubmit={handleCompleteReset}
                  className="space-y-3.5 border-t border-slate-200/80 pt-5 dark:border-white/[0.06]"
                >
                  <div>
                    <label className={labelClass} htmlFor="rec-token">
                      Recovery Token
                    </label>
                    <input
                      id="rec-token"
                      type="text"
                      required
                      value={recToken}
                      onChange={e => setRecToken(e.target.value)}
                      placeholder="Paste recovery token"
                      className={`${inputClass} font-mono`}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="rec-password">
                      New Password (min 8 characters)
                    </label>
                    <input
                      id="rec-password"
                      type="password"
                      required
                      minLength={8}
                      value={recNewPassword}
                      onChange={e => setRecNewPassword(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <button type="submit" disabled={submitting} className="btn btn-primary w-full py-2.5">
                    {submitting ? 'Updating Password...' : 'Reset Password & Revoke Old Sessions'}
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};