import React, { useRef, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { ocrApi, OcrExtraction, OcrLine } from '../../services/ocrApi';
import { commercialApi, ApiCustomer } from '../../services/commercialApi';
import { quoteApi } from '../../services/quoteApi';
import { Loader2, Sparkles, Upload, X, AlertTriangle, Plus, Trash2, FileText, CheckCircle2, Camera } from 'lucide-react';

type Kind = 'quote' | 'invoice' | 'receipt' | 'supplier_bill';

const KIND_LABELS: Record<Kind, string> = {
  quote: 'Quote',
  invoice: 'Invoice',
  receipt: 'Receipt',
  supplier_bill: 'Supplier Bill',
};

interface CatalogItem {
  id: number;
  sku?: string | null;
  name: string;
  sales_price?: string | number | null;
}

const normalize = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Match an OCR line to a catalog item by normalized name/SKU (exact, then includes). */
function matchCatalogItem(description: string, catalog: CatalogItem[]): CatalogItem | null {
  const d = normalize(description);
  if (!d) return null;
  const exact = catalog.find(c => normalize(c.name) === d || (c.sku && normalize(c.sku) === d));
  if (exact) return exact;
  return catalog.find(c => normalize(c.name).includes(d) || d.includes(normalize(c.name))) || null;
}

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });

/**
 * AI Document OCR generator: upload a quote/invoice image, the backend vision
 * model extracts structured data, the user reviews/edits, then a real quote or
 * invoice is created (idempotent) and previewed via PrimeDocument.
 */
