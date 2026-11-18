import React, { useCallback, useEffect, useState } from 'react';
import { ServerCompanyRole, useAuth } from '../../context/AuthContext';
import {
  Building2,
  CheckCircle2,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  UserMinus,
  UserPlus,
  AlertTriangle,
} from 'lucide-react';

interface MemberRow {
  membershipId: number;
  userId: number;
  username: string;
  email: string;
  displayName: string;
  userActive: boolean;
  role: ServerCompanyRole;
  membershipActive: boolean;
  expiresOn: string | null;
  revokedAt: string | null;
  membershipVersion: number;
  lastLoginAt: string | null;
}

interface InvitationRow {
  id: number;
  email: string;
  username: string;
  displayName: string;
  role: ServerCompanyRole;
  status: string;
  expiresOn: string | null;
  inviteExpiresAt: string;
}

interface MatrixRow {
  permission: string;
  roles: Record<ServerCompanyRole, boolean>;
}

interface AuditLogEntry {
  id: number;
  occurredAt: string;
  actorUsername: string | null;
  action: string;
  tableName: string;
  recordId: number;
  sha256Hash: string;
}

type SectionTab = 'members' | 'companies' | 'matrix' | 'audit';

const ROLE_OPTIONS: ServerCompanyRole[] = [
  'Administrator',
  'Bookkeeper',
  'Accountant',
  'ProductionManager',
  'Read-Only',
];

