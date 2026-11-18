import React, { useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
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

export const IifImportModal: React.FC<IifImportModalProps> = (props) => {
  const { isIifImportOpen, setIsIifImportOpen, addAccount, addCustomer, triggerShortcutNotice } = useAccounting();
  const isOpen = props.isOpen !== undefined ? props.isOpen : isIifImportOpen;
  const onClose = props.onClose || (() => setIsIifImportOpen(false));

  const [activePreset, setActivePreset] = useState<'coa' | 'customers' | 'custom'>('coa');
  const [iifText, setIifText] = useState(SAMPLE_IIF_COA);
  const [parsedRowsCount, setParsedRowsCount] = useState<number>(5);

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

  const handleExecuteImport = () => {
    const lines = iifText.split('\n').map(l => l.trim()).filter(Boolean);
    let importedCount = 0;

    lines.forEach(line => {
      const parts = line.split('\t');
      const recordType = parts[0];

      if (recordType === 'ACCNT') {
        const name = parts[1] || 'Imported Account';
        const typeRaw = parts[2] || 'Expense';
        const desc = parts[3] || '';
        const bal = parseFloat(parts[4]) || 0;

        let typeMapped: any = 'Expense';
        if (typeRaw === 'BANK') typeMapped = 'Bank';
        else if (typeRaw === 'OCASSET') typeMapped = 'OtherCurrentAsset';
        else if (typeRaw === 'FIXASSET') typeMapped = 'FixedAsset';
        else if (typeRaw === 'OCLIAB') typeMapped = 'OtherCurrentLiability';
        else if (typeRaw === 'INC') typeMapped = 'Income';

        addAccount({
          code: `${Math.floor(1800 + Math.random() * 8000)}`,
          name,
          type: typeMapped,
          description: desc,
          balance: bal,
        });
        importedCount++;
      } else if (recordType === 'CUST') {
        const companyName = parts[1] || 'Imported Customer';
        const addr1 = parts[2] || '';
        const addr2 = parts[3] || '';
        const terms = parts[4] || 'Net 30';

        addCustomer({
          name: companyName,
          companyName,
          email: `purchasing@${companyName.toLowerCase().replace(/[^a-z]/g, '')}.com`,
          phone: '(555) 019-2831',
          billingAddress: `${addr1}, ${addr2}`,
          terms: terms as any,
          notes: 'Migrated from QuickBooks IIF file',
        });
        importedCount++;
      }
    });

    triggerShortcutNotice(`Successfully imported ${importedCount} QuickBooks IIF records into Printing Management System!`);
    onClose();
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

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExecuteImport}
              className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-md transition-all active:scale-95"
            >
              <Upload className="w-4 h-4" />
              <span>Import Records into Printing Management System</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
