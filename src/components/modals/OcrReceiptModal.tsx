import React, { useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { commercialApi } from '../../services/commercialApi';
import { accountingApi } from '../../services/accountingApi';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import {
  X,
  Sparkles,
  Upload,
  Receipt,
  CheckCircle2,
  FileText,
  Building2,
  DollarSign,
  ArrowRight,
  ShieldCheck,
  RefreshCw,
  AlertTriangle,
  Loader2,
} from 'lucide-react';

interface ScannedReceipt {
  vendorName: string;
  date: string;
  total: number;
  tax: number;
  suggestedAccountCode: string;
  suggestedAccountName: string;
  items: { description: string; amount: number }[];
  confidence: number;
  rawOcrText: string;
}

const SAMPLE_RECEIPTS: { name: string; receipt: ScannedReceipt }[] = [
  {
    name: 'Airgas Industrial Cylinder Refill',
    receipt: {
      vendorName: 'AirGas Regional Depot',
      date: '2026-11-09',
      total: 365.20,
      tax: 25.40,
      suggestedAccountCode: '5010',
      suggestedAccountName: 'Raw Materials & Metals COGS',
      items: [
        { description: 'Industrial Grade Argon 300cf Refill', amount: 185.00 },
        { description: 'Shielding Gas 75/25 CO2 Cylinder', amount: 154.80 },
      ],
      confidence: 98.4,
      rawOcrText:
        'AIRGAS REGIONAL DEPOT #0482\n3400 BROOKPARK RD\nDATE: 11/09/2026 14:22\n1. ARGON 300CF CYL {CUR}185.00\n2. SHIELD GAS 75/25 {CUR}154.80\nSUBTOTAL: {CUR}339.80\nSALES TAX 7.5%: {CUR}25.40\nTOTAL: {CUR}365.20\nPAID: VISA ***4912',
    },
  },
  {
    name: 'Fastenal Precision High-Tensile Fasteners',
    receipt: {
      vendorName: 'Fastenal Industrial Supply',
      date: '2026-11-07',
      total: 142.80,
      tax: 9.95,
      suggestedAccountCode: '6300',
      suggestedAccountName: 'Repairs & Tool Maintenance',
      items: [
        { description: 'Grade 8 Hex Cap Screws 1/2-13 (Box of 100)', amount: 68.50 },
        { description: 'Carbide Drill Bit Set 1/8" - 1/2"', amount: 64.35 },
      ],
      confidence: 96.8,
      rawOcrText:
        'FASTENAL STORE #0012\nINVOICE: 99481290\nDATE: 11/07/2026\nBOX GD8 1/2-13 SCREW {CUR}68.50\nCARBIDE BIT SET {CUR}64.35\nTAX: {CUR}9.95\nTOTAL: {CUR}142.80\nAUTH: 091823',
    },
  },
  {
    name: 'OfficeMax Blueprint Paper & Toner',
    receipt: {
      vendorName: 'Office Depot / OfficeMax',
      date: '2026-11-05',
      total: 89.50,
      tax: 6.24,
      suggestedAccountCode: '6400',
      suggestedAccountName: 'Office Supplies & Software',
      items: [
        { description: 'Large Format Engineering CAD Paper (24" x 150\')', amount: 48.00 },
        { description: 'High-Yield Black Toner Cartridge', amount: 35.26 },
      ],
      confidence: 99.1,
      rawOcrText:
        'OFFICEMAX STORE #0219\nDATE: 11/05/2026\nCAD DRAFTING ROLL 24X150 {CUR}48.00\nH-YLD TONER CART {CUR}35.26\nTAX: {CUR}6.24\nTOTAL: {CUR}89.50\nCUSTOMER COPY',
    },
  },
];

export const OcrReceiptModal: React.FC = () => {
  const { isOcrScannerOpen, setIsOcrScannerOpen, companyProfile, triggerShortcutNotice } = useAccounting();
  const { hasPermission } = useAuth();
  const canPostBills = hasPermission('bills:write');
  const canPostBanking = hasPermission('banking:write');
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);

  const [activeReceipt, setActiveReceipt] = useState<ScannedReceipt>(SAMPLE_RECEIPTS[0].receipt);
  const [isScanning, setIsScanning] = useState(false);
  const [customFileSelected, setCustomFileSelected] = useState<string | null>(null);
  const [posting, setPosting] = useState<'bill' | 'expense' | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  // Keep the dialog dismissible from the keyboard like every other header launcher.
  // Registered before the early return so hook order stays stable.
  useEffect(() => {
    if (!isOcrScannerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOcrScannerOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOcrScannerOpen, setIsOcrScannerOpen]);

  if (!isOcrScannerOpen) return null;

  const handleSimulateCustomUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCustomFileSelected(file.name);
      setIsScanning(true);
      setTimeout(() => {
        setIsScanning(false);
        setActiveReceipt({
          vendorName: file.name.replace(/\.[^/.]+$/, '').replace(/_/g, ' '),
          date: new Date().toISOString().split('T')[0],
          total: 218.40,
          tax: 15.20,
          suggestedAccountCode: '5010',
          suggestedAccountName: 'Raw Materials & Metals COGS',
          items: [
            { description: 'Extracted Material Line Item from receipt', amount: 203.20 },
          ],
          confidence: 97.2,
          rawOcrText: `OCR PARSED FROM ${file.name}\nTOTAL: {CUR}218.40\nTAX: {CUR}15.20\nITEMS EXTRACTED: 1`,
        });
      }, 900);
    }
  };

  const handleSelectSample = (sample: ScannedReceipt) => {
    setIsScanning(true);
    setTimeout(() => {
      setIsScanning(false);
      setActiveReceipt(sample);
    }, 400);
  };

  /**
   * Post the parsed receipt as a real vendor bill on the server.
   *
   * Previously this wrote into the browser cache only, so the A/P ledger and
   * the general ledger never saw the bill.
   */
  const handlePostAsBill = async () => {
    if (!canPostBills) {
      setPostError('Your role does not have permission to enter bills (bills:write).');
      return;
    }
    setPosting('bill');
    setPostError(null);
    try {
      const [vendors, accounts] = await Promise.all([
        commercialApi.listVendors(),
        accountingApi.listAccounts(),
      ]);

      const existingVendor =
        vendors.find(v =>
          v.companyName.toLowerCase().includes(activeReceipt.vendorName.toLowerCase().slice(0, 6))
        ) || vendors[0];

      if (!existingVendor) {
        throw new Error('No vendor exists yet. Create a vendor first, then retry.');
      }

      const targetAccount =
        accounts.find(a => a.code === activeReceipt.suggestedAccountCode && a.is_active) ||
        accounts.find(a => a.is_active && a.account_type === 'Expense') ||
        accounts.find(a => a.is_active);

      if (!targetAccount) {
        throw new Error('No expense account is available to categorise this receipt.');
      }

      const created = await commercialApi.createBill({
        vendorId: existingVendor.id,
        billDate: activeReceipt.date,
        dueDate: activeReceipt.date,
        terms: 'Due on Receipt',
        memo: `AI OCR parsed receipt from ${activeReceipt.vendorName}`,
        lines: activeReceipt.items.map(it => ({
          accountId: targetAccount.id,
          description: it.description,
          quantity: 1,
          unitCost: it.amount,
        })),
      });

      triggerShortcutNotice(
        `Posted Bill ${created.billNumber} (${formatCurrency(activeReceipt.total, currency)}) to Accounts Payable & GL`
      );
      setIsOcrScannerOpen(false);
    } catch (err: any) {
      const message = err?.message || 'Failed to post the receipt as a bill';
      setPostError(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setPosting(null);
    }
  };

  /** Post the receipt as a direct cash/bank expense on the server. */
  const handlePostAsDirectExpense = async () => {
    if (!canPostBanking) {
      setPostError('Your role does not have permission to record bank transactions (banking:write).');
      return;
    }
    setPosting('expense');
    setPostError(null);
    try {
      const [accounts, bankAccounts] = await Promise.all([
        accountingApi.listAccounts(),
        commercialApi.listBankAccounts(),
      ]);

      const targetAccount =
        accounts.find(a => a.code === activeReceipt.suggestedAccountCode && a.is_active) ||
        accounts.find(a => a.is_active && a.account_type === 'Expense');

      if (!targetAccount) {
        throw new Error('No expense account is available to categorise this receipt.');
      }

      const bank = bankAccounts.find(b => b.accountType === 'Bank') || bankAccounts[0];
      if (!bank) {
        throw new Error('No bank account is linked yet. Link one in the Check Register first.');
      }

      const tx = await commercialApi.recordExpenseOrCheck({
        bankGlAccountId: bank.glAccountId,
        txnDate: activeReceipt.date,
        payee: activeReceipt.vendorName,
        txnType: 'Debit',
        memo: `Instant receipt expense: ${activeReceipt.items[0]?.description || 'Supplies'}`,
        lines: [
          {
            accountId: targetAccount.id,
            amount: activeReceipt.total,
            memo: activeReceipt.items[0]?.description || 'OCR receipt',
          },
        ],
      });

      triggerShortcutNotice(
        `Recorded ${formatCurrency(activeReceipt.total, currency)} direct expense from receipt (${tx.category || targetAccount.name})`
      );
      setIsOcrScannerOpen(false);
    } catch (err: any) {
      const message = err?.message || 'Failed to record the direct expense';
      setPostError(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setPosting(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ocr-receipt-title"
        className="w-full max-w-4xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]"
      >
        {/* Header */}
        <div className="px-5 py-3 bg-gradient-to-r from-blue-700 to-indigo-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-300" />
            <h2 id="ocr-receipt-title" className="font-bold text-base tracking-tight">AI Receipt OCR & Auto-Categorizer</h2>
            <span className="text-xs text-indigo-200 font-mono">
              [Agent Extraction Engine]
            </span>
          </div>
          <button
            onClick={() => setIsOcrScannerOpen(false)}
            aria-label="Close receipt scanner dialog"
            className="p-1 rounded hover:bg-white/10 text-white/80 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {/* Sample Receipt Selector & File Upload */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 space-y-2">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                Choose a Sample Receipt or Upload:
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {SAMPLE_RECEIPTS.map((s, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSelectSample(s.receipt)}
                    className={`p-2.5 rounded-lg border text-left transition-all ${
                      activeReceipt.vendorName === s.receipt.vendorName
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-100 font-semibold shadow-xs'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div className="font-semibold truncate">{s.name}</div>
                    <div className="text-[11px] text-slate-500 mt-1">{formatCurrency(s.receipt.total, currency)}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Upload Image / PDF:</label>
              <label className="flex flex-col items-center justify-center p-3 border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer transition-colors text-center">
                <Upload className="w-5 h-5 text-blue-500 mb-1" />
                <span className="font-semibold text-[11px] text-slate-800 dark:text-slate-200">
                  Select Receipt File
                </span>
                <span className="text-[10px] text-slate-400">PNG, JPG, PDF up to 10MB</span>
                <input
                  type="file"
                  onChange={handleSimulateCustomUpload}
                  accept="image/*,.pdf"
                  className="hidden"
                />
              </label>
            </div>
          </div>

          {/* OCR Processing View */}
          {isScanning ? (
            <div className="p-12 text-center space-y-3">
              <RefreshCw className="w-8 h-8 text-blue-500 animate-spin mx-auto" />
              <div className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                Running Optical Character Recognition & Entity Extraction...
              </div>
              <div className="text-xs text-slate-500">
                Analyzing invoice numbers, tax rates, vendor EIN, and GAAP expense account mapping.
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              {/* Left Column: Raw OCR Stream */}
              <div className="p-4 rounded-lg bg-slate-950 text-slate-200 font-mono text-[11px] space-y-2 border border-slate-800">
                <div className="flex items-center justify-between text-slate-400 border-b border-slate-800 pb-2">
                  <span className="flex items-center gap-1.5 font-bold">
                    <Receipt className="w-3.5 h-3.5 text-amber-400" />
                    RAW OCR TEXT STREAM
                  </span>
                  <span className="text-emerald-400 flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5" /> Confidence {activeReceipt.confidence}%
                  </span>
                </div>
                <pre className="whitespace-pre-wrap leading-relaxed py-2 text-slate-300">
                  {activeReceipt.rawOcrText.replace(/\{CUR\}/g, currencySymbol)}
                </pre>
              </div>

              {/* Right Column: Structured Extraction Result */}
              <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-800 dark:text-slate-200 text-sm">
                    Structured Extraction
                  </span>
                  <span className="px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 font-mono text-[11px] font-semibold">
                    Parsed Successfully
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-slate-400">Extracted Vendor:</span>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">
                      {activeReceipt.vendorName}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-400">Receipt Date:</span>
                    <div className="font-semibold text-slate-900 dark:text-white mt-0.5">
                      {activeReceipt.date}
                    </div>
                  </div>
                </div>

                {/* Line items extracted */}
                <div className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-2">
                  <span className="text-slate-400 font-semibold">Extracted Line Items:</span>
                  <div className="space-y-1.5">
                    {activeReceipt.items.map((item, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
                      >
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          {item.description}
                        </span>
                        <span className="font-mono font-bold text-slate-900 dark:text-white">
                          {formatCurrency(item.amount, currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* AI GAAP Account Recommendation */}
                <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-900/60 space-y-1">
                  <div className="flex items-center gap-1.5 text-blue-700 dark:text-blue-300 font-bold">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>AI Suggested Ledger Account:</span>
                  </div>
                  <div className="font-mono text-sm font-bold text-blue-900 dark:text-blue-100">
                    {activeReceipt.suggestedAccountCode} - {activeReceipt.suggestedAccountName}
                  </div>
                </div>

                <div className="pt-2 flex items-baseline justify-between border-t border-slate-200 dark:border-slate-800 font-mono">
                  <span className="text-slate-500 font-semibold">Receipt Total:</span>
                  <span className="text-xl font-bold text-slate-900 dark:text-white">
                    {formatCurrency(activeReceipt.total, currency)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Action buttons */}
          {postError && (
            <div
              role="alert"
              className="p-3 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 text-xs flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{postError}</span>
            </div>
          )}

          <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setIsOcrScannerOpen(false)}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium"
            >
              Cancel
            </button>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handlePostAsDirectExpense}
                disabled={posting !== null}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-semibold transition-all shadow-sm disabled:opacity-60 inline-flex items-center gap-1.5"
                title={
                  canPostBanking
                    ? 'Post this receipt as a bank expense on the server'
                    : 'Requires banking:write permission'
                }
              >
                {posting === 'expense' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Post as Direct Cash/Debit Expense
              </button>
              <button
                type="button"
                onClick={handlePostAsBill}
                disabled={posting !== null}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-md transition-all active:scale-95 disabled:opacity-60"
                title={
                  canPostBills
                    ? 'Create a vendor bill on the server'
                    : 'Requires bills:write permission'
                }
              >
                {posting === 'bill' && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Convert to Vendor Bill (A/P)</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