export const AiDocumentOcrModal: React.FC = () => {
  const { isOcrScannerOpen, setIsOcrScannerOpen, companyProfile, triggerShortcutNotice, openPrimePreview } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [kind, setKind] = useState<Kind>('invoice');
  const [imageBase64, setImageBase64] = useState('');
  const [fileName, setFileName] = useState('');
  const [scanning, setScanning] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OcrExtraction | null>(null);
  const [model, setModel] = useState('');
  const [duplicate, setDuplicate] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [businessDuplicate, setBusinessDuplicate] = useState(false);

  // Editable review state
  const [customerId, setCustomerId] = useState('');
  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [counterpartyName, setCounterpartyName] = useState('');
  const [date, setDate] = useState('');
  const [taxRate, setTaxRate] = useState('0');
  const [lines, setLines] = useState<OcrLine[]>([]);
  const [notes, setNotes] = useState('');

  if (!isOcrScannerOpen) return null;

  const reset = () => {
    setImageBase64('');
    setFileName('');
    setResult(null);
    setModel('');
    setDuplicate(false);
    setNeedsReview(false);
    setBusinessDuplicate(false);
    setError(null);
    setLines([]);
    setCounterpartyName('');
    setNotes('');
  };

  const close = () => {
    reset();
    setIsOcrScannerOpen(false);
  };

  const loadLookups = async () => {
    try {
      const [custs, inv] = await Promise.all([
        commercialApi.listCustomers(),
        commercialApi.listInventory().catch(() => []),
      ]);
      setCustomers(custs);
      setCatalog((inv as CatalogItem[]) || []);
    } catch {
      // non-fatal
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraOn(true);
      }
    } catch {
      setError('Camera access was denied or unavailable. Please upload an image instead.');
    }
  };

  const stopCamera = () => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach(t => t.stop());
    setCameraOn(false);
  };

  const capturePhoto = async () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    stopCamera();
    setFileName('camera-capture.jpg');
    setScanning(true);
    setResult(null);
    setError(null);
    try {
      await loadLookups();
      const res = await ocrApi.extract(kind, dataUrl, 'image/jpeg');
      applyExtraction(res.extraction);
      setModel(res.model);
      setDuplicate(res.duplicate);
      setNeedsReview(res.needsReview);
      setBusinessDuplicate(res.businessDuplicate);
    } catch (err: any) {
      setError(err?.message || 'AI extraction failed. Please try again.');
    } finally {
      setScanning(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg)$/.test(file.type)) {
      setError('Please upload a PNG or JPG image of the document.');
      return;
    }
    setError(null);
    setFileName(file.name);
    setScanning(true);
    setResult(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setImageBase64(dataUrl);
      await loadLookups();
      const res = await ocrApi.extract(kind, dataUrl, file.type);
      applyExtraction(res.extraction);
      setModel(res.model);
      setDuplicate(res.duplicate);
      setNeedsReview(res.needsReview);
      setBusinessDuplicate(res.businessDuplicate);
      if (res.duplicate) triggerShortcutNotice('This document was already scanned — showing the saved extraction');
    } catch (err: any) {
      setError(err?.message || 'AI extraction failed. Please try a clearer image.');
    } finally {
      setScanning(false);
    }
    if (e.target) e.target.value = '';
  };

  const applyExtraction = (ext: OcrExtraction) => {
    setResult(ext);
    setCounterpartyName(ext.counterpartyName || '');
    setDate(ext.date || new Date().toISOString().slice(0, 10));
    setTaxRate(String(ext.taxRate ?? 0));
    // Auto-categorize: match each line to the catalog and suggest the sales price
    // when the OCR rate is missing/zero. The user can still edit everything.
    setLines(ext.lines.map(l => {
      const item = matchCatalogItem(l.description, catalog);
      const rate = (Number(l.rate) > 0 ? Number(l.rate) : item?.sales_price != null ? Number(item.sales_price) : Number(l.rate)) || 0;
      return { ...l, rate, amount: Math.round((Number(l.quantity) || 0) * rate * 100) / 100 };
    }));
  };

  const updateLine = (idx: number, patch: Partial<OcrLine>) =>
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const next = { ...l, ...patch };
      next.amount = Math.round((Number(next.quantity) || 0) * (Number(next.rate) || 0) * 100) / 100;
      return next;
    }));

  const subtotal = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const tax = Math.round(subtotal * (Number(taxRate) || 0)) / 100;
  const total = subtotal + tax;

  const handleConfirm = async () => {
    if (!result) return;
    if (kind === 'receipt' || kind === 'supplier_bill') {
      // Receipts/supplier bills are captured for review only — never posted here.
      triggerShortcutNotice(`${KIND_LABELS[kind]} saved for review`);
      close();
      return;
    }
    if (!customerId) {
      setError('Select a customer to create the document.');
      return;
    }
    setPosting(true);
    setError(null);
    const idempotencyKey = `ocr-${result.kind}-${Date.now()}`;
    try {
      if (kind === 'quote') {
        const created = await quoteApi.create({
          customerId: Number(customerId),
          title: counterpartyName || 'Quoted document',
          notes: notes || null,
          taxRate: Number(taxRate) || 0,
          lines: lines.map(l => ({ description: l.description, quantity: String(l.quantity), rate: String(l.rate) })),
        });
        triggerShortcutNotice(`Quote ${created.quote.quote_number} created from OCR`);
        close();
        openPrimePreview('QUOTATION', {
          number: created.quote.quote_number,
          quotationNumber: created.quote.quote_number,
          date,
          clientName: counterpartyName,
          customerName: counterpartyName,
          items: lines.map(l => ({ desc: l.description, qty: l.quantity, price: l.rate, total: l.amount })),
          subtotal,
          taxAmount: tax,
          totalAmount: total,
          currency,
          notes,
        }, `Quote ${created.quote.quote_number}`);
      } else {
        const inv = await commercialApi.createInvoice({
          customerId: Number(customerId),
          invoiceDate: date,
          taxRate: Number(taxRate) || 0,
          notes: notes || null,
          idempotencyKey,
          lines: lines.map(l => ({ description: l.description, quantity: l.quantity, rate: l.rate, taxable: (Number(taxRate) || 0) > 0 })),
        });
        triggerShortcutNotice(`Invoice ${inv.invoiceNumber} created from OCR`);
        close();
        openPrimePreview('INVOICE', {
          number: inv.invoiceNumber,
          invoiceNumber: inv.invoiceNumber,
          date,
          clientName: counterpartyName,
          customerName: counterpartyName,
          items: lines.map(l => ({ desc: l.description, qty: l.quantity, price: l.rate, total: l.amount })),
          subtotal,
          taxAmount: tax,
          totalAmount: total,
          currency,
          notes,
        }, `Invoice ${inv.invoiceNumber}`);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to create document');
    } finally {
      setPosting(false);
    }
  };

  const inputCls = 'w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 dark:bg-black/60 p-4" onClick={close}>
      <div className="w-full max-w-3xl bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-pop overflow-hidden flex flex-col max-h-[92vh]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-3 bg-slate-900 text-white">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-300" />
            <span className="font-bold text-sm">AI Document OCR — {KIND_LABELS[kind]} Capture</span>
          </div>
          <button onClick={close} className="text-white/80 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto text-xs">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200">
              <AlertTriangle className="w-4 h-4 shrink-0" /><span>{error}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 p-0.5">
              {(['invoice', 'quote', 'receipt', 'supplier_bill'] as Kind[]).map(k => (
                <button key={k} onClick={() => setKind(k)} className={`px-3 py-1 rounded font-semibold ${kind === k ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}>
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" onChange={handleFile} className="hidden" />
            <button onClick={() => fileRef.current?.click()} disabled={scanning} className="btn btn-secondary">
              {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {scanning ? 'Scanning…' : 'Upload document'}
            </button>
            {!cameraOn && (
              <button onClick={startCamera} disabled={scanning} className="btn btn-secondary">
                <Camera className="w-4 h-4" /> Use camera
              </button>
            )}
            {fileName && <span className="text-slate-500">{fileName}</span>}
            {model && <span className="ml-auto text-[10px] text-slate-400">model: {model}{duplicate ? ' · duplicate' : ''}</span>}
          </div>

          {cameraOn && (
            <div className="space-y-2">
              <video ref={videoRef} className="w-full max-h-64 rounded-lg bg-black object-contain" playsInline muted />
              <div className="flex gap-2">
                <button onClick={capturePhoto} disabled={scanning} className="btn btn-primary">
                  <Camera className="w-4 h-4" /> Capture &amp; Scan
                </button>
                <button onClick={stopCamera} className="btn btn-secondary">Cancel</button>
              </div>
            </div>
          )}

          {result && (
            <>
              <div className="flex items-center gap-2 text-emerald-600 font-semibold">
                <CheckCircle2 className="w-4 h-4" /> Extracted {result.lines.length} line(s) · confidence {Math.round((result.confidence || 0) * 100)}%
              </div>

              {needsReview && (
                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  Low confidence — please review every field before creating the document.
                </div>
              )}
              {businessDuplicate && (
                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-orange-50 dark:bg-orange-950/40 border border-orange-300 dark:border-orange-800 text-orange-800 dark:text-orange-200">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  A similar document (same counterparty, date and total) already exists — check for a duplicate.
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="space-y-1 sm:col-span-2">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Customer</span>
                  <select value={customerId} onChange={e => setCustomerId(e.target.value)} className={inputCls}>
                    <option value="">— Select customer —</option>
                    {customers.map(c => <option key={c.id} value={c.id}>{c.companyName || c.name}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Date</span>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
                </label>
                <label className="space-y-1">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Counterparty</span>
                  <input value={counterpartyName} onChange={e => setCounterpartyName(e.target.value)} className={inputCls} />
                </label>
                <label className="space-y-1">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Tax Rate (%)</span>
                  <input type="number" min="0" max="100" step="0.01" value={taxRate} onChange={e => setTaxRate(e.target.value)} className={inputCls} />
                </label>
                <label className="space-y-1">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Currency</span>
                  <input value={result.currency} readOnly className={inputCls} />
                </label>
              </div>

              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center">
                    <input value={l.description} onChange={e => updateLine(i, { description: e.target.value })} placeholder="Description" className="col-span-6 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2 py-1" />
                    <input type="number" min="0" step="0.0001" value={l.quantity} onChange={e => updateLine(i, { quantity: Number(e.target.value) })} className="col-span-2 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2 py-1" />
                    <input type="number" min="0" step="0.0001" value={l.rate} onChange={e => updateLine(i, { rate: Number(e.target.value) })} className="col-span-2 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2 py-1" />
                    <button type="button" onClick={() => setLines(p => p.filter((_, j) => j !== i))} className="col-span-2 text-rose-500 text-[11px]">Remove</button>
                  </div>
                ))}
                <button type="button" onClick={() => setLines(p => [...p, { description: '', quantity: 1, rate: 0, amount: 0 }])} className="text-[11px] font-semibold text-blue-600">+ Add line</button>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 pt-3">
                <div className="font-mono text-[11px] text-slate-500">
                  Subtotal {currency}{subtotal.toFixed(2)} · Tax {currency}{tax.toFixed(2)}
                </div>
                <div className="font-mono font-bold text-sm">Total {currency}{total.toFixed(2)}</div>
              </div>

              <label className="space-y-1 block">
                <span className="font-semibold text-slate-600 dark:text-slate-300">Notes</span>
                <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} placeholder="Optional notes" />
              </label>

              <div className="flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800 pt-3">
                <button onClick={close} className="btn btn-secondary">Cancel</button>
                <button onClick={handleConfirm} disabled={posting} className="btn btn-primary disabled:opacity-50">
                  {posting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                  {posting ? 'Creating…' : kind === 'receipt' || kind === 'supplier_bill' ? 'Done' : `Create ${KIND_LABELS[kind]}`}
                </button>
              </div>
            </>
          )}

          {!result && !scanning && (
            <div className="p-10 flex flex-col items-center gap-2 text-slate-500">
              <Upload className="w-8 h-8" />
              <span>Upload a PNG/JPG of a quote or invoice to extract it with AI.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};