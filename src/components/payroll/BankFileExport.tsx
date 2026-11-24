import React, { useCallback, useEffect, useState } from 'react';
import { Download, FileText, RefreshCw, Printer } from 'lucide-react';
import { payrollConfigApi, Payslip } from '../../services/v2Api';
import { payrollApi } from '../../services/payrollApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { Panel } from '../common/ui';

/**
 * WS-4 R5 / R6 — payslips and the bank payment file.
 *
 * The bank file is generated server-side in the configured format (CSV or a
 * fixed-width TXT) from the posted pay run, so the download always matches what
 * was actually paid.
 */
export const BankFileExport: React.FC = () => {
  const { payrollRuns, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [runId, setRunId] = useState<string>('');
  const [format, setFormat] = useState<'csv' | 'txt'>('csv');
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [downloading, setDownloading] = useState(false);

  const loadPayslips = useCallback(async (id: number) => {
    try {
      const res = await payrollConfigApi.payslips(id);
      setPayslips(res.payslips || []);
    } catch (err: any) {
      setPayslips([]);
      triggerShortcutNotice(err?.message || 'Failed to load payslips', 'error');
    }
  }, [triggerShortcutNotice]);

  useEffect(() => {
    if (payrollRuns.length > 0 && !runId) {
      const latest = payrollRuns[0];
      setRunId(String((latest as any).runId ?? (latest as any).id ?? ''));
    }
  }, [payrollRuns, runId]);

  useEffect(() => {
    if (runId) loadPayslips(Number(runId));
  }, [runId, loadPayslips]);

  const download = async () => {
    if (!runId) return;
    setDownloading(true);
    try {
      await payrollConfigApi.downloadBankFile(Number(runId), format);
      triggerShortcutNotice('Bank file downloaded');
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Bank file generation failed', 'error');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        title="Bank payment file"
        description="Generated from the posted pay run. Use the format your bank specifies."
        icon={<Download className="h-4 w-4 text-emerald-600" />}
        actions={
          <button type="button" onClick={() => runId && loadPayslips(Number(runId))} className="btn btn-secondary py-1.5 text-xs">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-xs sm:col-span-1">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Pay run</span>
            <select
              value={runId}
              onChange={e => setRunId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="">Select a pay run…</option>
              {payrollRuns.map((r: any) => (
                <option key={r.runId ?? r.id} value={r.runId ?? r.id}>
                  {r.runNumber} · {r.payDate}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Format</span>
            <select
              value={format}
              onChange={e => setFormat(e.target.value as 'csv' | 'txt')}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="csv">CSV</option>
              <option value="txt">Fixed-width TXT</option>
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={download}
              disabled={!runId || downloading}
              className="btn btn-primary w-full"
            >
              <Download className="h-3.5 w-3.5" />
              {downloading ? 'Generating…' : 'Download file'}
            </button>
          </div>
        </div>

        {payrollRuns.length === 0 && (
          <p className="mt-3 text-xs text-slate-500">
            Run payroll first — the bank file is produced from the posted run, not from a preview.
          </p>
        )}
      </Panel>

      <Panel
        title="Payslips"
        description="Totals are gross − deductions = net, and each slip links to the posted journal."
        icon={<FileText className="h-4 w-4 text-brand-600" />}
      >
        {payslips.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">
            {runId ? 'No payslips for this run.' : 'Select a pay run to see payslips.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="text-right">Gross</th>
                  <th className="text-right">PAYE</th>
                  <th className="text-right">Pension</th>
                  <th className="text-right">Other</th>
                  <th className="text-right">Net</th>
                  <th className="text-right">Print</th>
                </tr>
              </thead>
              <tbody>
                {payslips.map(p => (
                  <tr key={`${p.employeeName}-${p.runNumber}`}>
                    <td className="font-medium">{p.employeeName}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(p.grossPay, currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-rose-600">
                      {formatCurrency(p.paye, currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-rose-600">
                      {formatCurrency(p.pensionEmployee, currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-rose-600">
                      {formatCurrency(p.otherDeductions, currency)}
                    </td>
                    <td className="text-right font-mono font-bold tabular-nums text-emerald-600">
                      {formatCurrency(p.netPay, currency)}
                    </td>
                    <td className="text-right">
                      <a
                        href={payrollConfigApi.payslipPrintUrl(Number(runId), p.employeeId)}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-secondary px-2 py-1 text-[11px]"
                      >
                        <Printer className="h-3 w-3" />
                        Print
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
};