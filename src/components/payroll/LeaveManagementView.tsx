import React, { useCallback, useEffect, useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  Clock,
  XCircle,
  Plus,
  RefreshCw,
  User,
  AlertTriangle,
  X,
  FileText,
  Check,
  Ban,
} from 'lucide-react';
import { leaveApi } from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { appDialog, StatusBadge } from '../../design-system';

interface LeaveType {
  id: number;
  code: string;
  name: string;
  accrualDays: number;
  maxCarryForward: number;
  isPaid: boolean;
  isActive: boolean;
}

interface LeaveRequest {
  id: number;
  employeeId: number;
  employeeName?: string;
  leaveTypeId: number;
  leaveTypeName?: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  approvedBy: number | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

interface LeaveBalance {
  id: number;
  employeeId: number;
  leaveTypeId: number;
  leaveTypeName: string;
  year: number;
  openingBalance: number;
  accrued: number;
  taken: number;
  adjusted: number;
  remaining: number;
}

export const LeaveManagementView: React.FC = () => {
  const { employees, triggerShortcutNotice } = useAccounting();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('payroll:write');

  const [types, setTypes] = useState<LeaveType[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Modals
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showTypeModal, setShowTypeModal] = useState(false);
  const [rejectingRequest, setRejectingRequest] = useState<LeaveRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // New Request Form
  const today = new Date().toISOString().slice(0, 10);
  const [newRequest, setNewRequest] = useState({
    employeeId: employees[0]?.id ? String(employees[0].id) : '',
    leaveTypeId: '',
    startDate: today,
    endDate: today,
    daysRequested: 1,
    reason: '',
  });

  // New Type Form
  const [newType, setNewType] = useState({
    code: '',
    name: '',
    accrualDays: 21,
    maxCarryForward: 5,
    isPaid: true,
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, rRes] = await Promise.all([
        leaveApi.types(),
        leaveApi.requests(),
      ]);
      const fetchedTypes = tRes.leaveTypes || [];
      setTypes(fetchedTypes);
      setRequests(rRes.requests || []);
      if (!newRequest.leaveTypeId && fetchedTypes.length > 0) {
        setNewRequest(prev => ({ ...prev, leaveTypeId: String(fetchedTypes[0].id) }));
      }
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to load leave records', 'error');
    } finally {
      setLoading(false);
    }
  }, [triggerShortcutNotice, newRequest.leaveTypeId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRequest.employeeId || !newRequest.leaveTypeId || !newRequest.startDate || !newRequest.endDate) {
      triggerShortcutNotice('All required fields must be provided', 'error');
      return;
    }

