import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { appDialog } from '../../design-system';
import {
  AlertTriangle,
  Ban,
  Bell,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Gauge,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  ApprovalPolicy,
  ApprovalRequest,
  DashboardAlerts,
  PeriodChecklist,
  ReportSchedule,
  financeControlsApi,
} from '../../services/financeControlsApi';
import { commercialApi } from '../../services/commercialApi';

type TabKey = 'approvals' | 'periods' | 'reports' | 'schedules' | 'alerts' | 'expenses' | 'accountingControls';

const TABS: Array<{ key: TabKey; label: string; icon: React.ElementType }> = [
  { key: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { key: 'periods', label: 'Period Close', icon: ClipboardCheck },
  { key: 'reports', label: 'Operational Reports', icon: Gauge },
  { key: 'schedules', label: 'Scheduled Reports', icon: CalendarClock },
  { key: 'alerts', label: 'Alerts', icon: Bell },
  { key: 'expenses', label: 'Expense Claims', icon: FileText },
  { key: 'accountingControls', label: 'Accounting Controls', icon: ShieldCheck },
];

const REPORT_OPTIONS = [
  { key: 'jobProfitability', label: 'Printing Job Profitability' },
  { key: 'wipAging', label: 'WIP Aging' },
  { key: 'spoilage', label: 'Printing Spoilage' },
  { key: 'estimateVsActual', label: 'Estimate vs Actual' },
  { key: 'inventoryValuation', label: 'Inventory Valuation' },
  { key: 'cogsReconciliation', label: 'COGS Reconciliation' },
];

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'approved' || status === 'complete'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : status === 'rejected' || status === 'cancelled'
      ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
      : status === 'waived'
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
      : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      {status}
    </span>
  );
}

function panelClass(): string {
  return 'rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900';
}

