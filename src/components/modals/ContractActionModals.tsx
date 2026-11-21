import React, { useState, useEffect, useMemo } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { Account, PrintingContract, ContractAssessmentMilestone } from '../../types/accounting';
import { formatCurrency } from '../../utils/currency';
import { printingApi } from '../../services/printingApi';
import {
  X,
  DollarSign,
  Wallet,
  History,
  TrendingUp,
  Plus,
  Trash2,
  FileText,
  CheckCircle2,
  Clock,
  Landmark,
  Save,
} from 'lucide-react';

const ModalFrame: React.FC<{
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}> = ({ title, subtitle, icon, onClose, children, footer, width = 'max-w-lg' }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
    <div
      className={`flex max-h-[92vh] w-full ${width} flex-col overflow-hidden rounded-xl border border-slate-300 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900`}
    >
      <div className="flex items-center justify-between bg-[#0f3d63] px-5 py-3 text-white">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <div className="text-sm font-bold">{title}</div>
            {subtitle && <div className="text-[11px] text-white/70">{subtitle}</div>}
          </div>
        </div>
        <button onClick={onClose} className="p-1 text-white/80 hover:text-white" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-5 text-xs">{children}</div>
      {footer && (
        <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
          {footer}
        </div>
      )}
    </div>
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="space-y-1">
    <label className="font-semibold text-slate-700 dark:text-slate-300">{label}</label>
    {children}
  </div>
);

const inputCls =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-900 outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

const Btn: React.FC<{
  onClick: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'ghost' | 'danger' | 'success';
  disabled?: boolean;
  type?: 'button' | 'submit';
}> = ({ onClick, children, variant = 'primary', disabled, type = 'button' }) => {
  const cls: Record<string, string> = {
    primary: 'bg-blue-600 hover:bg-blue-500 text-white',
    success: 'bg-emerald-600 hover:bg-emerald-500 text-white',
    danger: 'bg-rose-600 hover:bg-rose-500 text-white',
    ghost:
      'border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-4 py-2 font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${cls[variant]}`}
    >
      {children}
    </button>
  );
};

