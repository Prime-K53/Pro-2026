import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, PackageCheck, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import { ModalBody, ModalHeader, ModalShell } from '../common/ui';

export interface TransferReceiveModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export const TransferReceiveModal: React.FC<TransferReceiveModalProps> = ({ open, onClose, onSuccess }) => {
  const [transfers, setTransfers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [receivingId, setReceivingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [receiveQty, setReceiveQty] = useState<Record<number, string>>({});

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [inTransit, partial] = await Promise.all([
        commercialApi.listStockTransfers('in_transit'),
        commercialApi.listStockTransfers('partially_received').catch(() => []),
      ]);
      const merged = [...(inTransit || []), ...(partial || [])].sort((a, b) => Number(b.id) - Number(a.id));
      setTransfers(merged);
    } catch (e: any) { setError(e?.message || 'Failed to load transfers.'); }
    finally { setLoading(false); }
  };

  const loadDetail = async (id: number) => {
    setDetailLoading(true); setError(null);
    try {
      const t = await commercialApi.getStockTransfer(id);
      setDetail(t);
      const q: Record<number, string> = {};
      for (const l of t.lines || []) q[Number(l.id)] = String(l.remaining_qty ?? Math.max(0, Number(l.quantity) - Number(l.received_qty)));
      setReceiveQty(q);
    } catch (e: any) { setError(e?.message || 'Failed to load transfer details.'); }
    finally { setDetailLoading(false); }
  };

  useEffect(() => { if (open) { void load(); setExpandedId(null); setDetail(null); } }, [open]);
  if (!open) return null;

  const toggle = async (id: number) => {
    if (expandedId === id) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(id);
    await loadDetail(id);
  };

  const receive = async (id: number, partialReceive: boolean) => {
    setReceivingId(id); setError(null);
    try {
      const payload = partialReceive && detail?.lines ? {
        lines: detail.lines
          .map((l: any) => ({ lineId: Number(l.id), receivedQty: receiveQty[Number(l.id)] ?? l.remaining_qty }))
          .filter((l: any) => Number(l.receivedQty) > 0),
      } : {};
      const result = await commercialApi.receiveStockTransfer(id, payload);
      onSuccess(`Received transfer ${result.transferNumber} ${result.partial ? '(partial)' : 'fully'} into ${result.toLocation}.`);
      await load();
      if (result.partial) await loadDetail(id); else { setExpandedId(null); setDetail(null); }
    } catch (e: any) { setError(e?.message || 'Failed to receive transfer.'); }
    finally { setReceivingId(null); }
  };

  return (
    <ModalShell open={open} onClose={onClose} titleId="transfer-receive-modal-title" size="4xl">
      <ModalHeader
          titleId="transfer-receive-modal-title" title="Receive Transfers" subtitle="Receive in-transit or partially received transfers (full or partial by line)" tone="brand" icon={<PackageCheck className="h-4 w-4" />} onClose={onClose} />
      <ModalBody columns={1}>
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">Showing <span className="font-semibold">in_transit</span> and <span className="font-semibold">partially_received</span> transfers.</p>
          <button type="button" onClick={() => void load()} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px]"><RefreshCw className="h-3.5 w-3.5" />Refresh</button>
        </div>
        {error && <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{error}</span></div>}
        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr><th className="px-3 py-2 text-left">Transfer</th><th className="px-3 py-2 text-left">Route</th><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-right">Received</th><th className="px-3 py-2 text-right">Action</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {loading ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>
              ) : transfers.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No receivable transfers.</td></tr>
              ) : transfers.map(t => (
                <>
                  <tr key={t.id}>
                    <td className="px-3 py-2 font-semibold text-slate-700 dark:text-slate-200">
                      <button type="button" className="inline-flex items-center gap-1 hover:text-brand" onClick={() => void toggle(Number(t.id))}>
                        {expandedId === Number(t.id) ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        {t.transfer_number}
                      </button>
                      <div className="text-[10px] font-normal text-slate-400">{t.status}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{t.from_location} → {t.to_location}</td>
                    <td className="px-3 py-2 font-mono text-slate-500">{t.transfer_date}</td>
                    <td className="px-3 py-2 text-right font-mono">{Number(t.received_qty || 0)}/{Number(t.total_qty || 0)}</td>
                    <td className="px-3 py-2 text-right">
                      <button type="button" disabled={receivingId === Number(t.id)} onClick={() => void receive(Number(t.id), false)} className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] disabled:opacity-50">
                        <CheckCircle2 className="h-3.5 w-3.5" />{receivingId === Number(t.id) ? 'Receiving…' : 'Receive All'}
                      </button>
                    </td>
                  </tr>
                  {expandedId === Number(t.id) && (
                    <tr key={`${t.id}-detail`}>
                      <td colSpan={5} className="bg-slate-50/70 px-3 py-3 dark:bg-slate-800/30">
                        {detailLoading || !detail ? <div className="text-slate-400">Loading lines…</div> : (
                          <div className="space-y-2">
                            <table className="w-full text-[11px]">
                              <thead><tr className="text-slate-500"><th className="py-1 text-left">Item</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Received</th><th className="py-1 text-right">Remaining</th><th className="py-1 text-right">Receive now</th></tr></thead>
                              <tbody>
                                {(detail.lines || []).map((l: any) => {
                                  const remaining = Math.max(0, Number(l.quantity) - Number(l.received_qty));
                                  return (
                                    <tr key={l.id} className="border-t border-slate-200/60 dark:border-slate-700/60">
                                      <td className="py-1">{l.sku} — {l.item_name}</td>
                                      <td className="py-1 text-right font-mono">{l.quantity}</td>
                                      <td className="py-1 text-right font-mono">{l.received_qty}</td>
                                      <td className="py-1 text-right font-mono">{remaining}</td>
                                      <td className="py-1 text-right">
                                        <input type="number" min="0" max={remaining} step="0.0001" value={receiveQty[Number(l.id)] ?? String(remaining)} onChange={e => setReceiveQty(p => ({ ...p, [Number(l.id)]: e.target.value }))} className="app-input w-28 text-right font-mono text-[11px]" disabled={remaining <= 0} />
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            <div className="flex justify-end gap-2">
                              <button type="button" disabled={receivingId === Number(t.id)} onClick={() => void receive(Number(t.id), true)} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] disabled:opacity-50">
                                <CheckCircle2 className="h-3.5 w-3.5" />Receive Selected Qty
                              </button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </ModalBody>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200/70 bg-slate-50/60 px-5 py-3.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
        <button type="button" onClick={onClose} className="btn btn-secondary">Close</button>
      </div>
    </ModalShell>
  );
};

export default TransferReceiveModal;