    try {
      await leaveApi.createRequest({
        employeeId: Number(newRequest.employeeId),
        leaveTypeId: Number(newRequest.leaveTypeId),
        startDate: newRequest.startDate,
        endDate: newRequest.endDate,
        daysRequested: Number(newRequest.daysRequested),
        reason: newRequest.reason || undefined,
      });
      triggerShortcutNotice('Leave request submitted successfully');
      setShowRequestModal(false);
      setNewRequest(prev => ({
        ...prev,
        reason: '',
        daysRequested: 1,
      }));
      await loadData();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to submit leave request', 'error');
    }
  };

  const handleCreateType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newType.code.trim() || !newType.name.trim()) {
      triggerShortcutNotice('Code and Name are required', 'error');
      return;
    }

    try {
      await leaveApi.createType({
        code: newType.code,
        name: newType.name,
        accrualDays: Number(newType.accrualDays),
        maxCarryForward: Number(newType.maxCarryForward),
        isPaid: Boolean(newType.isPaid),
      });
      triggerShortcutNotice(`Leave type ${newType.name} created`);
      setShowTypeModal(false);
      setNewType({ code: '', name: '', accrualDays: 21, maxCarryForward: 5, isPaid: true });
      await loadData();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to create leave type', 'error');
    }
  };

  const handleApprove = async (req: LeaveRequest) => {
    const confirmed = await appDialog.confirm({
      title: 'Approve Leave Request',
      message: `Approve leave request for ${req.employeeName || getEmpName(req.employeeId)} (${req.daysRequested} days)?`,
      confirmLabel: 'Approve Leave',
      tone: 'emerald',
    });
    if (!confirmed) return;
    try {
      await leaveApi.approveRequest(req.id);
      triggerShortcutNotice(`Leave request #${req.id} approved`);
      await loadData();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to approve leave request', 'error');
    }
  };

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingRequest) return;
    try {
      await leaveApi.rejectRequest(rejectingRequest.id, rejectReason.trim() || 'Rejected by supervisor');
      triggerShortcutNotice(`Leave request #${rejectingRequest.id} rejected`);
      setRejectingRequest(null);
      setRejectReason('');
      await loadData();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to reject leave request', 'error');
    }
  };

  const handleCancel = async (req: LeaveRequest) => {
    const confirmed = await appDialog.confirm({
      title: 'Cancel Leave Request',
      message: `Cancel leave request #${req.id}?`,
      confirmLabel: 'Cancel Request',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await leaveApi.cancelRequest(req.id);
      triggerShortcutNotice(`Leave request #${req.id} cancelled`);
      await loadData();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to cancel leave request', 'error');
    }
  };

  const pendingCount = requests.filter(r => r.status === 'pending').length;
  const approvedCount = requests.filter(r => r.status === 'approved').length;
  const rejectedCount = requests.filter(r => r.status === 'rejected').length;

  const filteredRequests = requests.filter(r => {
    if (statusFilter === 'all') return true;
    return r.status === statusFilter;
  });

  const getEmpName = (empId: number) => {
    const e = employees.find(emp => Number(emp.id) === empId);
    return e ? `${e.firstName} ${e.lastName}` : `Employee #${empId}`;
  };

  const renderBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <StatusBadge tone="warning" showIcon>Pending Review</StatusBadge>;
      case 'approved':
        return <StatusBadge tone="success" showIcon>Approved</StatusBadge>;
      case 'rejected':
        return <StatusBadge tone="danger" showIcon>Rejected</StatusBadge>;
      case 'cancelled':
        return <StatusBadge tone="neutral">Cancelled</StatusBadge>;
      default:
        return <StatusBadge tone="neutral">{status}</StatusBadge>;
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <Calendar className="w-6 h-6 text-indigo-600" />
            Leave & Absence Management
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Track annual leave, sick days, compassionate leave and statutory entitlements.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            disabled={loading}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
            title="Refresh list"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {canWrite && (
            <>
              <button
                onClick={() => setShowTypeModal(true)}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold text-xs"
              >
                + Leave Types
              </button>
              <button
                onClick={() => setShowRequestModal(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-sm transition-all"
              >
                <Plus className="w-4 h-4" />
                <span>New Leave Request</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div
          onClick={() => setStatusFilter(prev => prev === 'pending' ? 'all' : 'pending')}
          className={`p-4 rounded-xl bg-white dark:bg-slate-900 border transition-all cursor-pointer ${
            statusFilter === 'pending' ? 'border-amber-500 ring-2 ring-amber-500/20' : 'border-slate-200 dark:border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Pending Sign-off</div>
            <Clock className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-1 tabular-nums">
            {pendingCount}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Awaiting management approval</div>
        </div>

        <div
          onClick={() => setStatusFilter(prev => prev === 'approved' ? 'all' : 'approved')}
          className={`p-4 rounded-xl bg-white dark:bg-slate-900 border transition-all cursor-pointer ${
            statusFilter === 'approved' ? 'border-emerald-500 ring-2 ring-emerald-500/20' : 'border-slate-200 dark:border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Approved Requests</div>
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1 tabular-nums">
            {approvedCount}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Deducted from employee balances</div>
        </div>

        <div
          onClick={() => setStatusFilter(prev => prev === 'rejected' ? 'all' : 'rejected')}
          className={`p-4 rounded-xl bg-white dark:bg-slate-900 border transition-all cursor-pointer ${
            statusFilter === 'rejected' ? 'border-rose-500 ring-2 ring-rose-500/20' : 'border-slate-200 dark:border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Rejected Requests</div>
            <XCircle className="w-4 h-4 text-rose-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-rose-600 dark:text-rose-400 mt-1 tabular-nums">
            {rejectedCount}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Declined or non-conforming requests</div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-medium w-fit">
        {[
          { id: 'all', label: `All Requests (${requests.length})` },
          { id: 'pending', label: `Pending (${pendingCount})` },
          { id: 'approved', label: `Approved (${approvedCount})` },
          { id: 'rejected', label: `Rejected (${rejectedCount})` },
          { id: 'cancelled', label: 'Cancelled' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setStatusFilter(tab.id)}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              statusFilter === tab.id
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-bold shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Requests Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Leave Type</th>
                <th className="px-4 py-3">Dates</th>
                <th className="px-4 py-3">Days</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredRequests.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No leave requests found matching current filter.
                  </td>
                </tr>
              ) : (
                filteredRequests.map(req => (
                  <tr key={req.id} className="hover:bg-slate-50 dark:hover:bg-slate-850/50 transition-colors">
                    <td className="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100">
                      {req.employeeName || getEmpName(req.employeeId)}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      <span className="font-medium">{req.leaveTypeName || 'Leave'}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                      {req.startDate} → {req.endDate}
                    </td>
                    <td className="px-4 py-3 font-mono font-bold text-slate-900 dark:text-white">
                      {req.daysRequested} d
                    </td>
                    <td className="px-4 py-3 text-slate-500 max-w-xs truncate">
                      {req.reason || '—'}
                      {req.rejectionReason && (
                        <div className="text-[10px] text-rose-500 italic mt-0.5">
                          Reason: {req.rejectionReason}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {renderBadge(req.status)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {canWrite && req.status === 'pending' && (
                          <>
                            <button
                              onClick={() => handleApprove(req)}
                              className="px-2.5 py-1 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 font-semibold hover:bg-emerald-100 text-[11px] transition-colors flex items-center gap-1"
                            >
                              <Check className="w-3 h-3" /> Approve
                            </button>
                            <button
                              onClick={() => {
                                setRejectingRequest(req);
                                setRejectReason('');
                              }}
                              className="px-2.5 py-1 rounded bg-rose-50 dark:bg-rose-950/50 text-rose-600 font-semibold hover:bg-rose-100 text-[11px] transition-colors flex items-center gap-1"
                            >
                              <Ban className="w-3 h-3" /> Reject
                            </button>
                          </>
                        )}
                        {canWrite && req.status !== 'cancelled' && req.status !== 'rejected' && (
                          <button
                            onClick={() => handleCancel(req)}
                            className="px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 text-[11px] transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Request Modal */}
      {showRequestModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Calendar className="w-5 h-5 text-indigo-600" />
                Submit Leave Request
              </h2>
              <button
                onClick={() => setShowRequestModal(false)}
                className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateRequest} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                  Employee *
                </label>
                <select
                  value={newRequest.employeeId}
                  onChange={e => setNewRequest({ ...newRequest, employeeId: e.target.value })}
                  className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                  required
                >
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>
                      {emp.firstName} {emp.lastName} ({emp.department})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                  Leave Type *
                </label>
                <select
                  value={newRequest.leaveTypeId}
                  onChange={e => setNewRequest({ ...newRequest, leaveTypeId: e.target.value })}
                  className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                  required
                >
                  {types.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.accrualDays} days/yr)
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                    Start Date *
                  </label>
                  <input
                    type="date"
                    value={newRequest.startDate}
                    onChange={e => setNewRequest({ ...newRequest, startDate: e.target.value })}
                    className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                    required
                  />
                </div>

                <div>
                  <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                    End Date *
                  </label>
                  <input
                    type="date"
                    value={newRequest.endDate}
                    onChange={e => setNewRequest({ ...newRequest, endDate: e.target.value })}
                    className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                  Working Days Requested *
                </label>
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={newRequest.daysRequested}
                  onChange={e => setNewRequest({ ...newRequest, daysRequested: Number(e.target.value) })}
                  className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                  Reason / Handover Note
                </label>
                <textarea
                  rows={2}
                  placeholder="Reason for absence or coverage details..."
                  value={newRequest.reason}
                  onChange={e => setNewRequest({ ...newRequest, reason: e.target.value })}
                  className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowRequestModal(false)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow-xs"
                >
                  Submit Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {rejectingRequest && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-sm w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Ban className="w-5 h-5 text-rose-600" />
                Reject Leave Request
              </h2>
              <button
                onClick={() => setRejectingRequest(null)}
                className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmReject} className="space-y-4 text-xs">
              <p className="text-slate-500">
                State reason for rejecting {rejectingRequest.employeeName}&apos;s leave request:
              </p>
              <textarea
                rows={3}
                placeholder="Operational requirements, conflicting leaves..."
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                required
              />

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setRejectingRequest(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold shadow-xs"
                >
                  Confirm Reject
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New Type Modal */}
      {showTypeModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-sm w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Add Leave Type
              </h2>
              <button
                onClick={() => setShowTypeModal(false)}
                className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateType} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                  Code *
                </label>
                <input
                  type="text"
                  placeholder="e.g. SICK, STUDY, MATERNITY"
                  value={newType.code}
                  onChange={e => setNewType({ ...newType, code: e.target.value })}
                  className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white font-mono uppercase"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Paid Sick Leave"
                  value={newType.name}
                  onChange={e => setNewType({ ...newType, name: e.target.value })}
                  className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                    Accrual Days/Yr
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={newType.accrualDays}
                    onChange={e => setNewType({ ...newType, accrualDays: Number(e.target.value) })}
                    className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                    Max Carry Fwd
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={newType.maxCarryForward}
                    onChange={e => setNewType({ ...newType, maxCarryForward: Number(e.target.value) })}
                    className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="isPaidCheck"
                  checked={newType.isPaid}
                  onChange={e => setNewType({ ...newType, isPaid: e.target.checked })}
                  className="rounded text-indigo-600"
                />
                <label htmlFor="isPaidCheck" className="text-slate-700 dark:text-slate-300">
                  Fully paid absence
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowTypeModal(false)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow-xs"
                >
                  Create Type
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