/* ---------------------------------------------------------------- Amend */
export const AmendContractModal: React.FC<{ contract: PrintingContract; onClose: () => void }> = ({
  contract,
  onClose,
}) => {
  const { amendPrintingContract, triggerShortcutNotice } = useAccounting();
  const [title, setTitle] = useState(contract.title);
  const [academicYear, setAcademicYear] = useState(contract.academicYear);
  const [startDate, setStartDate] = useState(contract.startDate);
  const [endDate, setEndDate] = useState(contract.endDate);
  const [notes, setNotes] = useState(contract.notes || '');

  const submit = () => {
    amendPrintingContract(contract.id, {
      title: title.trim() || contract.title,
      academicYear: academicYear.trim() || contract.academicYear,
      startDate,
      endDate,
      notes,
    });
    triggerShortcutNotice(`Amended ${contract.contractNumber}`);
    onClose();
  };

  return (
    <ModalFrame
      title="Amend Contract"
      subtitle={`${contract.contractNumber} · ${contract.title}`}
      icon={<FileText className="h-4 w-4 text-amber-400" />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={submit}>
            <span className="inline-flex items-center gap-1.5">
              <Save className="h-3.5 w-3.5" /> Save Changes
            </span>
          </Btn>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Agreement Title">
          <input value={title} onChange={e => setTitle(e.target.value)} className={inputCls} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Academic Year">
            <input value={academicYear} onChange={e => setAcademicYear(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Start Date">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={inputCls} required />
          </Field>
        </div>
        <Field label="End Date">
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className={inputCls} required />
        </Field>
        <Field label="Notes / Conditions">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className={`${inputCls} resize-none`} />
        </Field>
      </div>
    </ModalFrame>
  );
};

/* -------------------------------------------------------- Add Assessment */
export const AddAssessmentModal: React.FC<{ contract: PrintingContract; onClose: () => void }> = ({
  contract,
  onClose,
}) => {
  const { addContractAssessment, triggerShortcutNotice, inventoryItems, getRawUsageUnitCost, companyProfile } =
    useAccounting();
  const currency = companyProfile.currency || 'K';
  const rawMaterials = inventoryItems.filter(i => i.type === 'raw_material');
  // First free slot in 1..5, not length + 1 (G-26: removing #3 must let #3 be reused).
  const usedNumbers = new Set((contract.assessments || []).map(a => a.assessmentNumber));
  const nextNumber = [1, 2, 3, 4, 5].find(n => !usedNumbers.has(n)) ?? 0;
  // Amount still assignable before the prepaid total is exhausted (G-26).
  const allocatedSoFar = (contract.assessments || []).reduce((s, a) => s + (Number(a.agreedAmount) || 0), 0);
  const remainingAllocatable = Math.max(0, (Number(contract.totalPrepaidAmount) || 0) - allocatedSoFar);
  const [label, setLabel] = useState(`Assessment ${nextNumber}`);
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().slice(0, 10));
  const [agreedAmount, setAgreedAmount] = useState('0');
  const [rawPaperItemId, setRawPaperItemId] = useState<string>(rawMaterials?.[0]?.id || '');
  const [rawTonerItemId, setRawTonerItemId] = useState<string>(rawMaterials?.[1]?.id || rawMaterials?.[0]?.id || '');
  const [estimatedSheets, setEstimatedSheets] = useState('0');
  const [estimatedImpressions, setEstimatedImpressions] = useState('0');

  const paperCost = (Number(estimatedSheets) || 0) * getRawUsageUnitCost(rawPaperItemId);
  const tonerCost = (Number(estimatedImpressions) || 0) * getRawUsageUnitCost(rawTonerItemId);
  const totalCost = paperCost + tonerCost;
  const profit = (Number(agreedAmount) || 0) - totalCost;

  const submit = () => {
    if (!label.trim()) return;
    if (nextNumber === 0) {
      triggerShortcutNotice('All five assessment slots are already in use', 'error');
      return;
    }
    const milestone: ContractAssessmentMilestone = {
      assessmentNumber: nextNumber,
      label: label.trim(),
      scheduledDate,
      agreedAmount: Number(agreedAmount) || 0,
      rawPaperItemId: rawPaperItemId || undefined,
      rawTonerItemId: rawTonerItemId || undefined,
      estimatedSheets: Number(estimatedSheets) || 0,
      estimatedImpressions: Number(estimatedImpressions) || 0,
      paperCost,
      tonerCost,
      totalCost,
      profit,
      status: 'pending',
    };
    addContractAssessment(contract.id, milestone);
    triggerShortcutNotice(`Added assessment #${nextNumber} to ${contract.contractNumber}`);
    onClose();
  };

  return (
    <ModalFrame
      title="Add Assessment"
      subtitle={`Assessment #${nextNumber} on ${contract.contractNumber}`}
      icon={<Plus className="h-4 w-4 text-emerald-400" />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="success" onClick={submit}>
            Add Assessment
          </Btn>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assessment Label">
            <input value={label} onChange={e => setLabel(e.target.value)} className={inputCls} required />
          </Field>
          <Field label="Scheduled Date">
            <input type="date" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} className={inputCls} required />
          </Field>
        </div>
        <Field label={`Agreed Amount (max ${remainingAllocatable.toFixed(2)} allocatable)`}>
          <input
            type="number"
            min="0"
            max={remainingAllocatable}
            step="0.01"
            value={agreedAmount}
            onChange={e => setAgreedAmount(e.target.value)}
            className={`${inputCls} text-right font-mono font-bold`}
          />
        </Field>
        {Number(agreedAmount) > remainingAllocatable && (
          <p className="text-xs text-rose-600">
            Amount exceeds the {remainingAllocatable.toFixed(2)} still allocatable against the prepaid total.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Paper Raw Material">
            <select value={rawPaperItemId} onChange={e => setRawPaperItemId(e.target.value)} className={inputCls}>
              {(rawMaterials || []).map((rm: any) => (
                <option key={rm.id} value={rm.id}>
                  {rm.sku} · {rm.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Estimated Sheets">
            <input type="number" min="0" value={estimatedSheets} onChange={e => setEstimatedSheets(e.target.value)} className={`${inputCls} text-right font-mono`} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Toner Raw Material">
            <select value={rawTonerItemId} onChange={e => setRawTonerItemId(e.target.value)} className={inputCls}>
              {(rawMaterials || []).map((rm: any) => (
                <option key={rm.id} value={rm.id}>
                  {rm.sku} · {rm.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Estimated Impressions">
            <input type="number" min="0" value={estimatedImpressions} onChange={e => setEstimatedImpressions(e.target.value)} className={`${inputCls} text-right font-mono`} />
          </Field>
        </div>
        <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono dark:border-slate-800 dark:bg-slate-850">
          <div className="flex justify-between">
            <span className="font-sans text-slate-500">Paper + Toner Cost:</span>
            <span className="font-bold text-amber-700 dark:text-amber-400">{formatCurrency(totalCost, currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="font-sans text-slate-500">Agreed Amount:</span>
            <span className="font-bold">{formatCurrency(Number(agreedAmount) || 0, currency)}</span>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-1 font-bold text-emerald-600 dark:border-slate-700 dark:text-emerald-400">
            <span className="font-sans">Calculated Profit:</span>
            <span>{formatCurrency(profit, currency)}</span>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
};

/* ----------------------------------------------------- Remove Assessment */
export const RemoveAssessmentModal: React.FC<{ contract: PrintingContract; onClose: () => void }> = ({
  contract,
  onClose,
}) => {
  const { removeContractAssessment, triggerShortcutNotice, companyProfile } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const pending = (contract.assessments || []).filter(a => a.status === 'pending');
  const [selected, setSelected] = useState<string>(pending[0]?.assessmentNumber?.toString() || '');

  const submit = () => {
    const num = Number(selected);
    if (!num) return;
    removeContractAssessment(contract.id, num);
    triggerShortcutNotice(`Removed assessment #${num} from ${contract.contractNumber}`);
    onClose();
  };

  return (
    <ModalFrame
      title="Remove Eligible Assessment"
      subtitle={`Only pending assessments on ${contract.contractNumber} can be removed`}
      icon={<Trash2 className="h-4 w-4 text-rose-400" />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="danger" onClick={submit} disabled={!selected}>
            Remove Assessment
          </Btn>
        </>
      }
    >
      {pending.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-center text-slate-500 dark:border-slate-800 dark:bg-slate-850">
          No eligible (pending) assessments to remove.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
            Removing an assessment reduces the agreed assessment count. Completed/deducted assessments cannot be removed.
          </div>
          <Field label="Select Assessment to Remove">
            <select value={selected} onChange={e => setSelected(e.target.value)} className={inputCls}>
              {pending.map(a => (
                <option key={a.assessmentNumber} value={a.assessmentNumber}>
                  #{a.assessmentNumber} — {a.label} ({formatCurrency(a.agreedAmount, currency)})
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
    </ModalFrame>
  );
};

/* --------------------------------------------------------- Info (read) */
type InfoMode = 'financials' | 'wallet' | 'history' | 'progress';

export const ContractInfoModal: React.FC<{
  mode: InfoMode;
  contract: PrintingContract;
  onClose: () => void;
}> = ({ mode, contract, onClose }) => {
  const { customers, bankTransactions, getAssessmentActualStats, companyProfile } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const school = customers.find(c => c.id === contract.schoolCustomerId);

  const [walletTx, setWalletTx] = useState<any[] | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);

  const localTx = useMemo(
    () => (bankTransactions || []).filter((t: any) => t.refNumber === contract.contractNumber),
    [bankTransactions, contract.contractNumber]
  );

  useEffect(() => {
    if (mode !== 'wallet') return;
    let cancelled = false;
    if (contract.backendId) {
      setWalletLoading(true);
      setWalletTx(null);
      printingApi
        .getContractWalletTransactions(contract.backendId)
        .then(txs => {
          if (!cancelled) setWalletTx(txs);
        })
        .catch(() => {
          if (!cancelled) setWalletTx(null);
        })
        .finally(() => {
          if (!cancelled) setWalletLoading(false);
        });
    } else {
      setWalletTx(null);
    }
    return () => {
      cancelled = true;
    };
  }, [mode, contract]);

  const deducted = contract.totalPrepaidAmount - contract.remainingBalance;
  const progressPct =
    contract.totalPrepaidAmount > 0
      ? Math.min(100, Math.round((deducted / contract.totalPrepaidAmount) * 100))
      : 0;

  const titleMap: Record<InfoMode, string> = {
    financials: 'Contract Financials',
    wallet: 'Wallet Transactions',
    history: 'Contract History',
    progress: 'Production Progress',
  };
  const iconMap: Record<InfoMode, React.ReactNode> = {
    financials: <DollarSign className="h-4 w-4 text-emerald-400" />,
    wallet: <Wallet className="h-4 w-4 text-blue-400" />,
    history: <History className="h-4 w-4 text-indigo-400" />,
    progress: <TrendingUp className="h-4 w-4 text-indigo-400" />,
  };

  const historyEvents = useMemo(() => {
    const ev: Array<{ date: string; label: string; detail?: string; tone: string }> = [];
    ev.push({
      date: contract.startDate,
      label: 'Contract created',
      detail: `Prepaid retainer ${formatCurrency(contract.totalPrepaidAmount, currency)} recorded · ${contract.totalAssessments} assessments`,
      tone: 'blue',
    });
    (contract.assessments || []).forEach(a => {
      ev.push({
        date: a.scheduledDate,
        label: `Assessment #${a.assessmentNumber}: ${a.label}`,
        detail: `Scheduled · agreed ${formatCurrency(a.agreedAmount, currency)}`,
        tone: 'slate',
      });
      if (a.status === 'completed') {
        ev.push({
          date: a.completedDate || a.scheduledDate,
          label: `Assessment #${a.assessmentNumber} completed & deducted`,
          detail: `${formatCurrency(a.agreedAmount, currency)} deducted${a.examBatchNote ? ` · ${a.examBatchNote}` : ''}`,
          tone: 'green',
        });
      }
    });
    if (contract.status === 'cancelled') {
      ev.push({
        date: contract.endDate,
        label: 'Contract cancelled',
        detail: contract.notes || 'Cancelled from contract register',
        tone: 'red',
      });
    }
    if (contract.status === 'exhausted') {
      ev.push({ date: contract.endDate, label: 'Contract exhausted', detail: 'All assessments completed & deducted', tone: 'amber' });
    }
    return ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [contract, currency]);

  const toneCls: Record<string, string> = {
    blue: 'bg-blue-500',
    slate: 'bg-slate-400',
    green: 'bg-emerald-500',
    red: 'bg-rose-500',
    amber: 'bg-amber-500',
  };

  return (
    <ModalFrame
      title={titleMap[mode]}
      subtitle={`${contract.contractNumber} · ${school?.companyName || ''}`}
      icon={iconMap[mode]}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <Btn variant="ghost" onClick={onClose}>
          Close
        </Btn>
      }
    >
      {mode === 'financials' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-850">
              <div className="text-[10px] font-bold uppercase text-slate-500">Prepaid</div>
              <div className="mt-1 font-mono text-base font-bold text-slate-900 dark:text-white">
                {formatCurrency(contract.totalPrepaidAmount, currency)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-850">
              <div className="text-[10px] font-bold uppercase text-slate-500">Deducted</div>
              <div className="mt-1 font-mono text-base font-bold text-blue-600 dark:text-blue-400">
                {formatCurrency(deducted, currency)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-850">
              <div className="text-[10px] font-bold uppercase text-slate-500">Remaining</div>
              <div className="mt-1 font-mono text-base font-bold text-emerald-600 dark:text-emerald-400">
                {formatCurrency(contract.remainingBalance, currency)}
              </div>
            </div>
          </div>
          <div>
            <div className="mb-1.5 flex justify-between text-[11px] text-slate-600 dark:text-slate-400">
              <span>
                Assessments completed: {contract.completedAssessments} of {contract.totalAssessments}
              </span>
              <span className="font-mono">{progressPct}% consumed</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
              <div className="h-full bg-emerald-600 transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase text-slate-500">
              <Landmark className="h-3.5 w-3.5" /> General Ledger Accounts
            </div>
            <div className="space-y-1 font-mono text-[11px]">
              <div className="flex justify-between">
                <span className="text-slate-500">#{contract.liabilityAccountId ?? 2250} Unearned Contract Revenue</span>
                <span>{formatCurrency(contract.remainingBalance, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Income (Printing Sales)</span>
                <span className="text-emerald-600 dark:text-emerald-400">{formatCurrency(deducted, currency)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === 'wallet' && (
        <div>
          {walletLoading ? (
            <div className="py-8 text-center text-slate-500">Loading transactions…</div>
          ) : (() => {
              const txs =
                walletTx !== null
                  ? walletTx
                  : localTx.map((t: any) => ({
                      id: String(t.id),
                      date: t.date,
                      type: t.type,
                      payee: t.payee,
                      refNumber: t.refNumber,
                      memo: t.memo,
                      amount: Number(t.amount) || 0,
                      accountName: undefined,
                    }));
              if (txs.length === 0) {
                return (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-slate-500 dark:border-slate-800 dark:bg-slate-850">
                    No wallet transactions recorded against {contract.contractNumber}.
                  </div>
                );
              }
              let running = contract.totalPrepaidAmount;
              return (
                <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-slate-50 text-[10px] font-bold uppercase text-slate-500 dark:bg-slate-800/60">
                      <tr>
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Details</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono dark:divide-slate-800">
                      {txs.map((t: any) => {
                        const isDeposit = String(t.type || '').toLowerCase().includes('deposit') || Number(t.amount) > 0;
                        running += isDeposit ? Number(t.amount || 0) : -Math.abs(Number(t.amount || 0));
                        return (
                          <tr key={t.id}>
                            <td className="whitespace-nowrap px-3 py-2">{t.date}</td>
                            <td className="px-3 py-2 font-sans">
                              <div className="font-semibold text-slate-800 dark:text-slate-200">{t.payee || t.memo || t.type}</div>
                              {t.memo && <div className="text-[10px] text-slate-500">{t.memo}</div>}
                            </td>
                            <td className={`px-3 py-2 text-right font-semibold ${isDeposit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                              {isDeposit ? '+' : '−'}
                              {formatCurrency(Number(t.amount || 0), currency)}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-600 dark:text-slate-300">{formatCurrency(running, currency)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
        </div>
      )}

      {mode === 'history' && (
        <div className="space-y-0">
          {historyEvents.map((e, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className={`mt-1 h-2.5 w-2.5 rounded-full ${toneCls[e.tone] || 'bg-slate-400'}`} />
                {i < historyEvents.length - 1 && <span className="w-px flex-1 bg-slate-200 dark:bg-slate-700" />}
              </div>
              <div className="pb-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-slate-500">{e.date}</span>
                  <span className="text-[12px] font-semibold text-slate-800 dark:text-slate-200">{e.label}</span>
                </div>
                {e.detail && <div className="text-[11px] text-slate-500">{e.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {mode === 'progress' && (
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
          <table className="w-full text-left text-[11px]">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase text-slate-500 dark:bg-slate-800/60">
              <tr>
                <th className="px-3 py-2">Assessment</th>
                <th className="px-3 py-2 text-center">Jobs</th>
                <th className="px-3 py-2 text-right">Sheets</th>
                <th className="px-3 py-2 text-right">Impressions</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono dark:divide-slate-800">
              {(contract.assessments || []).map(a => {
                const s = getAssessmentActualStats(contract.id, a.assessmentNumber);
                return (
                  <tr key={a.assessmentNumber}>
                    <td className="px-3 py-2 font-sans">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">
                        #{a.assessmentNumber} · {a.label}
                      </div>
                      <div className="text-[10px] text-slate-500">Scheduled {a.scheduledDate}</div>
                    </td>
                    <td className="px-3 py-2 text-center">{s.papersCount}</td>
                    <td className="px-3 py-2 text-right">{s.sheets.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{s.impressions.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(s.totalCost, currency)}</td>
                    <td className="px-3 py-2 text-center">
                      {a.status === 'completed' ? (
                        <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Deducted
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-400">
                          <Clock className="h-3.5 w-3.5" /> Pending
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ModalFrame>
  );
};

/* ------------------------------------------------------------------ *
 * Contract money modals: funding, activation, cancellation settlement,
 * top-up and renewal (G-03, G-04, G-18, G-21, G-22).
 * ------------------------------------------------------------------ */

const inputClsModal =
  'w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950';

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const FundContractModal: React.FC<{ contract: PrintingContract; onClose: () => void }> = ({
  contract,
  onClose,
}) => {
  const { triggerShortcutNotice } = useAccounting();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const required = Number(contract.totalPrepaidAmount) || 0;
  const funded = Number(contract.allocatedAmount ?? 0) || 0;
  const shortfall = Math.max(0, required - funded);

  const submit = async () => {
    if (!contract.backendId) {
      setError('This contract is not backed by the server and cannot be funded.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const funding = await printingApi.fundContract(contract.backendId, newIdempotencyKey('contract-fund'));
      triggerShortcutNotice(`Allocated ${funding?.amount ?? required} to ${contract.contractNumber}`);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Funding failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="Fund Retainer from Wallet"
      subtitle={`${contract.contractNumber} · required ${required.toFixed(2)} · allocated ${funded.toFixed(2)}`}
      icon={<Wallet className="h-4 w-4 text-emerald-400" />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="success" onClick={submit} disabled={busy || shortfall <= 0}>
            {busy ? 'Allocating…' : shortfall > 0 ? `Shortfall ${shortfall.toFixed(2)}` : 'Allocate Retainer'}
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="flex justify-between">
            <span className="text-slate-500">Prepaid total</span>
            <span className="font-mono font-semibold">{required.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Already allocated</span>
            <span className="font-mono font-semibold">{funded.toFixed(2)}</span>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-1 dark:border-slate-700">
            <span className="text-slate-500">Still to allocate</span>
            <span className="font-mono font-bold text-emerald-600">{shortfall.toFixed(2)}</span>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          This moves cash out of the customer wallet into the contract retainer liability. The contract stays a
          draft until it is accepted, approved and activated.
        </p>
        {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}
      </div>
    </ModalFrame>
  );
};

export const ActivationRequestModal: React.FC<{ contract: PrintingContract; onClose: () => void }> = ({
  contract,
  onClose,
}) => {
  const { triggerShortcutNotice } = useAccounting();
  const [reason, setReason] = useState('Contract documents signed and retainer funded');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!contract.backendId) {
      setError('This contract is not backed by the server.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await printingApi.requestActivation(contract.backendId, {
        reason,
        amount: contract.totalPrepaidAmount,
        idempotencyKey: newIdempotencyKey('contract-activation-req'),
      });
      triggerShortcutNotice(`Activation requested for ${contract.contractNumber}`);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not create the activation request');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="Request Activation Approval"
      subtitle={contract.contractNumber}
      icon={<CheckCircle2 className="h-4 w-4 text-emerald-400" />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={submit} disabled={busy || !reason.trim()}>
            {busy ? 'Submitting…' : 'Submit for Approval'}
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40">
          Activation requires, in order: customer acceptance, wallet funding of the full retainer, and an
          approved activation request. The checklist on the contract record shows what is still missing.
        </div>
        <Field label="Reason / justification">
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            className={inputClsModal}
          />
        </Field>
        {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}
      </div>
    </ModalFrame>
  );
};

export const CancelContractModal: React.FC<{ contract: PrintingContract; onClose: () => void }> = ({
  contract,
  onClose,
}) => {
  const { cancelPrintingContract, triggerShortcutNotice, accounts } = useAccounting();
  const remaining = Number(contract.remainingBalance) || 0;
  const [mode, setMode] = useState<'refund' | 'forfeit'>(remaining > 0 ? 'refund' : 'forfeit');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const banks = (accounts || []).filter((a: Account) => a.type === 'Bank');
  const [refundBankAccountId, setRefundBankAccountId] = useState<string>(
    banks[0]?.id ? String(banks[0].id) : ''
  );

  const submit = async () => {
    if (!reason.trim()) {
      setError('A cancellation reason is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await cancelPrintingContract(contract.id, {
        reason: reason.trim(),
        settlementMode: remaining > 0 ? mode : 'forfeit',
        refundBankAccountId:
          mode === 'refund' && remaining > 0 ? Number(refundBankAccountId) || null : null,
      });
      triggerShortcutNotice(`Cancelled ${contract.contractNumber}`);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Cancellation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title={`Cancel ${contract.contractNumber}`}
      subtitle={remaining > 0 ? `Remaining retainer ${remaining.toFixed(2)}` : 'No balance outstanding'}
      icon={<Trash2 className="h-4 w-4 text-rose-400" />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Keep Contract
          </Btn>
          <Btn variant="danger" onClick={submit} disabled={busy}>
            {busy ? 'Cancelling…' : 'Cancel Contract'}
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        {remaining > 0 ? (
          <>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={mode === 'refund'}
                  onChange={() => setMode('refund')}
                  className="h-4 w-4"
                />
                Refund {remaining.toFixed(2)} to the school
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={mode === 'forfeit'}
                  onChange={() => setMode('forfeit')}
                  className="h-4 w-4"
                />
                Forfeit {remaining.toFixed(2)} as earned income
              </label>
            </div>
            {mode === 'refund' && (
              <Field label="Refund bank account">
                <select
                  value={refundBankAccountId}
                  onChange={e => setRefundBankAccountId(e.target.value)}
                  className={inputClsModal}
                >
                  {banks.length === 0 && <option value="">No active bank accounts</option>}
                  {banks.map((b: any) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <p className="text-xs text-slate-500">
              {mode === 'refund'
                ? `Posts Dr Unearned Contract Revenue ${remaining.toFixed(2)} / Cr Bank ${remaining.toFixed(2)}.`
                : `Posts Dr Unearned Contract Revenue ${remaining.toFixed(2)} / Cr Other Income ${remaining.toFixed(2)}.`}
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-500">
            The retainer is fully consumed. Cancelling records the closure without a journal entry.
          </p>
        )}
        <Field label="Reason (required)">
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            className={inputClsModal}
          />
        </Field>
        {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}
      </div>
    </ModalFrame>
  );
};

export const TopUpContractModal: React.FC<{ contract: PrintingContract; onClose: () => void }> = ({
  contract,
  onClose,
}) => {
  const { triggerShortcutNotice, accounts } = useAccounting();
  const [amount, setAmount] = useState('');
  const [depositDate, setDepositDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const banks = (accounts || []).filter((a: Account) => a.type === 'Bank');
  const [bankAccountId, setBankAccountId] = useState<string>(banks[0]?.id ? String(banks[0].id) : '');

  const submit = async () => {
    const value = Number(amount);
    if (!(value > 0)) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (!contract.backendId) {
      setError('This contract is not backed by the server.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await printingApi.topUpContract(contract.backendId, {
        amount: value.toFixed(2),
        bankAccountId: Number(bankAccountId),
        depositDate,
        notes: notes.trim() || null,
        idempotencyKey: newIdempotencyKey('contract-topup'),
      });
      triggerShortcutNotice(`Topped up ${contract.contractNumber} by ${value.toFixed(2)}`);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Top-up failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="Top Up Retainer"
      subtitle={contract.contractNumber}
      icon={<DollarSign className="h-4 w-4 text-emerald-400" />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="success" onClick={submit} disabled={busy}>
            {busy ? 'Posting…' : 'Post Top-Up'}
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="flex justify-between">
            <span className="text-slate-500">Current prepaid total</span>
            <span className="font-mono font-semibold">
              {(Number(contract.totalPrepaidAmount) || 0).toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Current remaining</span>
            <span className="font-mono font-semibold">
              {(Number(contract.remainingBalance) || 0).toFixed(2)}
            </span>
          </div>
        </div>
        <Field label="Amount">
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className={`${inputClsModal} text-right font-mono font-bold`}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Deposit bank account">
            <select
              value={bankAccountId}
              onChange={e => setBankAccountId(e.target.value)}
              className={inputClsModal}
            >
              {banks.length === 0 && <option value="">No active bank accounts</option>}
              {banks.map((b: any) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Deposit date">
            <input
              type="date"
              value={depositDate}
              onChange={e => setDepositDate(e.target.value)}
              className={inputClsModal}
            />
          </Field>
        </div>
        <Field label="Notes">
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className={inputClsModal}
            placeholder="Optional reference"
          />
        </Field>
        <p className="text-xs text-slate-500">
          Posts Dr Bank / Cr Unearned Contract Revenue and adds the amount to both the prepaid total and the
          remaining balance.
        </p>
        {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}
      </div>
    </ModalFrame>
  );
};

export const RenewContractModal: React.FC<{ contract: PrintingContract; onClose: () => void }> = ({
  contract,
  onClose,
}) => {
  const { renewPrintingContract, triggerShortcutNotice } = useAccounting();
  const [depositAmount, setDepositAmount] = useState(String(Number(contract.totalPrepaidAmount) || 0));
  const [startDate, setStartDate] = useState(contract.startDate);
  const [endDate, setEndDate] = useState(contract.endDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const amount = Number(depositAmount);
    if (!(amount > 0)) {
      setError('A deposit amount greater than zero is required to renew.');
      return;
    }
    if (endDate < startDate) {
      setError('End date cannot be earlier than the start date.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renewPrintingContract(contract.id, { amount, startDate, endDate });
      triggerShortcutNotice(`Created renewal draft for ${contract.contractNumber}`);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Renewal failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="Renew Contract"
      subtitle={`Successor to ${contract.contractNumber}`}
      icon={<FileText className="h-4 w-4 text-blue-400" />}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create Renewal Draft'}
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="New deposit amount">
          <input
            type="number"
            min="0"
            step="0.01"
            value={depositAmount}
            onChange={e => setDepositAmount(e.target.value)}
            className={`${inputClsModal} text-right font-mono font-bold`}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="New start date">
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className={inputClsModal}
            />
          </Field>
          <Field label="New end date">
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className={inputClsModal}
            />
          </Field>
        </div>
        <p className="text-xs text-slate-500">
          A renewal is a new agreement: it needs a real new deposit and produces a new draft contract. The
          original contract is left unchanged.
        </p>
        {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}
      </div>
    </ModalFrame>
  );
};