export const AccessControlView: React.FC = () => {
  const {
    user,
    activeCompany,
    companies,
    hasPermission,
    switchCompany,
    createCompany,
    refreshStatus,
  } = useAuth();

  const [tab, setTab] = useState<SectionTab>('members');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [matrixRows, setMatrixRows] = useState<MatrixRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Invite form state
  const [invEmail, setInvEmail] = useState('');
  const [invUsername, setInvUsername] = useState('');
  const [invDisplayName, setInvDisplayName] = useState('');
  const [invRole, setInvRole] = useState<ServerCompanyRole>('Bookkeeper');
  const [invExpiresOn, setInvExpiresOn] = useState('');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  // Create company form state
  const [newCompName, setNewCompName] = useState('');
  const [newCompEin, setNewCompEin] = useState('');

  const canManageUsers = hasPermission('users:list');
  const canCreateCompany = hasPermission('companies:create');
  const canReadAudit = hasPermission('audit:read');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const mRes = await fetch('/api/permissions/matrix', { credentials: 'include' });
      if (mRes.ok) {
        const mJson = await mRes.json();
        setMatrixRows(mJson.matrix || []);
      }

      if (canManageUsers) {
        const uRes = await fetch('/api/users', { credentials: 'include' });
        if (uRes.ok) {
          const uJson = await uRes.json();
          setMembers(uJson.members || []);
          setInvitations(uJson.invitations || []);
        }
      } else {
        setMembers([]);
        setInvitations([]);
      }

      if (canReadAudit) {
        const aRes = await fetch('/api/audit/logs?limit=40', { credentials: 'include' });
        if (aRes.ok) {
          const aJson = await aRes.json();
          setAuditLogs(aJson.logs || []);
        }
      } else {
        setAuditLogs([]);
      }
    } finally {
      setLoading(false);
    }
  }, [canManageUsers, canReadAudit]);

  useEffect(() => {
    loadData();
  }, [loadData, activeCompany?.id]);

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    setIssuedToken(null);
    const res = await fetch('/api/invitations', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: invEmail,
        username: invUsername || invEmail.split('@')[0],
        displayName: invDisplayName || invUsername || invEmail.split('@')[0],
        role: invRole,
        expiresOn: invExpiresOn || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatusMsg({ type: 'err', text: data.error || 'Failed to create invitation' });
      return;
    }
    setIssuedToken(data.invitation?.oneTimeInviteToken || null);
    setStatusMsg({ type: 'ok', text: `Invitation generated for ${invEmail} (${invRole}).` });
    setInvEmail('');
    setInvUsername('');
    setInvDisplayName('');
    setInvExpiresOn('');
    await loadData();
  };

  const handleRoleChange = async (targetUserId: number, role: ServerCompanyRole) => {
    setStatusMsg(null);
    const res = await fetch(`/api/users/${targetUserId}/membership`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatusMsg({ type: 'err', text: data.error || 'Role update failed' });
      return;
    }
    setStatusMsg({ type: 'ok', text: `Updated membership role to ${role}. Active sessions rotated.` });
    await refreshStatus();
    await loadData();
  };

  const handleRevokeMembership = async (targetUserId: number, username: string) => {
    setStatusMsg(null);
    const res = await fetch(`/api/users/${targetUserId}/membership`, {
      method: 'DELETE',
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) {
      setStatusMsg({ type: 'err', text: data.error || 'Unable to revoke membership' });
      return;
    }
    setStatusMsg({ type: 'ok', text: `Revoked company membership for ${username}.` });
    await loadData();
  };

  const handleDeactivateUser = async (targetUserId: number, username: string) => {
    setStatusMsg(null);
    const res = await fetch(`/api/users/${targetUserId}/deactivate`, {
      method: 'POST',
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) {
      setStatusMsg({ type: 'err', text: data.error || 'Unable to deactivate user' });
      return;
    }
    setStatusMsg({ type: 'ok', text: `Deactivated global account for ${username} and invalidated sessions.` });
    await loadData();
  };

  const handleReactivateMembership = async (targetUserId: number, username: string) => {
    setStatusMsg(null);
    const res = await fetch(`/api/users/${targetUserId}/membership`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatusMsg({ type: 'err', text: data.error || 'Unable to reactivate membership' });
      return;
    }
    setStatusMsg({ type: 'ok', text: `Reactivated membership for ${username}.` });
    await loadData();
  };

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    const ok = await createCompany({
      name: newCompName,
      ein: newCompEin || 'TPIN-000000',
    });
    if (ok) {
      setNewCompName('');
      setNewCompEin('');
      setStatusMsg({ type: 'ok', text: 'Created isolated company book and switched active tenant context.' });
      await loadData();
    } else {
      setStatusMsg({ type: 'err', text: 'Could not create company.' });
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Users, Permissions &amp; Multi-Company Isolation
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-1">
            <span>Active Company: <strong className="text-slate-800 dark:text-slate-200">{activeCompany?.name}</strong></span>
            <span aria-hidden="true">·</span>
            <span>User: <strong className="text-slate-800 dark:text-slate-200">{user?.username}</strong></span>
            <span aria-hidden="true">·</span>
            <span>Server Role: <strong className="text-slate-800 dark:text-slate-200">{activeCompany?.role}</strong></span>
          </div>
        </div>

        {/* Section Tabs */}
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-md self-start">
          {[
            { id: 'members', label: 'Members & Invites' },
            { id: 'companies', label: 'Companies' },
            { id: 'matrix', label: 'Permission Matrix' },
            { id: 'audit', label: 'Security Audit Log' },
          ].map(item => (
            <button
              key={item.id}
              onClick={() => setTab(item.id as SectionTab)}
              className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 ${
                tab === item.id
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white border border-slate-200 dark:border-slate-700'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            onClick={loadData}
            title="Refresh server security state"
            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {statusMsg && (
        <div
          role="status"
          className={`p-3 rounded border text-xs flex items-center gap-2 ${
            statusMsg.type === 'ok'
              ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
              : 'border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300'
          }`}
        >
          {statusMsg.type === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          <span>{statusMsg.text}</span>
        </div>
      )}

      {/* TAB 1: MEMBERS & INVITATIONS */}
      {tab === 'members' && (
        <div className="space-y-6">
          {!canManageUsers ? (
            <div className="p-6 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-sm text-slate-600 dark:text-slate-300">
              <div className="font-semibold text-slate-900 dark:text-white mb-1">
                Administrator Permission Required
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Your server-verified role ({activeCompany?.role}) does not include <span className="font-mono">users:list</span> or <span className="font-mono">users:manage</span>. Switch to an Administrator account to manage memberships and invitations.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Company Members Table */}
              <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                      Authorized Company Members
                    </h2>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Scoped strictly to {activeCompany?.name}
                    </div>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    {members.length} members
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-left">
                      <tr>
                        <th className="px-4 py-2.5 font-semibold">User</th>
                        <th className="px-4 py-2.5 font-semibold">Role</th>
                        <th className="px-4 py-2.5 font-semibold">Status</th>
                        <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {members.map(m => {
                        const isSelf = m.userId === user?.id;
                        return (
                          <tr key={m.membershipId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="px-4 py-2.5">
                              <div className="font-semibold text-slate-900 dark:text-white">
                                {m.displayName} {isSelf && <span className="text-slate-400 font-normal">(you)</span>}
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono">
                                {m.username} · {m.email}
                              </div>
                            </td>
                            <td className="px-4 py-2.5">
                              <select
                                value={m.role}
                                onChange={e => handleRoleChange(m.userId, e.target.value as ServerCompanyRole)}
                                aria-label={`Role for ${m.username}`}
                                className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                              >
                                {ROLE_OPTIONS.map(r => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-4 py-2.5">
                              <span
                                className={`text-xs font-semibold ${
                                  !m.userActive
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : m.membershipActive && !m.revokedAt
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-amber-600 dark:text-amber-400'
                                }`}
                              >
                                {!m.userActive
                                  ? 'Account Deactivated'
                                  : m.membershipActive && !m.revokedAt
                                  ? 'Active'
                                  : 'Revoked'}
                              </span>
                              {m.expiresOn && (
                                <div className="text-[11px] text-slate-400 font-mono">Exp {m.expiresOn}</div>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                              {m.membershipActive && !m.revokedAt ? (
                                <button
                                  type="button"
                                  onClick={() => handleRevokeMembership(m.userId, m.username)}
                                  className="px-2 py-1 rounded border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40"
                                >
                                  Revoke Access
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleReactivateMembership(m.userId, m.username)}
                                  className="px-2 py-1 rounded border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                                >
                                  Restore
                                </button>
                              )}
                              {!isSelf && m.userActive && (
                                <button
                                  type="button"
                                  onClick={() => handleDeactivateUser(m.userId, m.username)}
                                  title="Globally deactivate user account and kill all sessions"
                                  className="px-2 py-1 rounded border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                                >
                                  Deactivate User
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pending / Recent Invitations */}
                <div className="border-t border-slate-200 dark:border-slate-800 px-4 py-3 bg-slate-50/70 dark:bg-slate-800/30">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-200 mb-2">
                    Recent Invitations ({invitations.length})
                  </div>
                  {invitations.length === 0 ? (
                    <div className="text-xs text-slate-500">No invitations issued yet for this company.</div>
                  ) : (
                    <div className="space-y-1.5 text-xs">
                      {invitations.slice(0, 6).map(inv => (
                        <div key={inv.id} className="flex items-center justify-between text-slate-700 dark:text-slate-300">
                          <span>
                            <strong>{inv.email}</strong> · {inv.role}
                          </span>
                          <span className="font-mono text-[11px] text-slate-500">{inv.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Invite New User Panel */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-4 self-start">
                <div className="flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-[#0f3d63] dark:text-amber-400" />
                  <h2 className="text-sm font-bold text-slate-900 dark:text-white">Invite Team Member</h2>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Generates a cryptographic one-time invitation token bound to {activeCompany?.name}. The user chooses their own password when accepting.
                </p>

                <form onSubmit={handleInviteSubmit} className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold mb-1">Email</label>
                    <input
                      type="email"
                      required
                      value={invEmail}
                      onChange={e => setInvEmail(e.target.value)}
                      placeholder="clerk@primepress.zm"
                      className="w-full px-3 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-semibold mb-1">Username</label>
                      <input
                        type="text"
                        required
                        value={invUsername}
                        onChange={e => setInvUsername(e.target.value)}
                        placeholder="clerk"
                        className="w-full px-3 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1">Role</label>
                      <select
                        value={invRole}
                        onChange={e => setInvRole(e.target.value as ServerCompanyRole)}
                        className="w-full px-2 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        {ROLE_OPTIONS.map(r => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1">Display Name</label>
                    <input
                      type="text"
                      value={invDisplayName}
                      onChange={e => setInvDisplayName(e.target.value)}
                      placeholder="Full Name"
                      className="w-full px-3 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold mb-1">Access Expiration Date (optional)</label>
                    <input
                      type="date"
                      value={invExpiresOn}
                      onChange={e => setInvExpiresOn(e.target.value)}
                      className="w-full px-3 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-2 px-3 rounded bg-[#0f3d63] hover:bg-[#0c3150] text-white text-xs font-semibold flex items-center justify-center gap-1.5"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>Issue One-Time Invite</span>
                  </button>
                </form>

                {issuedToken && (
                  <div className="p-3 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 space-y-1.5 text-xs">
                    <div className="font-semibold text-emerald-800 dark:text-emerald-300">
                      One-Time Invitation Token (copy once):
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 font-mono text-[11px] break-all bg-white dark:bg-slate-950 p-1.5 rounded border border-emerald-200 dark:border-emerald-900">
                        {issuedToken}
                      </code>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(issuedToken)}
                        className="p-1.5 rounded border border-emerald-300 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-900"
                        title="Copy token"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: COMPANIES & SWITCHING */}
      {tab === 'companies' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Your Authorized Companies</h2>
              <span className="text-xs font-mono tabular-nums text-slate-500">{companies.length} companies</span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {companies.map(c => {
                const isActive = c.id === activeCompany?.id;
                return (
                  <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Building2 className="w-4 h-4 text-slate-500 shrink-0" />
                        <span className="font-semibold text-sm text-slate-900 dark:text-white truncate">{c.name}</span>
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
                        <span className="font-mono">{c.slug}</span>
                        <span aria-hidden="true">·</span>
                        <span>Role: {c.role}</span>
                        <span aria-hidden="true">·</span>
                        <span>Currency: {c.currencySymbol || 'K'} ({c.baseCurrency || 'ZMW'})</span>
                      </div>
                    </div>
                    {isActive ? (
                      <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 whitespace-nowrap shrink-0 flex items-center gap-1">
                        <UserCheck className="w-3.5 h-3.5" /> Active Context
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await switchCompany(c.id);
                          if (ok) setStatusMsg({ type: 'ok', text: `Switched active context to ${c.name}.` });
                        }}
                        className="px-3 py-1.5 rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-semibold hover:opacity-90 whitespace-nowrap shrink-0"
                      >
                        Switch Company
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-4 self-start">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Create New Isolated Company</h2>
            {!canCreateCompany ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Only an Administrator can provision an additional isolated company book inside your workspace.
              </p>
            ) : (
              <form onSubmit={handleCreateCompany} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold mb-1">Company Name</label>
                  <input
                    type="text"
                    required
                    value={newCompName}
                    onChange={e => setNewCompName(e.target.value)}
                    placeholder="Kitwe Educational Publishers"
                    className="w-full px-3 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1">TPIN / Tax ID</label>
                  <input
                    type="text"
                    value={newCompEin}
                    onChange={e => setNewCompEin(e.target.value)}
                    placeholder="TPIN-300441920"
                    className="w-full px-3 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2 px-3 rounded bg-[#0f3d63] hover:bg-[#0c3150] text-white text-xs font-semibold flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create &amp; Switch Company</span>
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: RBAC PERMISSION MATRIX */}
      {tab === 'matrix' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Server-Enforced Role Permission Matrix
              </h2>
              <div className="text-xs text-slate-500">
                Active role highlighted: {activeCompany?.role}
              </div>
            </div>
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">Capability</th>
                  {ROLE_OPTIONS.map(r => (
                    <th
                      key={r}
                      className={`px-3 py-2.5 text-center font-semibold ${
                        r === activeCompany?.role ? 'text-[#0f3d63] dark:text-amber-400 underline' : ''
                      }`}
                    >
                      {r}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {matrixRows.map(row => (
                  <tr key={row.permission} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-2 font-mono text-[11px] text-slate-800 dark:text-slate-200">
                      {row.permission}
                    </td>
                    {ROLE_OPTIONS.map(r => (
                      <td key={r} className="px-3 py-2 text-center">
                        {row.roles[r] ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-semibold">Allow</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: SECURITY AUDIT TRAIL */}
      {tab === 'audit' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Tamper-Evident Security &amp; Access Audit Log
              </h2>
              <div className="text-xs text-slate-500">
                Append-only records isolated to {activeCompany?.name}
              </div>
            </div>
          </div>

          {!canReadAudit ? (
            <div className="p-6 text-xs text-slate-500">
              Audit log access requires <span className="font-mono">audit:read</span> permission (Administrator or Accountant).
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-left">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Timestamp</th>
                    <th className="px-4 py-2.5 font-semibold">Actor</th>
                    <th className="px-4 py-2.5 font-semibold">Action</th>
                    <th className="px-4 py-2.5 font-semibold">Target</th>
                    <th className="px-4 py-2.5 font-semibold">SHA-256 Digest</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {auditLogs.map(log => (
                    <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-2 font-mono tabular-nums text-[11px] text-slate-500">
                        {new Date(log.occurredAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2 font-medium text-slate-900 dark:text-white">
                        {log.actorUsername || 'system'}
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-200">
                        {log.action}
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] text-slate-500">
                        {log.tableName}#{log.recordId}
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] text-slate-400">
                        {log.sha256Hash.slice(0, 16)}…
                      </td>
                    </tr>
                  ))}
                  {auditLogs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                        No audit events logged yet in this company.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
