import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { quoteApi, ApiQuote, ApiQuoteDetail } from '../../services/quoteApi';
import { commercialApi, ApiCustomer } from '../../services/commercialApi';
import { Loader2, Plus, FileText, X, AlertTriangle } from 'lucide-react';

type LineDraft = { description: string; quantity: string; rate: string };

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  accepted: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  declined: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  expired: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  converted: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
};

/**
 * Versioned quotes for commercial work: create a quote, revise it (each revision
 * is an immutable version), and move it through sent -> accepted -> converted.
 */
export const QuotesView: React.FC = () => {
  const { companyProfile, triggerShortcutNotice, openPrimePreview } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [apiCustomers, setApiCustomers] = useState<ApiCustomer[]>([]);
  const [quotes, setQuotes] = useState<ApiQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [title, setTitle] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ description: '', quantity: '1', rate: '0' }]);

  const [detail, setDetail] = useState<ApiQuoteDetail | null>(null);
  const [newVersionLines, setNewVersionLines] = useState<LineDraft[]>([]);
  const [showVersionForm, setShowVersionForm] = useState(false);
  const [search, setSearch] = useState('');
  const [taxRate, setTaxRate] = useState('0');
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setQuotes(await quoteApi.list());
    } catch (err: any) {
      setError(err?.message || 'Failed to load quotes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const list = await commercialApi.listCustomers();
        setApiCustomers(list);
        setCustomerId(prev => prev || (list[0] ? String(list[0].id) : ''));
      } catch {
        // Non-fatal: the create form simply has no customers to choose.
      }
    })();
  }, []);

  const openQuote = async (id: number) => {
    setError(null);
    try {
      setDetail(await quoteApi.get(id));
      setShowVersionForm(false);
      setNewVersionLines([{ description: '', quantity: '1', rate: '0' }]);
    } catch (err: any) {
      setError(err?.message || 'Failed to load quote');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await quoteApi.create({
        customerId: Number(customerId),
        title,
        validUntil: validUntil || null,
        notes: notes || null,
        taxRate: Number(taxRate) || 0,
        lines: lines.map(l => ({ description: l.description, quantity: l.quantity, rate: l.rate })),
      });
      triggerShortcutNotice(`Quote ${created.quote.quote_number} created`);
      setTitle('');
      setValidUntil('');
      setNotes('');
      setTaxRate('0');
      setLines([{ description: '', quantity: '1', rate: '0' }]);
      setShowForm(false);
      setDetail(created);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to create quote');
    } finally {
      setBusy(false);
    }
  };

  const handleAddVersion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await quoteApi.addVersion(
        detail.quote.id,
        { lines: newVersionLines.map(l => ({ description: l.description, quantity: l.quantity, rate: l.rate })) }
      );
      triggerShortcutNotice(`Quote revised to v${updated.quote.current_version}`);
      setDetail(updated);
      setShowVersionForm(false);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to add version');
    } finally {
      setBusy(false);
    }
  };

  const handleStatus = async (status: string) => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await quoteApi.setStatus(detail.quote.id, status);
      setDetail(updated);
      triggerShortcutNotice(`Quote marked ${status}`);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to change status');
    } finally {
      setBusy(false);
    }
  };

  const handleConvert = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const res = await quoteApi.convert(detail.quote.id);
      triggerShortcutNotice(`Quote ${detail.quote.quote_number} converted to invoice`);
      const refreshed = await quoteApi.get(detail.quote.id);
      setDetail(refreshed);
      await load();
      if (res?.invoice?.id) {
        openPrimePreview('INVOICE', { ...(res.invoice as any), documentType: 'INVOICE' }, `Invoice ${(res.invoice as any)?.invoiceNumber || ''}`);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to convert quote');
    } finally {
      setBusy(false);
    }
  };

  const handlePreviewPdf = () => {
    if (!detail) return;
    const q = detail.quote;
    const v = detail.versions.find(x => x.version_no === q.current_version) || detail.versions[detail.versions.length - 1];
    const items = (v?.lines || []).map(l => ({
      desc: l.description,
      qty: Number(l.quantity) || 1,
      price: Number(l.rate) || 0,
      total: Number(l.amount) || 0,
    }));
    const subtotal = items.reduce((s, i) => s + i.total, 0);
    const taxAmount = Number(v?.tax_amount) || 0;
    openPrimePreview(
      'QUOTATION',
      {
        number: q.quote_number,
        quotationNumber: q.quote_number,
        date: (q.created_at || '').slice(0, 10),
        validUntil: q.valid_until,
        clientName: q.customer_name || '',
        customerName: q.customer_name || '',
        address: companyProfile.address || '',
        phone: companyProfile.phone || '',
        title: q.title,
        notes: v?.notes || q.notes || '',
        currency,
        items,
        subtotal,
        taxAmount,
        totalAmount: Number(q.total) || subtotal + taxAmount,
        status: q.status,
      },
      `Quote ${q.quote_number}`
    );
  };

  const updateLine = (idx: number, patch: Partial<LineDraft>) =>
    setLines(prev => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const updateVersionLine = (idx: number, patch: Partial<LineDraft>) =>
    setNewVersionLines(prev => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const total = (ls: LineDraft[]) =>
    ls.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.rate) || 0), 0);

  const filteredQuotes = quotes.filter(q => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return (
      q.quote_number.toLowerCase().includes(term) ||
      (q.title || '').toLowerCase().includes(term) ||
      (q.customer_name || '').toLowerCase().includes(term) ||
      q.status.toLowerCase().includes(term)
    );
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Quotes</h1>
          <p className="text-xs text-slate-500 mt-0.5">Versioned commercial quotes (quote → PO → job).</p>
        </div>
        <button onClick={() => setShowForm(v => !v)} className="btn btn-primary text-xs">
          <Plus className="w-4 h-4" /> New Quote
        </button>
      </div>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search by number, title or customer…"
        className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-3 py-1.5 text-xs"
      />

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" /><span>{error}</span>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Customer</span>
              <select value={customerId} onChange={e => setCustomerId(e.target.value)} required className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5">
                {apiCustomers.map(c => <option key={c.id} value={c.id}>{c.companyName || c.name}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Title</span>
              <input value={title} onChange={e => setTitle(e.target.value)} required className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5" />
            </label>
            <label className="space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Valid until</span>
              <input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5" />
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Tax Rate (%)</span>
              <input type="number" min="0" max="100" step="0.01" value={taxRate} onChange={e => setTaxRate(e.target.value)} className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5" />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Notes</span>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes shown on the quote" className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5" />
            </label>
          </div>
          <LineEditor lines={lines} onChange={updateLine} onAdd={() => setLines(p => [...p, { description: '', quantity: '1', rate: '0' }])} onRemove={i => setLines(p => p.filter((_, j) => j !== i))} />
          <div className="flex items-center justify-between">
            <span className="font-mono font-bold text-slate-700 dark:text-slate-300">Total: {formatCurrency(total(lines), currency)}</span>
            <button type="submit" disabled={busy} className="btn btn-primary disabled:opacity-50">Create Quote</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="p-10 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading quotes…
        </div>
      ) : quotes.length === 0 ? (
        <div className="p-10 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-col items-center gap-2 text-xs text-slate-500">
          <FileText className="w-6 h-6" /><span>No quotes yet.</span>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase font-bold text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2.5">Number</th>
                <th className="px-4 py-2.5">Title</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5 text-center">Ver</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Total</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredQuotes.map(q => (
                <tr key={q.id} onClick={() => openQuote(q.id)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2 font-mono font-bold">{q.quote_number}</td>
                  <td className="px-4 py-2">{q.title}</td>
                  <td className="px-4 py-2 text-slate-500">{q.customer_name || '—'}</td>
                  <td className="px-4 py-2 text-center">v{q.current_version}</td>
                  <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_TONE[q.status] || ''}`}>{q.status}</span></td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(Number(q.total), currency)}</td>
                  <td className="px-4 py-2 text-right text-slate-400">→</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail drawer */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 dark:bg-black/60 p-4" onClick={() => setDetail(null)}>
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-pop overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-200 dark:border-slate-800">
              <div>
                <div className="font-mono text-[11px] font-bold text-slate-500">{detail.quote.quote_number}</div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">{detail.quote.title}</h3>
              </div>
              <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-5 space-y-4 text-xs max-h-[60vh] overflow-y-auto">
              {/* Version history */}
              <div className="space-y-3">
                <h4 className="text-[11px] font-bold uppercase text-slate-500">Version History</h4>
                {detail.versions.map(v => (
                  <div key={v.id} className={`rounded-xl border p-3 ${v.version_no === detail.quote.current_version ? 'border-blue-400 dark:border-blue-500' : 'border-slate-200 dark:border-slate-800'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-bold">v{v.version_no}</span>
                      <span className="font-mono font-bold">{formatCurrency(Number(v.total), currency)}</span>
                    </div>
                    <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
                      {(v.lines || []).map((l, i) => (
                        <div key={i} className="flex justify-between py-0.5">
                          <span className="text-slate-500">{l.description} × {l.quantity}</span>
                          <span className="font-mono">{formatCurrency(Number(l.amount), currency)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Add version */}
              {['draft', 'sent', 'accepted'].includes(detail.quote.status) && !showVersionForm && (
                <button onClick={() => setShowVersionForm(true)} className="btn btn-secondary w-full">
                  <Plus className="w-4 h-4" /> Add Revision
                </button>
              )}
              {showVersionForm && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3">
                  <LineEditor
                    lines={newVersionLines}
                    onChange={updateVersionLine}
                    onAdd={() => setNewVersionLines(p => [...p, { description: '', quantity: '1', rate: '0' }])}
                    onRemove={i => setNewVersionLines(p => p.filter((_, j) => j !== i))}
                  />
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold">Total: {formatCurrency(total(newVersionLines), currency)}</span>
                    <button onClick={handleAddVersion} disabled={busy} className="btn btn-primary disabled:opacity-50">Save Revision</button>
                  </div>
                </div>
              )}

              {/* Status actions */}
              <div className="flex flex-wrap gap-2 border-t border-slate-200 dark:border-slate-800 pt-3">
                <button onClick={handlePreviewPdf} disabled={busy} className="btn btn-secondary">
                  <FileText className="w-4 h-4" /> Preview / PDF
                </button>
                {detail.quote.status === 'draft' && <button onClick={() => handleStatus('sent')} disabled={busy} className="btn btn-secondary">Mark Sent</button>}
                {detail.quote.status === 'sent' && <><button onClick={() => handleStatus('accepted')} disabled={busy} className="btn btn-primary">Accept</button><button onClick={() => handleStatus('declined')} disabled={busy} className="btn btn-danger">Decline</button></>}
                {detail.quote.status === 'accepted' && <button onClick={handleConvert} disabled={busy} className="btn btn-primary">Convert to Invoice</button>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function LineEditor({ lines, onChange, onAdd, onRemove }: {
  lines: LineDraft[];
  onChange: (idx: number, patch: Partial<LineDraft>) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-center">
          <input value={l.description} onChange={e => onChange(i, { description: e.target.value })} placeholder="Description" className="col-span-6 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2 py-1" />
          <input type="number" min="0" step="0.0001" value={l.quantity} onChange={e => onChange(i, { quantity: e.target.value })} className="col-span-2 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2 py-1" />
          <input type="number" min="0" step="0.0001" value={l.rate} onChange={e => onChange(i, { rate: e.target.value })} className="col-span-2 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2 py-1" />
          <button type="button" onClick={() => onRemove(i)} className="col-span-2 text-rose-500 text-[11px]">Remove</button>
        </div>
      ))}
      <button type="button" onClick={onAdd} className="text-[11px] font-semibold text-blue-600">+ Add line</button>
    </div>
  );
}