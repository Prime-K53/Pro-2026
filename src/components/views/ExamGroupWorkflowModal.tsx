import React, { useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { documentsApi } from '../../services/documentsApi';
import { mapApiPreviewToModel } from '../../types/documents';
import { Loader2, CheckCircle2, AlertCircle, FileText, Printer, X, Truck, ShieldCheck } from 'lucide-react';

const STEP_LABEL: Record<string, string> = {
  production: 'Completing production…',
  qc: 'Approving quality control…',
  delivery: 'Recording physical delivery…',
  invoice: 'Posting consolidated invoice…',
  completed: 'Finalising…',
};

/**
 * One-click examination batch workflow: consolidated preview -> one final
 * (attested) confirmation -> durable server checkpoints -> completed summary
 * with independent production-job and invoice references.
 */
export const ExamGroupWorkflowModal: React.FC<{ groupId: number; onClose: () => void }> = ({
  groupId,
  onClose,
}) => {
  const { getExamGroupSummary, runExamGroupWorkflow, companyProfile, openDocumentPreview } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState('');
  const [dispatchDate, setDispatchDate] = useState(new Date().toISOString().slice(0, 10));
  const [attested, setAttested] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await getExamGroupSummary(groupId));
    } catch (e: any) {
      setError(e?.message || 'Failed to load the examination batch summary');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  const openInvoice = async () => {
    if (!summary?.invoiceId) return;
    try {
      const preview = await documentsApi.getDocumentPreview('invoice', Number(summary.invoiceId));
      openDocumentPreview(mapApiPreviewToModel(preview, currency));
    } catch (e: any) {
      setError(e?.message || 'Could not open the generated invoice');
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await runExamGroupWorkflow(groupId, {
        dispatchDate,
        recipientName: recipient || null,
        onProgress: (st) => setStep(st),
      });
      setSummary(s);
    } catch (e: any) {
      setError(e?.message || 'The batch workflow failed. Completed steps are saved; retry to resume.');
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 dark:bg-black/60 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-pop overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-200 dark:border-slate-800">
          <div>
            <div className="font-mono text-[11px] font-bold text-slate-500">
              Group {summary?.groupReference ? summary.groupReference.slice(0, 8) : groupId}
            </div>
            <h3 className="text-base font-bold text-slate-900 dark:text-white">
              {summary?.assessmentName || 'Examination Batch'}
            </h3>
            <div className="text-xs text-slate-500">
              {summary
                ? `${summary.classCount} class(es) · ${summary.subjectCount} subject paper(s) · ${summary.learnerCount} learners`
                : 'Loading batch…'}
            </div>
          </div>
          <button
            onClick={() => !busy && onClose()}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs overflow-y-auto">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-bold">Action needed</div>
                <div className="mt-0.5">{error}</div>
                <button onClick={load} className="mt-2 font-bold underline">
                  Reload summary
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="p-8 flex items-center justify-center gap-2 text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading batch summary…
            </div>
          ) : summary ? (
            <>
              {/* Reference cards */}
              <div className="grid grid-cols-2 gap-3">
                <RefCard
                  icon={<Printer className="w-3.5 h-3.5" />}
                  label="Production job"
                  value={summary.parentJobNumber || 'Not generated yet'}
                />
                <RefCard
                  icon={<FileText className="w-3.5 h-3.5" />}
                  label="Invoice"
                  value={summary.invoiceNumber || 'Not posted yet'}
                />
              </div>

              {/* Status chips */}
              <div className="flex flex-wrap gap-2">
                <Chip ok={summary.productionCompleted} label="Production complete" />
                <Chip ok={summary.qcApproved} label="QC approved" />
                <Chip ok={summary.delivered} label="Delivered" />
                <Chip ok={summary.invoiced} label="Invoiced" />
              </div>

              {/* Class / subject detail */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase font-bold text-slate-500">
                      <th className="text-left px-3 py-2">Class / Subject</th>
                      <th className="text-right px-3 py-2">Qty</th>
                      <th className="text-right px-3 py-2">Cost</th>
                      <th className="text-left px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.classes.map((cls: any) => (
                      <React.Fragment key={cls.batchId}>
                        <tr className="bg-slate-100/70 dark:bg-slate-800/70">
                          <td className="px-3 py-1.5 font-bold text-slate-700 dark:text-slate-200" colSpan={2}>
                            {cls.className} · {cls.learnersCount} learners
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">{formatCurrency(cls.learnersCount * cls.pricePerLearner, currency)}</td>
                          <td className="px-3 py-1.5" />
                        </tr>
                        {cls.subjects.map((s: any) => (
                          <tr key={s.paperId} className="border-t border-slate-100 dark:border-slate-800">
                            <td className="px-3 py-1.5 text-slate-600 dark:text-slate-300">{s.subjectName}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{s.copies}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{formatCurrency(s.materialCost, currency)}</td>
                            <td className="px-3 py-1.5 text-slate-500">{s.status}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>Total production cost (WIP)</span>
                <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                  {formatCurrency(summary.totalCost, currency)}
                </span>
              </div>

              {/* Attestation + action, or completed summary */}
              {!summary.invoiced ? (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500">
                    <Truck className="w-3.5 h-3.5" /> Physical delivery attestation
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[10px] uppercase font-bold text-slate-400">Received by</span>
                      <input
                        value={recipient}
                        onChange={e => setRecipient(e.target.value)}
                        placeholder="Recipient name"
                        className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] uppercase font-bold text-slate-400">Dispatch date</span>
                      <input
                        type="date"
                        value={dispatchDate}
                        onChange={e => setDispatchDate(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
                      />
                    </label>
                  </div>
                  <label className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={attested}
                      onChange={e => setAttested(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      I confirm the entire batch has been physically produced, quality-checked and delivered.
                      This records real delivery and posts one consolidated school invoice.
                    </span>
                  </label>
                  <button
                    onClick={run}
                    disabled={busy || !attested}
                    className="w-full flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold shadow-xs transition-all active:scale-95"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    <span>{busy && step ? STEP_LABEL[step] || 'Processing…' : 'Generate Production & Invoice'}</span>
                  </button>
                </div>
              ) : (
                <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase text-emerald-700 dark:text-emerald-300">
                    <ShieldCheck className="w-3.5 h-3.5" /> Batch completed
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <SummaryField label="Production job" value={summary.parentJobNumber || '—'} />
                    <SummaryField label="Invoice" value={summary.invoiceNumber || '—'} />
                    <SummaryField label="Production status" value={summary.productionCompleted ? 'Completed' : 'In progress'} />
                    <SummaryField label="Invoice status" value={summary.invoiced ? 'Posted' : 'Pending'} />
                  </div>
                  <button
                    onClick={openInvoice}
                    disabled={!summary.invoiceId}
                    className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold"
                  >
                    <FileText className="w-3.5 h-3.5" /> Open Invoice {summary.invoiceNumber || ''}
                  </button>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const RefCard: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
    <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-slate-400">
      {icon} {label}
    </div>
    <div className="mt-1 font-mono font-bold text-slate-800 dark:text-slate-200 truncate">{value}</div>
  </div>
);

const Chip: React.FC<{ ok: boolean; label: string }> = ({ ok, label }) => (
  <span
    className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
      ok
        ? 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
        : 'bg-slate-50 text-slate-500 border-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
    }`}
  >
    {label}
  </span>
);

const SummaryField: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] uppercase font-bold text-slate-400">{label}</div>
    <div className="font-mono font-semibold text-slate-800 dark:text-slate-200 truncate">{value}</div>
  </div>
);