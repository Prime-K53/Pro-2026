import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { printingApi, ApiPrintingJob } from '../../services/printingApi';
import { commercialApi } from '../../services/commercialApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { Loader2, Printer, Wrench, X, TrendingUp } from 'lucide-react';
import { appDialog } from '../../design-system';

/** Preferred left-to-right column order; any other statuses append in alpha order. */
const STATUS_ORDER = [
  'draft',
  'approved',
  'scheduled',
  'printing',
  'in_progress',
  'qc_hold',
  'qc_passed',
  'completed',
  'invoiced',
  'cancelled',
];

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  approved: 'Approved',
  scheduled: 'Scheduled',
  printing: 'Printing',
  in_progress: 'Printing',
  qc_hold: 'QC Hold',
  qc_passed: 'QC Passed',
  completed: 'Completed',
  invoiced: 'Invoiced',
  cancelled: 'Cancelled',
};

/**
 * Production scheduling board: every printing job grouped by its lifecycle
 * status into kanban columns, with a drill-down showing the job's live
 * profitability (revenue, cost, gross profit, margin) from the server.
 */
export const ProductionScheduleView: React.FC = () => {
  const { companyProfile } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [jobs, setJobs] = useState<ApiPrintingJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<ApiPrintingJob | null>(null);
  const [expandedParent, setExpandedParent] = useState<number | null>(null);
  const [profit, setProfit] = useState<any | null>(null);
  const [profitLoading, setProfitLoading] = useState(false);
  const [profitError, setProfitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await printingApi.listJobs();
      setJobs(list);
    } catch (err: any) {
      setError(err?.message || 'Failed to load production jobs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openJob = async (job: ApiPrintingJob) => {
    setSelected(job);
    setProfit(null);
    setProfitError(null);
    setProfitLoading(true);
    try {
      const report = await printingApi.getJobProfitability(job.id);
      setProfit(report);
    } catch (err: any) {
      setProfitError(err?.message || 'Profitability unavailable for this job');
    } finally {
      setProfitLoading(false);
    }
  };

  const columns = useMemo(() => {
    // Examination parent jobs and their children are shown as one expandable
    // group above the board; they are excluded from the status columns.
    const parentIds = new Set(jobs.filter(j => j.jobType === 'exam_batch').map(j => j.id));
    const standalone = jobs.filter(
      j => j.jobType !== 'exam_batch' && !(j.parentJobId != null && parentIds.has(j.parentJobId))
    );
    const groups = new Map<string, ApiPrintingJob[]>();
    for (const job of standalone) {
      const key = job.status || 'draft';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(job);
    }
    const known = STATUS_ORDER.filter(s => groups.has(s));
    const extra = Array.from(groups.keys())
      .filter(s => !STATUS_ORDER.includes(s))
      .sort();
    return [...known, ...extra].map(status => ({ status, jobs: groups.get(status)! }));
  }, [jobs]);

  const examParents = useMemo(() => {
    const parents = jobs.filter(j => j.jobType === 'exam_batch');
    const childrenByParent = new Map<number, ApiPrintingJob[]>();
    for (const j of jobs) {
      if (j.parentJobId != null) {
        const list = childrenByParent.get(j.parentJobId) || [];
        list.push(j);
        childrenByParent.set(j.parentJobId, list);
      }
    }
    return parents.map(p => ({ parent: p, children: childrenByParent.get(p.id) || [] }));
  }, [jobs]);

  return (
    <div className="p-6 space-y-5 max-w-[1600px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Production Schedule</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {jobs.length} job(s) across {columns.length} stage(s). Select a job to see its live profitability.
          </p>
        </div>
        <button onClick={load} className="btn btn-secondary text-xs" disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
          Refresh
        </button>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-bold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1"><Wrench className="w-3.5 h-3.5" />Machine Ops</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              const jobRaw = await appDialog.prompt({
                title: 'Assign Machine to Job',
                message: 'Enter the printing job ID to assign.',
                label: 'Job ID',
                inputType: 'number',
                required: true,
              });
              if (!jobRaw) return;
              const machineRaw = await appDialog.prompt({
                title: 'Select Machine',
                message: 'Enter the machine ID to assign to this job.',
                label: 'Machine ID',
                inputType: 'number',
                required: true,
              });
              const jobId = Number(jobRaw);
              const machineId = Number(machineRaw);
              if (!jobId || !machineId) return;
              try {
                await commercialApi.assignJobMachine(jobId, { machineId });
                await appDialog.alert({ title: 'Machine Assigned', message: `Machine #${machineId} assigned to Job #${jobId}.`, tone: 'emerald' });
              } catch (e: any) {
                await appDialog.alert({ title: 'Assignment Failed', message: e?.message || 'Failed to assign machine.', tone: 'rose' });
              }
            }}
          >
            Assign Machine
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              const jobRaw = await appDialog.prompt({
                title: 'Move Job Stage',
                message: 'Enter the printing job ID to update.',
                label: 'Job ID',
                inputType: 'number',
                required: true,
              });
              if (!jobRaw) return;
              const toStatus = await appDialog.prompt({
                title: 'Target Production Stage',
                message: 'Specify the new status (e.g. in_production, qc_hold, completed).',
                label: 'New status',
                defaultValue: 'in_production',
                required: true,
              });
              const jobId = Number(jobRaw);
              if (!jobId || !toStatus) return;
              try {
                await commercialApi.moveJobStage(jobId, { toStatus });
                await appDialog.alert({ title: 'Stage Updated', message: `Job #${jobId} moved to ${toStatus}.`, tone: 'emerald' });
                load();
              } catch (e: any) {
                await appDialog.alert({ title: 'Stage Update Failed', message: e?.message || 'Failed to move job stage.', tone: 'rose' });
              }
            }}
          >
            Move Stage
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              const machineRaw = await appDialog.prompt({
                title: 'Log Machine Downtime',
                message: 'Enter the machine ID experiencing downtime.',
                label: 'Machine ID',
                inputType: 'number',
                required: true,
              });
              const machineId = Number(machineRaw);
              if (!machineId) return;
              const reasonInput = await appDialog.prompt({
                title: 'Downtime Reason',
                message: 'Describe the cause of downtime.',
                label: 'Reason',
                defaultValue: 'Maintenance',
                required: true,
              });
              if (reasonInput === null) return;
              const reason = reasonInput.trim() || 'Maintenance';
              try {
                await commercialApi.logMachineDowntime(machineId, { reason, startTime: new Date().toISOString() });
                await appDialog.alert({ title: 'Downtime Logged', message: `Recorded downtime for Machine #${machineId}.`, tone: 'emerald' });
              } catch (e: any) {
                await appDialog.alert({ title: 'Log Failed', message: e?.message || 'Failed to log downtime.', tone: 'rose' });
              }
            }}
          >
            Log Downtime
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs">
          {error}
        </div>
      )}

      {examParents.length > 0 && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            <Printer className="w-3.5 h-3.5" /> Examination Production
          </div>
          {examParents.map(({ parent, children }) => {
            const done = children.filter(c => ['completed', 'qc_passed', 'packed', 'dispatched', 'delivered', 'invoiced'].includes(c.status)).length;
            const pct = children.length > 0 ? Math.round((done / children.length) * 100) : 0;
            const open = expandedParent === parent.id;
            return (
              <div key={parent.id} className="rounded-lg border border-slate-200 dark:border-slate-800">
                <button
                  onClick={() => setExpandedParent(open ? null : parent.id)}
                  className="w-full text-left p-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] font-bold text-slate-500">{parent.jobNumber}</span>
                    <span className="text-[10px] text-slate-400">{STATUS_LABEL[parent.status] || parent.status}</span>
                  </div>
                  <div className="mt-1 text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {parent.title || '(untitled)'}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">{parent.customerName || '—'}</div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                    <span>{children.length} subject item(s)</span>
                    <span className="font-mono font-bold text-slate-700 dark:text-slate-300">{pct}% complete</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                </button>
                {open && (
                  <div className="border-t border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                    {children.length === 0 ? (
                      <div className="p-3 text-[11px] text-slate-400">No subject items linked yet.</div>
                    ) : (
                      children.map(c => (
                        <div key={c.id} className="flex items-center justify-between gap-2 p-2.5 text-[11px]">
                          <div className="min-w-0">
                            <div className="font-mono text-[10px] text-slate-400">{c.jobNumber}</div>
                            <div className="truncate text-slate-700 dark:text-slate-200">{c.title || '(untitled)'}</div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-slate-500">
                              {c.copies} copies · {formatCurrency(Number(c.totalCost) || 0, currency)}
                            </div>
                            <div className="text-slate-400">{STATUS_LABEL[c.status] || c.status}</div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {loading ? (
        <div className="p-10 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading production jobs…
        </div>
      ) : columns.length === 0 ? (
        <div className="p-10 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-center text-xs text-slate-500">
          No production jobs yet.
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {columns.map(col => (
            <div key={col.status} className="flex-shrink-0 w-72">
              <div className="flex items-center justify-between px-1 pb-2">
                <h2 className="text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                  {STATUS_LABEL[col.status] || col.status}
                </h2>
                <span className="text-[10px] font-bold text-slate-400">{col.jobs.length}</span>
              </div>
              <div className="space-y-2">
                {col.jobs.map(job => (
                  <button
                    key={job.id}
                    onClick={() => openJob(job)}
                    className="w-full text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 hover:border-blue-400 dark:hover:border-blue-500 transition-colors shadow-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] font-bold text-slate-500">{job.jobNumber}</span>
                      <span className="text-[10px] text-slate-400">{String(job.jobDate || '').slice(0, 10)}</span>
                    </div>
                    <div className="mt-1 text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {job.title || '(untitled)'}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">{job.customerName || '—'}</div>
                    <div className="mt-2 flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">
                        {job.sheetsUsed || job.copies} shts · {job.pages} pp
                      </span>
                      <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                        {formatCurrency(Number(job.manualSellingPrice) || Number(job.totalCost) || 0, currency)}
                      </span>
                    </div>
                  </button>
                ))}
                {col.jobs.length === 0 && (
                  <div className="text-[11px] text-slate-400 px-1 py-2">No jobs</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Job detail / profitability drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 dark:bg-black/60 p-4" onClick={() => setSelected(null)}>
          <div
            className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-pop overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-200 dark:border-slate-800">
              <div>
                <div className="font-mono text-[11px] font-bold text-slate-500">{selected.jobNumber}</div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">{selected.title || '(untitled)'}</h3>
                <div className="text-xs text-slate-500">{selected.customerName || '—'}</div>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Status" value={STATUS_LABEL[selected.status] || selected.status} />
                <Field label="Job type" value={selected.jobType} />
                <Field label="Pages × copies" value={`${selected.pages} × ${selected.copies}`} />
                <Field label="Sheets / impressions" value={`${selected.sheetsUsed} / ${selected.impressionsUsed}`} />
                <Field label="Paper cost" value={formatCurrency(Number(selected.paperCost) || 0, currency)} />
                <Field label="Toner cost" value={formatCurrency(Number(selected.tonerCost) || 0, currency)} />
                <Field label="Total cost (WIP)" value={formatCurrency(Number(selected.totalCost) || 0, currency)} />
                <Field label="Selling price" value={formatCurrency(Number(selected.manualSellingPrice) || 0, currency)} />
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500 mb-2">
                  <TrendingUp className="w-3.5 h-3.5" /> Profitability
                </div>
                {profitLoading ? (
                  <div className="flex items-center gap-2 text-slate-500">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading profitability…
                  </div>
                ) : profitError ? (
                  <div className="text-rose-600">{profitError}</div>
                ) : profit ? (
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(profit)
                      .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
                      .map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between gap-2">
                          <span className="text-slate-500 truncate">{humanize(k)}</span>
                          <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                            {typeof v === 'number' ? formatCurrency(v, currency) : String(v)}
                          </span>
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="text-slate-400">No profitability data.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-bold text-slate-400">{label}</div>
      <div className="text-slate-800 dark:text-slate-200 font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, c => c.toUpperCase())
    .trim();
}