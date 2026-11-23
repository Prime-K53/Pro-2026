import React, { useEffect, useRef, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { companyApi } from '../../services/companyApi';
import type { CompanySettings } from '../../services/companyApi';
import { InlineAlert } from '../common/ui';
import {
  AlertTriangle,
  Building2,
  CalendarRange,
  Download,
  Loader2,
  Lock,
  Printer,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const SettingsView: React.FC = () => {
  const {
    companyProfile,
    updateCompanyProfile,
    resetToDemoData,
    clearAllData,
    exportDataToJson,
    importDataFromJson,
    triggerShortcutNotice,
  } = useAccounting();
  const { activeCompany, hasPermission, refreshStatus } = useAuth();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canEdit = hasPermission('companies:settings:write');

  const [serverSettings, setServerSettings] = useState<CompanySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState(companyProfile.name);
  const [legalName, setLegalName] = useState(companyProfile.legalName);
  const [ein, setEin] = useState(companyProfile.ein);
  const [taxPercent, setTaxPercent] = useState(
    String(Math.round(companyProfile.salesTaxRate * 10000) / 100)
  );
  const [extraTypingPerPage, setExtraTypingPerPage] = useState(
    String(companyProfile.extraTypingFinishingPerPage ?? 0)
  );
  const [sellingPricePerSheet, setSellingPricePerSheet] = useState(
    String(companyProfile.manualSellingPricePerSheet ?? 0)
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const settings = await companyApi.getCurrent();
        if (cancelled) return;
        setServerSettings(settings);
        setName(settings.name);
        setLegalName(settings.legalName || settings.name);
        setEin(settings.ein || '');
        setTaxPercent(String(settings.salesTaxRate));
        setExtraTypingPerPage(String(settings.extraTypingFinishingPerPage ?? 0));
        setSellingPricePerSheet(String(settings.manualSellingPricePerSheet ?? 0));
        updateCompanyProfile({
          name: settings.name,
          legalName: settings.legalName || settings.name,
          ein: settings.ein || '',
          accountingMethod: settings.accountingMethod === 'cash' ? 'cash' : 'accrual',
          salesTaxRate: settings.salesTaxRate / 100,
          extraTypingFinishingPerPage: settings.extraTypingFinishingPerPage ?? 0,
          manualSellingPricePerSheet: settings.manualSellingPricePerSheet ?? 0,
          fiscalYearStartMonth: settings.fiscalYearStartMonth,
          currency: settings.currencySymbol || companyProfile.currency,
        });
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message || 'Unable to load company settings from the server');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompany?.id]);

  const handleSaveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    const percent = Number(taxPercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      setSaveError('Sales tax rate must be between 0 and 100 percent.');
      return;
    }
    const extraTyping = Number(extraTypingPerPage);
    const sheetPrice = Number(sellingPricePerSheet);
    if (!Number.isFinite(extraTyping) || extraTyping < 0) {
      setSaveError('Extra typing / finishing per page must be zero or more.');
      return;
    }
    if (!Number.isFinite(sheetPrice) || sheetPrice < 0) {
      setSaveError('Manual selling price per sheet must be zero or more.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSavedAt(null);
    try {
      const res = await companyApi.updateCurrent({
        name: name.trim(),
        legalName: legalName.trim(),
        ein: ein.trim(),
        salesTaxRate: percent,
        extraTypingFinishingPerPage: extraTyping,
        manualSellingPricePerSheet: sheetPrice,
      });
      updateCompanyProfile({
        name: res.company.name,
        legalName: res.company.legalName || res.company.name,
        ein: res.company.ein || '',
        salesTaxRate: res.company.salesTaxRate / 100,
        extraTypingFinishingPerPage: res.company.extraTypingFinishingPerPage ?? extraTyping,
        manualSellingPricePerSheet: res.company.manualSellingPricePerSheet ?? sheetPrice,
      });
      await refreshStatus();
      setSavedAt(new Date().toLocaleTimeString());
      triggerShortcutNotice('Company settings saved to the server');
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save company settings');
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = ev => {
        const str = ev.target?.result as string;
        if (str) {
          const success = importDataFromJson(str);
          if (success) {
            triggerShortcutNotice('Working copy restored into this browser');
          }
        }
      };
      reader.readAsText(file);
    }
    if (e.target) e.target.value = '';
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto text-xs">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
          Company Settings
        </h1>
        <p className="text-slate-500 mt-0.5">
          Legal identity, tax defaults and workspace preferences. Changes to the company record are written to
          the server and captured in the audit trail.
        </p>
      </div>

      {loadError && (
        <InlineAlert tone="warning" onDismiss={() => setLoadError(null)}>
          {loadError} Showing the cached browser values instead. Saving is disabled until the server responds again.
        </InlineAlert>
      )}

      {saveError && (
        <InlineAlert tone="error" onDismiss={() => setSaveError(null)}>
          {saveError}
        </InlineAlert>
      )}

      {savedAt && (
        <InlineAlert tone="success" onDismiss={() => setSavedAt(null)}>
          Company record saved to the server at {savedAt}. Changes are recorded in the audit trail.
        </InlineAlert>
      )}

      {!canEdit && (
        <InlineAlert tone="info">
          <span className="flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" />
            Your role can view company settings but not change them. Ask an Administrator for the
            <span className="font-mono mx-1">companies:settings:write</span>
            permission.
          </span>
        </InlineAlert>
      )}

      <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".sbp,.json" className="hidden" />

      <form onSubmit={handleSaveCompany} className="surface p-6 space-y-5">
        <div className="border-b border-slate-200 dark:border-slate-800 pb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="section-title flex items-center gap-2">
              <Building2 className="w-4 h-4 text-blue-600" />
              <span>Legal Entity & Tax Information</span>
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              These values appear on invoices, statements and tax reports issued by this company.
            </p>
          </div>
          <button type="submit" disabled={!canEdit || saving || loading} className="btn btn-primary">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            <span>{saving ? 'Saving…' : 'Save to server'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="app-label">Company Display Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="app-input"
              disabled={!canEdit}
              required
            />
          </div>

          <div>
            <label className="app-label">Legal Entity Name</label>
            <input
              type="text"
              value={legalName}
              onChange={e => setLegalName(e.target.value)}
              className="app-input"
              disabled={!canEdit}
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="app-label">Tax Identification (EIN / TPIN)</label>
            <input
              type="text"
              value={ein}
              onChange={e => setEin(e.target.value)}
              placeholder="XX-XXXXXXX"
              className="app-input app-input-mono"
              disabled={!canEdit}
            />
          </div>

          <div>
            <label className="app-label">Accounting Method</label>
            <input
              type="text"
              value={
                serverSettings
                  ? serverSettings.accountingMethod === 'cash'
                    ? 'Cash basis'
                    : 'Accrual basis'
                  : companyProfile.accountingMethod === 'cash'
                  ? 'Cash basis'
                  : 'Accrual basis'
              }
              className="app-input"
              disabled
              title="The accounting method is fixed by the company ledger configuration"
            />
          </div>

          <div>
            <label className="app-label">Default Currency</label>
            <input
              type="text"
              value={
                serverSettings
                  ? `${serverSettings.currencySymbol} (${serverSettings.baseCurrency})`
                  : companyProfile.currency
              }
              className="app-input app-input-mono"
              disabled
              title="Currency is defined on the server company record"
            />
          </div>

          <div>
            <label className="app-label">Default Sales Tax Rate (%)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={taxPercent}
              onChange={e => setTaxPercent(e.target.value)}
              className="app-input app-input-mono"
              disabled={!canEdit}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="app-label">Contact Phone</label>
            <input
              type="text"
              value={companyProfile.phone}
              onChange={e => updateCompanyProfile({ phone: e.target.value })}
              className="app-input"
              disabled={!canEdit}
              placeholder="Stored on this workspace"
            />
          </div>
          <div>
            <label className="app-label">Accounting Email</label>
            <input
              type="email"
              value={companyProfile.email}
              onChange={e => updateCompanyProfile({ email: e.target.value })}
              className="app-input"
              disabled={!canEdit}
            />
          </div>
          <div>
            <label className="app-label">Website</label>
            <input
              type="text"
              value={companyProfile.website}
              onChange={e => updateCompanyProfile({ website: e.target.value })}
              className="app-input"
              disabled={!canEdit}
            />
          </div>
        </div>

        <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Printer className="w-4 h-4 text-purple-600" />
              <span>Print Desk Pricing Defaults</span>
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              The only place these desk rates are set. The Quick Photocopy desk and the print job forms on invoices and
              POS read them automatically, so every operator quotes the same price. Material cost always comes from
              the raw material inventory, never from these rates.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="app-label">Extra Typing / Finishing per Page ({companyProfile.currency})</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={extraTypingPerPage}
                onChange={e => setExtraTypingPerPage(e.target.value)}
                className="app-input app-input-mono"
                disabled={!canEdit}
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Applied per document page for Type &amp; Print jobs only. Quick Photocopy carries no extra charge —
                it is priced per sheet.
              </p>
            </div>
            <div>
              <label className="app-label">Manual Selling Price per Sheet ({companyProfile.currency})</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={sellingPricePerSheet}
                onChange={e => setSellingPricePerSheet(e.target.value)}
                className="app-input app-input-mono"
                disabled={!canEdit}
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Selling rate multiplied by the sheets actually used (duplex-aware). Used by Quick Photocopy, Type
                &amp; Print and POS print jobs.
              </p>
            </div>
          </div>
        </div>

        <p className="text-[11px] text-slate-500">
          Contact details are workspace preferences. Company name, legal name, tax ID, tax rate and print desk pricing
          defaults are saved to the server company record.
        </p>
      </form>

      {/* Server-verified company facts */}
      <section className="surface p-6 space-y-4">
        <div className="border-b border-slate-200 dark:border-slate-800 pb-3 flex items-center justify-between gap-2">
          <h2 className="section-title flex items-center gap-2">
            <Server className="w-4 h-4 text-emerald-600" />
            <span>Server Workspace</span>
          </h2>
          <span className="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 inline-flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" /> Verified session
          </span>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <dt className="text-[11px] font-semibold text-slate-500">Active Company</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
              {activeCompany?.name || companyProfile.name}
            </dd>
            <dd className="text-[11px] text-slate-500 font-mono">{serverSettings?.slug || '—'}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold text-slate-500">Your Role</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
              {activeCompany?.role || serverSettings?.role || companyProfile.currentUserRole}
            </dd>
            <dd className="text-[11px] text-slate-500">Company membership is re-verified per request.</dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold text-slate-500">Base Currency</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-white font-mono">
              {serverSettings?.baseCurrency || '—'}
            </dd>
            <dd className="text-[11px] text-slate-500">
              Symbol {serverSettings?.currencySymbol || companyProfile.currency}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold text-slate-500">Fiscal Year Start</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
              <CalendarRange className="w-3.5 h-3.5 text-slate-400" />
              {MONTHS[(serverSettings?.fiscalYearStartMonth || companyProfile.fiscalYearStartMonth || 1) - 1]}
            </dd>
            <dd className="text-[11px] text-slate-500">Configured on the server ledger.</dd>
          </div>
        </dl>

        <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300">
          <span className="flex items-start gap-2">
            <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
            The server PostgreSQL ledger is the system of record. Roles, permissions, period locks and the audit
            trail cannot be overridden from the browser.
          </span>
        </div>
      </section>

      {/* Browser working copy */}
      <section className="surface p-6 space-y-4">
        <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
          <h2 className="section-title flex items-center gap-2">
            <Download className="w-4 h-4 text-purple-600" />
            <span>Browser Working Copy</span>
          </h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            A convenience cache used for offline form state and quick comparison. It is not a backup of the
            server ledger, and restoring it does not repost any journal entry.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <button
            onClick={exportDataToJson}
            className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-blue-500 hover:bg-slate-50 dark:hover:bg-slate-850 flex flex-col items-center gap-2 text-center transition-colors"
          >
            <Download className="w-6 h-6 text-blue-600" />
            <span className="font-bold text-slate-900 dark:text-white">Download working copy</span>
            <span className="text-[11px] text-slate-500">JSON snapshot of this browser's cached lists</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-emerald-500 hover:bg-slate-50 dark:hover:bg-slate-850 flex flex-col items-center gap-2 text-center transition-colors"
          >
            <Upload className="w-6 h-6 text-emerald-600" />
            <span className="font-bold text-slate-900 dark:text-white">Restore working copy</span>
            <span className="text-[11px] text-slate-500">Reload a JSON snapshot into this browser</span>
          </button>

          <button
            onClick={() => {
              if (confirm('Reload the demonstration dataset into this browser cache? The server ledger is not changed.')) {
                resetToDemoData();
              }
            }}
            className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-amber-500 hover:bg-slate-50 dark:hover:bg-slate-850 flex flex-col items-center gap-2 text-center transition-colors"
          >
            <RefreshCw className="w-6 h-6 text-amber-600" />
            <span className="font-bold text-slate-900 dark:text-white">Reload demo data</span>
            <span className="text-[11px] text-slate-500">Populate demo lists in this browser only</span>
          </button>
        </div>

        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-bold text-rose-600 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              Clear browser working copy
            </div>
            <div className="text-[11px] text-slate-500">
              Removes cached lists and preferences from this browser. Server records, journals and attachments are
              untouched.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (confirm('Clear the browser working copy? Server ledger data will not be deleted.')) {
                clearAllData();
              }
            }}
            className="btn btn-danger"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear working copy</span>
          </button>
        </div>
      </section>

      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading company settings from the server…
        </div>
      )}
    </div>
  );
};
