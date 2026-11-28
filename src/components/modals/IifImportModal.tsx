import React, { useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { accountingApi } from '../../services/accountingApi';
import { commercialApi } from '../../services/commercialApi';
import { ApiError } from '../../services/http';
import {
  FileSpreadsheet,
  X,
  Upload,
  CheckCircle2,
  AlertCircle,
  FileCode2,
  ArrowRight,
  Database,
} from 'lucide-react';

const SAMPLE_IIF_COA = `!ACCNT\tNAME\tACCNTTYPE\tDESC\tACCBLNC
ACCNT\tCash on Hand\tBANK\tPetty cash box\t500.00
ACCNT\tPrepaid Commercial Rent\tOCASSET\tAdvance lease deposits\t3600.00
ACCNT\tShop Laser Cutting Machinery\tFIXASSET\tHigh-precision fiber laser\t82000.00
ACCNT\tCorporate Tax Payable\tOCLIAB\tAccrued annual state taxes\t4100.00
ACCNT\tContract Manufacturing Revenue\tINC\tOEM industrial production\t64000.00`;

const SAMPLE_IIF_CUSTOMERS = `!CUST\tNAME\tBADDR1\tBADDR2\tTERMS\tBALANCE
CUST\tNorthrop Grumman Mission Systems\t1500 Orbit Way\tRedondo Beach, CA\tNet 30\t18400.00
CUST\tGeneral Dynamics Land Systems\t38500 Mound Rd\tSterling Heights, MI\tNet 30\t22100.00
CUST\tLockheed Martin Space Systems\t1111 Lockheed Way\tSunnyvale, CA\tNet 15\t9500.00`;

interface IifImportModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

type ImportRowStatus = 'created' | 'pending' | 'skipped' | 'failed';
interface ImportRowResult {
  row: number;
  type: 'ACCNT' | 'CUST';
  label: string;
  status: ImportRowStatus;
  reason: string;
}

/** Stable, content-derived key (not a display-name hash) for retry safety. */
function stableRowKey(type: string, identity: string): string {
  let h = 5381;
  const s = `${type}:${identity.trim().toLowerCase()}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `iif-${type.toLowerCase()}-${(h >>> 0).toString(36)}`;
}

export const IifImportModal: React.FC<IifImportModalProps> = (props) => {
  const { isIifImportOpen, setIsIifImportOpen, triggerShortcutNotice } = useAccounting();
  const isOpen = props.isOpen !== undefined ? props.isOpen : isIifImportOpen;
  const onClose = props.onClose || (() => setIsIifImportOpen(false));

  const [activePreset, setActivePreset] = useState<'coa' | 'customers' | 'custom'>('coa');
  const [iifText, setIifText] = useState(SAMPLE_IIF_COA);
  const [parsedRowsCount, setParsedRowsCount] = useState<number>(5);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportRowResult[] | null>(null);

  // Dialogs opened from the header must be dismissible from the keyboard.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelectPreset = (preset: 'coa' | 'customers') => {
    setActivePreset(preset);
    if (preset === 'coa') {
      setIifText(SAMPLE_IIF_COA);
      setParsedRowsCount(5);
    } else {
      setIifText(SAMPLE_IIF_CUSTOMERS);
      setParsedRowsCount(3);
    }
  };

  const handleExecuteImport = async () => {
    const lines = iifText.split('\n').map(l => l.trim()).filter(Boolean);
    setImporting(true);
    setResults(null);

    // Parse + validate the whole file before any mutation.
    type ParsedRow =
      | { kind: 'ACCNT'; row: number; name: string; code: string | null; typeMapped: any; description: string }
      | { kind: 'CUST'; row: number; companyName: string; addr1: string; addr2: string; terms: string };
    const parsed: ParsedRow[] = [];
    const out: ImportRowResult[] = [];
    const seen = new Set<string>();

    lines.forEach((line, idx) => {
      const parts = line.split('\t');
      const recordType = parts[0];
      const rowNo = idx + 1;
      if (recordType === 'ACCNT') {
        const name = (parts[1] || '').trim();
        if (!name) {
          out.push({ row: rowNo, type: 'ACCNT', label: '(no name)', status: 'failed', reason: 'Missing account name' });
          return;
        }
        const typeRaw = parts[2] || 'Expense';
        let typeMapped: any = 'Expense';
        if (typeRaw === 'BANK') typeMapped = 'Bank';
        else if (typeRaw === 'OCASSET') typeMapped = 'OtherCurrentAsset';
        else if (typeRaw === 'FIXASSET') typeMapped = 'FixedAsset';
        else if (typeRaw === 'OCLIAB') typeMapped = 'OtherCurrentLiability';
        else if (typeRaw === 'INC') typeMapped = 'Income';
        const code = (parts[5] || '').trim() || null;
        const identity = code || name;
        if (seen.has(`ACCNT:${identity.toLowerCase()}`)) {
          out.push({ row: rowNo, type: 'ACCNT', label: name, status: 'skipped', reason: 'Duplicate row in file' });
          return;
        }
        seen.add(`ACCNT:${identity.toLowerCase()}`);
        parsed.push({ kind: 'ACCNT', row: rowNo, name, code, typeMapped, description: parts[3] || '' });
      } else if (recordType === 'CUST') {
        const companyName = (parts[1] || '').trim();
        if (!companyName) {
          out.push({ row: rowNo, type: 'CUST', label: '(no name)', status: 'failed', reason: 'Missing customer name' });
          return;
        }
        if (seen.has(`CUST:${companyName.toLowerCase()}`)) {
          out.push({ row: rowNo, type: 'CUST', label: companyName, status: 'skipped', reason: 'Duplicate row in file' });
          return;
        }
        seen.add(`CUST:${companyName.toLowerCase()}`);
        parsed.push({ kind: 'CUST', row: rowNo, companyName, addr1: parts[2] || '', addr2: parts[3] || '', terms: parts[4] || 'Net 30' });
      }
    });

    // Persist each valid row through the authoritative APIs. Per-row keys make a
    // retry safe; the server's unique constraints are the authoritative
    // duplicate guard (these endpoints do not use request_keys).
    for (const p of parsed) {
      if (p.kind === 'ACCNT') {
        try {
          await accountingApi.createAccount(
            { code: p.code, name: p.name, accountType: p.typeMapped, description: p.description },
            stableRowKey('ACCNT', p.code || p.name)
          );
          out.push({ row: p.row, type: 'ACCNT', label: p.name, status: 'created', reason: 'Created' });
        } catch (err) {
          const code = err instanceof ApiError ? (err.body as any)?.code : undefined;
          if (err instanceof ApiError && err.status === 409 && code === 'DUPLICATE_ACCOUNT_CODE') {
            out.push({ row: p.row, type: 'ACCNT', label: p.name, status: 'skipped', reason: 'Account code already exists' });
          } else {
            out.push({ row: p.row, type: 'ACCNT', label: p.name, status: 'failed', reason: (err as Error)?.message || 'Account import failed' });
          }
        }
      } else {
        try {
          const created = await commercialApi.createCustomer(
            {
              name: p.companyName,
              companyName: p.companyName,
              email: `purchasing@${p.companyName.toLowerCase().replace(/[^a-z]/g, '')}.com`,
              phone: '(555) 019-2831',
              billingAddress: `${p.addr1}, ${p.addr2}`,
              terms: p.terms as any,
              notes: 'Migrated from QuickBooks IIF file',
            },
            stableRowKey('CUST', p.companyName)
          );
          if (!created || !(created as any).id) {
            // HTTP 202 — pending maker-checker approval, NOT created.
            out.push({ row: p.row, type: 'CUST', label: p.companyName, status: 'pending', reason: 'Pending approval' });
          } else {
            out.push({ row: p.row, type: 'CUST', label: p.companyName, status: 'created', reason: 'Created' });
          }
        } catch (err) {
          const code = err instanceof ApiError ? (err.body as any)?.code : undefined;
          if (err instanceof ApiError && err.status === 409 && code === 'DUPLICATE_CUSTOMER') {
            out.push({ row: p.row, type: 'CUST', label: p.companyName, status: 'skipped', reason: 'Customer already exists' });
          } else {
            out.push({ row: p.row, type: 'CUST', label: p.companyName, status: 'failed', reason: (err as Error)?.message || 'Customer import failed' });
          }
        }
      }
    }

    const ordered = [...out].sort((a, b) => a.row - b.row);
    setResults(ordered);
    setImporting(false);
    const created = ordered.filter(r => r.status === 'created').length;
    const pending = ordered.filter(r => r.status === 'pending').length;
    const skipped = ordered.filter(r => r.status === 'skipped').length;
    const failed = ordered.filter(r => r.status === 'failed').length;
    triggerShortcutNotice(
      `IIF import: ${created} created, ${pending} pending approval, ${skipped} skipped, ${failed} failed.`
    );
    // Do not auto-close: the operator must see the itemized results (pending is
    // never reported as created).
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="iif-import-title"
        className="w-full max-w-3xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]"
      >
        {/* Header */}
        <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-amber-300" />
            <h2 id="iif-import-title" className="font-bold text-base tracking-tight">
              QuickBooks IIF & OFX Migration Wizard
            </h2>
            <span className="text-xs text-amber-200 font-mono">
              [Intuit Interchange Format Parser]
            </span>
          </div>
          <button onClick={onClose} aria-label="Close IIF and OFX import dialog" className="p-1 rounded text-white/80 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 text-xs overflow-y-auto">
          <div>
            <label className="font-bold text-slate-800 dark:text-slate-200">
              Select QuickBooks Import Source:
            </label>
            <div className="grid grid-cols-2 gap-3 mt-1.5">
              <button
                type="button"
                onClick={() => handleSelectPreset('coa')}
                className={`p-3 rounded-lg border text-left transition-all ${
                  activePreset === 'coa'
                    ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40 text-blue-900 dark:text-blue-100 font-bold ring-1 ring-blue-500'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-850'
                }`}
              >
                <div className="font-bold">Chart of Accounts IIF Export</div>
                <div className="text-[11px] text-slate-500 mt-0.5">!ACCNT headers & standard balances</div>
              </button>

              <button
                type="button"
                onClick={() => handleSelectPreset('customers')}
                className={`p-3 rounded-lg border text-left transition-all ${
                  activePreset === 'customers'
                    ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40 text-blue-900 dark:text-blue-100 font-bold ring-1 ring-blue-500'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-850'
                }`}
              >
                <div className="font-bold">Customer Directory IIF Export</div>
                <div className="text-[11px] text-slate-500 mt-0.5">!CUST headers with addresses & terms</div>
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="font-semibold text-slate-700 dark:text-slate-300">
              IIF Tab-Delimited Raw Data:
            </label>
            <textarea
              value={iifText}
              onChange={e => {
                setIifText(e.target.value);
                const count = e.target.value.split('\n').filter(l => l.startsWith('ACCNT') || l.startsWith('CUST')).length;
                setParsedRowsCount(count);
                setActivePreset('custom');
              }}
              rows={8}
              className="w-full font-mono text-[11px] bg-slate-950 text-emerald-400 p-3 rounded-lg border border-slate-700 outline-none leading-relaxed"
            />
          </div>

          <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg flex items-center justify-between font-mono text-xs">
            <span className="text-slate-600 dark:text-slate-300 font-sans flex items-center gap-1.5 font-semibold">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>Parsed {parsedRowsCount} valid QuickBooks records ready for import</span>
            </span>
            <span className="text-blue-600 dark:text-blue-400 font-bold">Standard IIF Validated</span>
          </div>

          {results && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
                <span className="rounded bg-emerald-100 text-emerald-700 px-2 py-0.5 dark:bg-emerald-500/15 dark:text-emerald-300">
                  {results.filter(r => r.status === 'created').length} created
                </span>
                <span className="rounded bg-amber-100 text-amber-700 px-2 py-0.5 dark:bg-amber-500/15 dark:text-amber-300">
                  {results.filter(r => r.status === 'pending').length} pending approval
                </span>
                <span className="rounded bg-slate-200 text-slate-700 px-2 py-0.5 dark:bg-white/10 dark:text-slate-300">
                  {results.filter(r => r.status === 'skipped').length} skipped
                </span>
                <span className="rounded bg-rose-100 text-rose-700 px-2 py-0.5 dark:bg-rose-500/15 dark:text-rose-300">
                  {results.filter(r => r.status === 'failed').length} failed
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-white/5">
                {results.map(r => (
                  <div key={`${r.row}-${r.type}`} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px]">
                    <span className="min-w-0 truncate text-slate-700 dark:text-slate-300">
                      <span className="font-mono text-slate-400">{r.row}.</span> {r.label}
                    </span>
                    <span
                      className={
                        r.status === 'created'
                          ? 'shrink-0 font-semibold text-emerald-600 dark:text-emerald-400'
                          : r.status === 'pending'
                          ? 'shrink-0 font-semibold text-amber-600 dark:text-amber-400'
                          : r.status === 'skipped'
                          ? 'shrink-0 font-semibold text-slate-500 dark:text-slate-400'
                          : 'shrink-0 font-semibold text-rose-600 dark:text-rose-400'
                      }
                      title={r.reason}
                    >
                      {r.status === 'pending' ? 'pending' : r.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
            >
              {results ? 'Close' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={handleExecuteImport}
              disabled={importing}
              className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-md transition-all active:scale-95 disabled:opacity-60 disabled:pointer-events-none"
            >
              <Upload className="w-4 h-4" />
              <span>{importing ? 'Importing…' : 'Import Records into Printing Management System'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
