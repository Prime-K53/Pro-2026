import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, X, Loader2 } from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import { useAccounting } from '../../context/AccountingContext';

interface Props {
  bill: any;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const ThreeWayMatchInspectionModal: React.FC<Props> = ({ bill, isOpen, onClose, onSuccess }) => {
  const { triggerShortcutNotice } = useAccounting();
  const [loading, setLoading] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [overrideReason, setOverrideReason] = useState('');

  useEffect(() => {
    if (!isOpen || !bill?.id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    commercialApi.evaluateBillThreeWayMatch(bill.id)
      .then((res) => { if (!cancelled) setResult(res); })
      .catch((err: any) => { if (!cancelled) setError(err?.message || 'Failed to evaluate match'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, bill?.id]);

  if (!isOpen) return null;

  const discrepancies = Array.isArray(result?.discrepancies) ? result.discrepancies : [];
  const matchStatus = result?.matchStatus || bill?.matchStatus || 'unmatched';

  const handleOverride = async () => {
    const reason = overrideReason.trim();
    if (!reason) { setError('Override reason is required'); return; }
    setEvaluating(true);
    setError(null);
    try {
      await commercialApi.approveBillMatchOverride(bill.id, reason);
      triggerShortcutNotice(`Match override approved for ${bill.billNumber}`);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to approve override');
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-3xl w-full p-6 space-y-4 shadow-xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              {matchStatus === 'matched' ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <AlertTriangle className="w-5 h-5 text-amber-600" />}
              3-Way Match Inspection
            </h2>
            <p className="text-xs text-slate-500">Bill {bill.billNumber} · Status: <span className="font-semibold">{matchStatus}</span></p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
        </div>

        {error && <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 text-xs">{error}</div>}
        {loading ? (
          <div className="py-10 text-center text-slate-500 text-sm flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Evaluating match...</div>
        ) : (
          <>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 dark:bg-slate-850 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Line</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-right">Expected</th>
                    <th className="px-3 py-2 text-right">Actual</th>
                    <th className="px-3 py-2 text-right">Delta</th>
                    <th className="px-3 py-2 text-left">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {discrepancies.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-emerald-600 font-medium">No variances detected. PO/GRN/Bill are aligned.</td></tr>
                  ) : discrepancies.map((d: any, i: number) => (
                    <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2">{d.lineIndex || d.line_index || '-'}</td>
                      <td className="px-3 py-2 font-medium text-amber-700 dark:text-amber-400">{d.varianceType || d.variance_type}</td>
                      <td className="px-3 py-2 text-right font-mono">{d.expectedValue ?? d.expected_value ?? '-'}</td>
                      <td className="px-3 py-2 text-right font-mono">{d.actualValue ?? d.actual_value ?? '-'}</td>
                      <td className="px-3 py-2 text-right font-mono">{d.deltaAmount ?? d.delta_amount ?? '-'}</td>
                      <td className="px-3 py-2 text-slate-500">{d.note || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {Array.isArray(result?.matrix) && result.matrix.length > 0 && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 dark:bg-slate-850 text-xs font-semibold text-slate-600 dark:text-slate-300">Line match matrix {result?.tolerances ? `(price tol ${result.tolerances.price}, qty tol ${result.tolerances.quantity})` : ''}</div>
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-850 text-slate-500">
                    <tr><th className="px-3 py-2 text-left">Line</th><th className="px-3 py-2 text-left">Description</th><th className="px-3 py-2 text-right">Bill Qty</th><th className="px-3 py-2 text-right">PO Qty</th><th className="px-3 py-2 text-right">GRN Qty</th><th className="px-3 py-2 text-right">Bill Unit</th><th className="px-3 py-2 text-right">PO Unit</th><th className="px-3 py-2 text-center">Var</th></tr>
                  </thead>
                  <tbody>
                    {result.matrix.map((m: any) => (
                      <tr key={m.lineIndex} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-2">{m.lineIndex}</td>
                        <td className="px-3 py-2">{m.description || '-'}</td>
                        <td className="px-3 py-2 text-right font-mono">{m.billQty}</td>
                        <td className="px-3 py-2 text-right font-mono">{m.poQty ?? '-'}</td>
                        <td className="px-3 py-2 text-right font-mono">{m.grnQty ?? '-'}</td>
                        <td className="px-3 py-2 text-right font-mono">{m.billUnitCost}</td>
                        <td className="px-3 py-2 text-right font-mono">{m.poUnitCost ?? '-'}</td>
                        <td className={`px-3 py-2 text-center font-semibold ${m.hasVariance ? 'text-amber-600' : 'text-emerald-600'}`}>{m.hasVariance ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {discrepancies.length > 0 && matchStatus !== 'approved_override' && (
              <div className="space-y-2 border-t border-slate-100 dark:border-slate-800 pt-3">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Manager override reason</label>
                <textarea value={overrideReason} onChange={e => setOverrideReason(e.target.value)} rows={2} className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-xs" placeholder="Explain why variance is acceptable..." />
                <div className="flex justify-end">
                  <button onClick={handleOverride} disabled={evaluating} className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold disabled:opacity-50">
                    {evaluating ? 'Approving...' : 'Approve Variance Override'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};