export const FinanceControlsView: React.FC = () => {
  const { hasPermission } = useAuth();
  const canReadApprovals = hasPermission('approvals:read');
  const canDecideApprovals = hasPermission('approvals:decide');
  const canConfigureApprovals = hasPermission('approvals:configure');
  const canClosePeriods = hasPermission('periods:close');
  const canScheduleReports = hasPermission('reports:schedule');
  const canReadReports = hasPermission('reports:read');
  const [activeTab, setActiveTab] = useState<TabKey>('approvals');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [policies, setPolicies] = useState<ApprovalPolicy[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalStatus, setApprovalStatus] = useState('pending');

  const [periods, setPeriods] = useState<
    Array<{ id: number; period_name: string; start_date: string; end_date: string; status: string }>
  >([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState<number | null>(null);
  const [checklist, setChecklist] = useState<PeriodChecklist | null>(null);

  const [reportKey, setReportKey] = useState('jobProfitability');
  const [report, setReport] = useState<any>(null);

  const [schedules, setSchedules] = useState<ReportSchedule[]>([]);
  const [editingSchedule, setEditingSchedule] = useState<ReportSchedule | null>(null);
  const [editScheduleName, setEditScheduleName] = useState('');
  const [editScheduleFreq, setEditScheduleFreq] = useState('monthly');
  const [editScheduleDay, setEditScheduleDay] = useState('1');
  const [editScheduleRecipients, setEditScheduleRecipients] = useState('');
  const [availableReports, setAvailableReports] = useState<Array<{ key: string; label: string }>>([]);
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleReport, setScheduleReport] = useState('trial_balance');
  const [scheduleFrequency, setScheduleFrequency] = useState('monthly');
  const [scheduleDay, setScheduleDay] = useState('1');
  const [scheduleRecipients, setScheduleRecipients] = useState('');

  const [alerts, setAlerts] = useState<DashboardAlerts | null>(null);
  const [loading, setLoading] = useState(false);
  const [expenseClaims, setExpenseClaims] = useState<any[]>([]);
  const [controlEvents, setControlEvents] = useState<any[]>([]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadApprovals = useCallback(async () => {
    const [p, q] = await Promise.all([
      financeControlsApi.listPolicies(),
      financeControlsApi.listApprovals(approvalStatus),
    ]);
    setPolicies(p);
    setApprovals(q);
  }, [approvalStatus]);

  useEffect(() => {
    if (activeTab === 'approvals') void run(async () => loadApprovals());
  }, [activeTab, run, loadApprovals]);

  useEffect(() => {
    if (activeTab === 'periods') {
      void run(async () => {
        const list = await financeControlsApi.listPeriods();
        setPeriods(list);
        if (!selectedPeriodId && list.length > 0) setSelectedPeriodId(list[0].id);
      });
    }
  }, [activeTab, run]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeTab === 'periods' && selectedPeriodId) {
      void run(async () => {
        setChecklist(await financeControlsApi.getChecklist(selectedPeriodId));
      });
    }
  }, [activeTab, run, selectedPeriodId]);

  useEffect(() => {
    if (activeTab === 'alerts') {
      void run(async () => setAlerts(await financeControlsApi.dashboardAlerts()));
    }
  }, [activeTab, run]);

  useEffect(() => {
    if (activeTab === 'expenses') {
      void run(async () => setExpenseClaims(await commercialApi.listExpenseClaims()));
    }
  }, [activeTab, run]);

  useEffect(() => {
    if (activeTab === 'accountingControls') {
      void run(async () => setControlEvents(await commercialApi.listAccountingControlEvents(100)));
    }
  }, [activeTab, run]);

  useEffect(() => {
    if (activeTab === 'schedules') {
      void run(async () => {
        const data = await financeControlsApi.listSchedules();
        setSchedules(data.schedules);
        setAvailableReports(data.availableReports);
      });
    }
  }, [activeTab, run]);

  const savePolicy = async (policy: ApprovalPolicy, threshold: string, enabled: boolean) => {
    await run(async () => {
      const updated = await financeControlsApi.updatePolicy({
        actionType: policy.action_type,
        thresholdAmount: threshold,
        isEnabled: enabled,
      });
      setPolicies(prev => prev.map(p => (p.id === updated.id ? updated : p)));
      setNotice(`Approval policy for ${policy.action_type} saved.`);
    });
  };

  const decide = async (request: ApprovalRequest, action: 'approve' | 'reject') => {
    const note = await appDialog.prompt({
      title: action === 'reject' ? `Reject Request #${request.id}` : `Approve Request #${request.id}`,
      message:
        action === 'reject'
          ? 'Enter a rejection note explaining why this approval request is declined.'
          : 'Enter an optional approval note.',
      label: action === 'reject' ? 'Rejection note' : 'Approval note (optional)',
      required: action === 'reject',
      destructive: action === 'reject',
      confirmLabel: action === 'reject' ? 'Reject Request' : 'Approve Request',
      multiline: true,
    });
    if (note === null) return;
    if (action === 'reject' && !note.trim()) return;
    await run(async () => {
      if (action === 'approve') await financeControlsApi.approve(request.id, note);
      else await financeControlsApi.reject(request.id, note);
      await loadApprovals();
      setNotice(`Request #${request.id} ${action}d.`);
    });
  };

  const cancelApproval = async (request: ApprovalRequest) => {
    const ok = await appDialog.confirm({
      title: `Cancel Approval Request #${request.id}`,
      message: `Cancel approval request #${request.id}? The requested transaction will not proceed.`,
      confirmLabel: 'Cancel Request',
      destructive: true,
    });
    if (!ok) return;
    await run(async () => {
      await financeControlsApi.cancelApproval(request.id);
      await loadApprovals();
      setNotice(`Request #${request.id} cancelled.`);
    });
  };

  const toggleScheduleActive = async (schedule: ReportSchedule) => {
    await run(async () => {
      await financeControlsApi.updateSchedule(schedule.id, { isActive: !schedule.is_active });
      const data = await financeControlsApi.listSchedules();
      setSchedules(data.schedules);
      setNotice(`Schedule "${schedule.name}" ${schedule.is_active ? 'paused' : 'resumed'}.`);
    });
  };

  const deleteSchedule = async (schedule: ReportSchedule) => {
    const ok = await appDialog.confirm({
      title: 'Delete Scheduled Report',
      message: `Delete the scheduled report "${schedule.name}"? This cannot be undone.`,
      confirmLabel: 'Delete Schedule',
      destructive: true,
    });
    if (!ok) return;
    await run(async () => {
      await financeControlsApi.deleteSchedule(schedule.id);
      const data = await financeControlsApi.listSchedules();
      setSchedules(data.schedules);
      setNotice(`Schedule "${schedule.name}" deleted.`);
    });
  };

  const loadReport = async (key: string) => {
    setReportKey(key);
    await run(async () => setReport(await financeControlsApi.getReport(key)));
  };

  const createSchedule = async () => {
    const recipients = scheduleRecipients
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    await run(async () => {
      await financeControlsApi.createSchedule({
        name: scheduleName.trim(),
        reportKey: scheduleReport,
        frequency: scheduleFrequency,
        dayOfMonth: Number(scheduleDay) || 1,
        recipients,
      });
      setScheduleName('');
      setScheduleRecipients('');
      const data = await financeControlsApi.listSchedules();
      setSchedules(data.schedules);
      setAvailableReports(data.availableReports);
      setNotice('Report schedule created.');
    });
  };

  const renderApprovals = () => (
    <div className="space-y-4">
      <div className={panelClass()}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">Maker-checker policies</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Transactions at or above the threshold return 202 and require a different user to approve.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-slate-500 dark:text-slate-400">
              <tr>
                <th className="px-2 py-2">Action</th>
                <th className="px-2 py-2">Threshold</th>
                <th className="px-2 py-2">Enabled</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {policies.map(p => {
                const threshold = p.threshold_amount;
                const enabled = p.is_enabled;
                return (
                  <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-2 font-medium capitalize text-slate-700 dark:text-slate-200">
                      {p.action_type.replace(/_/g, ' ')}
                    </td>
                    <td className="px-2 py-2">
                      <input
                        className="w-32 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                        defaultValue={threshold}
                        id={`policy-${p.id}`}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input type="checkbox" defaultChecked={enabled} id={`policy-enabled-${p.id}`} />
                    </td>
                    <td className="px-2 py-2 text-right">
                      {canConfigureApprovals && (
                        <button
                        className="rounded bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900"
                        onClick={() => {
                          const input = document.getElementById(`policy-${p.id}`) as HTMLInputElement | null;
                          const check = document.getElementById(`policy-enabled-${p.id}`) as HTMLInputElement | null;
                          void savePolicy(p, input?.value || '0', Boolean(check?.checked));
                        }}
                      >
                        Save
                      </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={panelClass()}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Approval queue</h3>
          <div className="flex items-center gap-2">
            <select
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
              value={approvalStatus}
              onChange={e => setApprovalStatus(e.target.value)}
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button
              className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
              onClick={() => void run(async () => loadApprovals())}
            >
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-slate-500 dark:text-slate-400">
              <tr>
                <th className="px-2 py-2">#</th>
                <th className="px-2 py-2">Action</th>
                <th className="px-2 py-2">Amount</th>
                <th className="px-2 py-2">Requested by</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {approvals.map(r => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-2 py-2">{r.id}</td>
                  <td className="px-2 py-2 capitalize">{r.action_type.replace(/_/g, ' ')}</td>
                    <td className="px-2 py-2 font-semibold">{Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="px-2 py-2">{r.requested_by_name || r.requested_by}</td>
                  <td className="px-2 py-2"><StatusBadge status={r.status} /></td>
                  <td className="px-2 py-2">{r.business_date}</td>
                  <td className="px-2 py-2 text-right">
                    {r.status === 'pending' && (
                      <div className="flex justify-end gap-1">
                        {canDecideApprovals && (
                          <>
                            <button
                              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white"
                              onClick={() => void decide(r, 'approve')}
                            >
                              <CheckCircle2 size={12} /> Approve
                            </button>
                            <button
                              className="inline-flex items-center gap-1 rounded bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white"
                              onClick={() => void decide(r, 'reject')}
                            >
                              <XCircle size={12} /> Reject
                            </button>
                          </>
                        )}
                        {canReadApprovals && (
                          <button
                            className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200"
                            onClick={() => void cancelApproval(r)}
                            title="Cancel this approval request"
                          >
                            <Ban size={12} /> Cancel
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {approvals.length === 0 && (
                <tr>
                  <td className="px-2 py-4 text-slate-500" colSpan={7}>No approval requests in this status.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  const renderPeriods = () => (
    <div className="space-y-4">
      <div className={panelClass()}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">Period close checklist</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Automatic tasks are derived from ledger evidence; manual tasks require sign-off.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
              value={selectedPeriodId ?? ''}
              onChange={e => setSelectedPeriodId(Number(e.target.value))}
            >
              <option value="">Select period</option>
              {periods.map(p => (
                <option key={p.id} value={p.id}>
                  {p.period_name} ({p.start_date} → {p.end_date})
                </option>
              ))}
            </select>
            <button
              className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
              disabled={!selectedPeriodId}
              onClick={() => {
                if (!selectedPeriodId) return;
                void run(async () => setChecklist(await financeControlsApi.getChecklist(selectedPeriodId)));
              }}
            >
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>
        {checklist ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <StatusBadge status={checklist.period.status} />
              <span className={checklist.allRequiredComplete ? 'text-emerald-600' : 'text-amber-600'}>
                {checklist.allRequiredComplete ? 'All required tasks complete' : 'Required tasks incomplete'}
              </span>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={checklist.enforced}
                  disabled={!canClosePeriods}
                  onChange={e => {
                    if (!canClosePeriods) return;
                    const enabled = e.target.checked;
                    void run(async () => {
                      await financeControlsApi.setChecklistPolicy(enabled);
                      setChecklist({ ...checklist, enforced: enabled });
                      setNotice(`Close enforcement ${enabled ? 'enabled' : 'disabled'}.`);
                    });
                  }}
                />
                Enforce before close
              </label>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {checklist.tasks.map(task => (
                <div key={task.task_key} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">{task.label}</span>
                      <StatusBadge status={task.status} />
                      {task.is_required && <span className="text-[10px] font-bold uppercase text-rose-500">Required</span>}
                      {task.is_manual && <span className="text-[10px] font-bold uppercase text-slate-400">Manual</span>}
                    </div>
                    {Object.keys(task.evidence_json || {}).length > 0 && (
                      <pre className="mt-1 max-w-full overflow-x-auto text-[10px] text-slate-500 dark:text-slate-400">
                        {JSON.stringify(task.evidence_json)}
                      </pre>
                    )}
                    {task.notes && <p className="mt-1 text-[11px] text-slate-500">{task.notes}</p>}
                  </div>
                  {task.is_manual && task.status === 'pending' && selectedPeriodId && canClosePeriods && (
                    <button
                      className="rounded bg-slate-900 px-3 py-1 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900"
                      onClick={() => {
                        void (async () => {
                          const notes = await appDialog.prompt({
                            title: `Complete Task — ${task.task_key}`,
                            message: 'Provide a completion note for the period-close audit record.',
                            label: 'Completion note',
                            required: true,
                            multiline: true,
                          });
                          if (!notes?.trim()) return;
                          await run(async () => {
                            const updated = await financeControlsApi.completeTask(selectedPeriodId, task.task_key, notes);
                            setChecklist({
                              ...checklist,
                              tasks: checklist.tasks.map(t => (t.task_key === updated.task_key ? updated : t)),
                            });
                            setNotice(`Task ${task.task_key} completed.`);
                          });
                        })();
                      }}
                    >
                      Complete
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Select a fiscal period to view its close checklist.</p>
        )}
      </div>
    </div>
  );

  const renderReports = () => {
    const rows: any[] = Array.isArray(report?.rows) ? report.rows : [];
    const columns = rows.length > 0 ? Object.keys(rows[0]).slice(0, 10) : [];
    return (
      <div className="space-y-4">
        <div className={panelClass()}>
          <div className="flex flex-wrap gap-2">
            {REPORT_OPTIONS.map(opt => (
              <button
                key={opt.key}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  reportKey === opt.key
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'border border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300'
                }`}
                onClick={() => void loadReport(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {report && (
          <div className={panelClass()}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                {REPORT_OPTIONS.find(o => o.key === reportKey)?.label}
              </h3>
              <button
                className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
                onClick={() => void loadReport(reportKey)}
              >
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
            {report.totals && (
              <pre className="mb-3 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                {JSON.stringify(report.totals, null, 2)}
              </pre>
            )}
            {rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-[11px]">
                  <thead className="text-slate-500 dark:text-slate-400">
                    <tr>
                      {columns.map(c => <th key={c} className="px-2 py-1">{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 50).map((row, i) => (
                      <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                        {columns.map(c => (
                          <td key={c} className="px-2 py-1">{typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c] ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-500">No rows returned for this range.</p>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderSchedules = () => (
    <div className="space-y-4">
      <div className={panelClass()}>
        <h3 className="mb-3 text-sm font-bold text-slate-900 dark:text-white">Create report schedule</h3>
        <div className="grid gap-2 md:grid-cols-2">
          <input
            className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
            placeholder="Schedule name"
            value={scheduleName}
            onChange={e => setScheduleName(e.target.value)}
          />
          <select
            className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
            value={scheduleReport}
            onChange={e => setScheduleReport(e.target.value)}
          >
            {(availableReports.length ? availableReports : REPORT_OPTIONS.map(o => ({ key: o.key, label: o.label }))).map(r => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
          <select
            className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
            value={scheduleFrequency}
            onChange={e => setScheduleFrequency(e.target.value)}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
          <input
            className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
            placeholder="Day of month (1-28)"
            value={scheduleDay}
            onChange={e => setScheduleDay(e.target.value)}
          />
          <input
            className="rounded border border-slate-300 px-2 py-1 text-xs md:col-span-2 dark:border-slate-700 dark:bg-slate-950"
            placeholder="Recipients (comma separated)"
            value={scheduleRecipients}
            onChange={e => setScheduleRecipients(e.target.value)}
          />
        </div>
        <button
          className="mt-3 inline-flex items-center gap-1 rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900 disabled:opacity-50"
          disabled={!canScheduleReports}
          onClick={() => void createSchedule()}
        >
          <Plus size={13} /> Create schedule
        </button>
      </div>
      <div className={panelClass()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Schedules</h3>
          {canScheduleReports && (
            <button
              className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
              onClick={() =>
                void run(async () => {
                  const res = await financeControlsApi.runDueSchedules();
                  setNotice(`Ran ${res.results.length} due schedule(s).`);
                  const data = await financeControlsApi.listSchedules();
                  setSchedules(data.schedules);
                })
              }
            >
              <Play size={13} /> Run due
            </button>
          )}
        </div>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {schedules.map(s => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{s.name}</p>
                <p className="text-[11px] text-slate-500">
                  {s.report_key} · {s.frequency} · next {new Date(s.next_run_at).toLocaleString()} · {s.recipients.length} recipient(s)
                </p>
              </div>
              {canScheduleReports && (
                <div className="flex items-center gap-1">
                  <button
                    className="inline-flex items-center gap-1 rounded bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900"
                    onClick={() =>
                      void run(async () => {
                        const res = await financeControlsApi.runSchedule(s.id);
                        setNotice(`Schedule ran (${res.run.status}) for ${res.run.recipientsCount} recipient(s).`);
                        const data = await financeControlsApi.listSchedules();
                        setSchedules(data.schedules);
                      })
                    }
                  >
                    <Play size={11} /> Run now
                  </button>
                  <button
                    className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200"
                    onClick={() => void toggleScheduleActive(s)}
                    title={s.is_active ? 'Pause this schedule' : 'Resume this schedule'}
                  >
                    {s.is_active ? <Pause size={11} /> : <Play size={11} />}
                    {s.is_active ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200"
                    onClick={() => {
                      setEditingSchedule(s);
                      setEditScheduleName(s.name);
                      setEditScheduleFreq(s.frequency);
                      setEditScheduleDay(String(s.day_of_month ?? 1));
                      setEditScheduleRecipients(s.recipients.join(', '));
                    }}
                    title="Edit this schedule"
                  >
                    <Pencil size={11} /> Edit
                  </button>
                  <button
                    className="inline-flex items-center gap-1 rounded border border-rose-300 px-2 py-1 text-[11px] font-semibold text-rose-700 dark:border-rose-900 dark:text-rose-300"
                    onClick={() => void deleteSchedule(s)}
                    title="Delete this schedule"
                  >
                    <Trash2 size={11} /> Delete
                  </button>
                </div>
              )}
            </div>
          ))}
          {schedules.length === 0 && <p className="py-3 text-xs text-slate-500">No schedules configured.</p>}
        </div>
      </div>
    </div>
  );

  const renderExpenses = () => (
    <div className={panelClass()}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Expense Claims</h3>
        <button className="btn-secondary px-2 py-1 text-[11px]" onClick={() => void run(async () => setExpenseClaims(await commercialApi.listExpenseClaims()))}><RefreshCw size={12} className="inline mr-1" />Refresh</button>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-slate-500"><th className="py-1">Claim</th><th>Claimant</th><th>Status</th><th className="text-right">Amount</th><th className="text-right">Actions</th></tr></thead>
          <tbody>
            {expenseClaims.length === 0 ? <tr><td colSpan={5} className="py-4 text-center text-slate-400">No expense claims.</td></tr> : expenseClaims.map((c: any) => (
              <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 font-medium">{c.claim_number || c.id}</td>
                <td>{c.claimant_name || c.claimantName || '-'}</td>
                <td><StatusBadge status={c.status || 'draft'} /></td>
                <td className="text-right font-mono">{c.total_amount ?? c.totalAmount ?? '-'}</td>
                <td className="text-right space-x-1">
                  {c.status === 'draft' && <button className="text-[11px] text-brand underline" onClick={() => void run(async () => { await commercialApi.submitExpenseClaim(Number(c.id)); setExpenseClaims(await commercialApi.listExpenseClaims()); setNotice('Claim submitted'); })}>Submit</button>}
                  {c.status === 'submitted' && <button className="text-[11px] text-emerald-600 underline" onClick={() => void run(async () => { await commercialApi.approveExpenseClaim(Number(c.id)); setExpenseClaims(await commercialApi.listExpenseClaims()); setNotice('Claim approved'); })}>Approve</button>}
                  {c.status === 'submitted' && <button type="button" className="text-[11px] font-semibold text-rose-600 underline" onClick={() => void run(async () => { const reason = await appDialog.prompt({ title: `Reject Claim ${c.claim_number || c.id}`, message: 'Provide a reason for rejecting this expense claim.', label: 'Rejection reason', defaultValue: 'Rejected', required: true, destructive: true }); if (!reason) return; await commercialApi.rejectExpenseClaim(Number(c.id), reason); setExpenseClaims(await commercialApi.listExpenseClaims()); setNotice('Claim rejected'); })}>Reject</button>}
                  {c.status === 'approved' && <button type="button" className="text-[11px] font-semibold text-brand-600 underline" onClick={() => void run(async () => { const bank = await appDialog.prompt({ title: `Reimburse Claim ${c.claim_number || c.id}`, message: 'Enter the bank account ID used for reimbursement.', label: 'Bank account ID', inputType: 'number', required: true }); if (!bank) return; await commercialApi.reimburseExpenseClaim(Number(c.id), { bankAccountId: Number(bank) }); setExpenseClaims(await commercialApi.listExpenseClaims()); setNotice('Claim reimbursed'); })}>Reimburse</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderAccountingControls = () => (
    <div className={panelClass()}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Accounting Control Events</h3>
        <button className="btn-secondary px-2 py-1 text-[11px]" onClick={() => void run(async () => setControlEvents(await commercialApi.listAccountingControlEvents(100)))}><RefreshCw size={12} className="inline mr-1" />Refresh</button>
      </div>
      <div className="overflow-auto max-h-[420px]">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-slate-500"><th className="py-1">Time</th><th>Type</th><th>Entity</th><th>Actor</th><th>Note</th></tr></thead>
          <tbody>
            {controlEvents.length === 0 ? <tr><td colSpan={5} className="py-4 text-center text-slate-400">No control events.</td></tr> : controlEvents.map((e: any) => (
              <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 font-mono text-[11px]">{String(e.created_at || e.createdAt || '').slice(0, 19).replace('T', ' ')}</td>
                <td>{e.event_type || e.eventType}</td>
                <td>{e.entity_type || e.entityType} #{e.entity_id || e.entityId || '-'}</td>
                <td>{e.actor_username || e.actorUsername || '-'}</td>
                <td className="text-slate-500">{e.note || e.reason || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderAlerts = () => (
    <div className="space-y-3">
      {!alerts && <p className="text-xs text-slate-500">Loading alerts…</p>}
      {alerts && alerts.alerts.length === 0 && (
        <div className={panelClass()}>
          <p className="text-sm font-semibold text-emerald-600">No active alerts.</p>
        </div>
      )}
      {alerts?.alerts.map(a => (
        <div key={a.key} className={panelClass()}>
          <div className="flex items-start gap-3">
            {a.severity === 'critical' ? (
              <XCircle className="mt-0.5 text-rose-500" size={20} />
            ) : a.severity === 'warning' ? (
              <AlertTriangle className="mt-0.5 text-amber-500" size={20} />
            ) : (
              <Bell className="mt-0.5 text-blue-500" size={20} />
            )}
            <div>
              <p className="text-sm font-bold text-slate-900 dark:text-white">{a.title}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {a.count !== undefined ? `${a.count} item(s)` : ''}
                {a.amount ? ` · ${Number(a.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}
                {a.detail ? ` · ${a.detail}` : ''}
              </p>
              {Array.isArray(a.items) && a.items.length > 0 && (
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-50 p-2 text-[10px] text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                  {JSON.stringify(a.items, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-900 dark:text-white">Finance Controls & Reporting</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Maker-checker approvals, period close evidence, operational reports, scheduled delivery, and alerts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw className="animate-spin text-slate-400" size={16} />}
          <span className="text-[11px] text-slate-500">Company-scoped · server-enforced</span>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 pb-2 dark:border-slate-800">
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              className={`inline-flex items-center gap-1 rounded-t px-3 py-1.5 text-xs font-semibold ${
                activeTab === tab.key
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon size={14} /> {tab.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mb-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {activeTab === 'approvals' && renderApprovals()}
      {activeTab === 'periods' && renderPeriods()}
      {activeTab === 'reports' && renderReports()}
      {activeTab === 'schedules' && renderSchedules()}
      {activeTab === 'alerts' && renderAlerts()}
      {activeTab === 'expenses' && renderExpenses()}
      {activeTab === 'accountingControls' && renderAccountingControls()}
  {editingSchedule && (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
        <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
          <span className="font-bold text-sm">Edit Schedule {editingSchedule.name}</span>
          <button type="button" onClick={() => setEditingSchedule(null)} className="text-white/80 hover:text-white">
            ✕
          </button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <input
            className="w-full rounded border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
            value={editScheduleName}
            onChange={e => setEditScheduleName(e.target.value)}
            placeholder="Name"
          />
          <select
            className="w-full rounded border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
            value={editScheduleFreq}
            onChange={e => setEditScheduleFreq(e.target.value)}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
          <input
            className="w-full rounded border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
            value={editScheduleDay}
            onChange={e => setEditScheduleDay(e.target.value)}
            placeholder="Day of month (1-28)"
          />
          <input
            className="w-full rounded border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950"
            value={editScheduleRecipients}
            onChange={e => setEditScheduleRecipients(e.target.value)}
            placeholder="Recipients (comma separated)"
          />
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setEditingSchedule(null)}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await financeControlsApi.updateSchedule(editingSchedule.id, {
                    name: editScheduleName.trim(),
                    frequency: editScheduleFreq as any,
                    dayOfMonth: Number(editScheduleDay) || 1,
                    recipients: editScheduleRecipients.split(',').map(s => s.trim()).filter(Boolean),
                  });
                  setEditingSchedule(null);
                  const data = await financeControlsApi.listSchedules();
                  setSchedules(data.schedules);
                  setNotice('Schedule updated.');
                })
              }
              className="px-4 py-2 rounded-lg bg-slate-900 text-white font-bold dark:bg-slate-100 dark:text-slate-900"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )}
    </div>
  );
};