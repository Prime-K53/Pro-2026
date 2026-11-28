import React, { useEffect, useRef, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { companyApi } from '../../services/companyApi';
import type { CompanySettings } from '../../services/companyApi';
import { accountingApi, type ApiAccount } from '../../services/accountingApi';
import {
  Button,
  EmptyState,
  ErrorState,
  InlineAlert,
  LoadingState,
  PageHeader,
  StatusBadge,
  Tabs,
} from '../common/ui';
import { appDialog, DESIGN_TOKENS } from '../../design-system';
import {
  AlertTriangle,
  Building2,
  CalendarRange,
  CheckCircle2,
  Download,
  FileText,
  Image as ImageIcon,
  Landmark,
  Layers,
  Loader2,
  Lock,
  Palette,
  Printer,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  Type,
  Upload,
} from 'lucide-react';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const PAYMENT_TERMS_OPTIONS = ['Due on Receipt', 'Net 15', 'Net 30', 'Net 60'];

type TabKey = 'legal' | 'branding' | 'financial' | 'documents' | 'data' | 'design';

const TABS: Array<{ key: TabKey; label: string; icon: React.ElementType }> = [
  { key: 'legal', label: 'Legal Entity', icon: Building2 },
  { key: 'branding', label: 'Branding', icon: Palette },
  { key: 'financial', label: 'Financial', icon: Landmark },
  { key: 'documents', label: 'Documents', icon: FileText },
  { key: 'data', label: 'Data', icon: Server },
  { key: 'design', label: 'Design System', icon: Layers },
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
  const logoInputRef = useRef<HTMLInputElement>(null);
  const signatureInputRef = useRef<HTMLInputElement>(null);
  const canEdit = hasPermission('companies:settings:write');

  const [activeTab, setActiveTab] = useState<TabKey>('legal');
  const [serverSettings, setServerSettings] = useState<CompanySettings | null>(null);
  const [bankAccounts, setBankAccounts] = useState<ApiAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Form state — all server-backed
  const [name, setName] = useState(companyProfile.name);
  const [legalName, setLegalName] = useState(companyProfile.legalName);
  const [ein, setEin] = useState(companyProfile.ein);
  const [address, setAddress] = useState(companyProfile.address || '');
  const [cityStateZip, setCityStateZip] = useState(companyProfile.cityStateZip || '');
  const [phone, setPhone] = useState(companyProfile.phone || '');
  const [email, setEmail] = useState(companyProfile.email || '');
  const [website, setWebsite] = useState(companyProfile.website || '');
  const [taxPercent, setTaxPercent] = useState(
    String(Math.round(companyProfile.salesTaxRate * 10000) / 100)
  );
  const [extraTypingPerPage, setExtraTypingPerPage] = useState(
    String(companyProfile.extraTypingFinishingPerPage ?? 0)
  );
  const [sellingPricePerSheet, setSellingPricePerSheet] = useState(
    String(companyProfile.manualSellingPricePerSheet ?? 0)
  );

  // Branding
  const [logoBase64, setLogoBase64] = useState('');
  const [signatureBase64, setSignatureBase64] = useState('');
  const [theme, setTheme] = useState<string>(companyProfile.theme || 'classic');

  // Financial
  const [roundingMode, setRoundingMode] = useState('HALF_EVEN');
  const [decimalPlaces, setDecimalPlaces] = useState('2');
  const [defaultBankAccountId, setDefaultBankAccountId] = useState('');
  const [defaultPaymentTerms, setDefaultPaymentTerms] = useState('Due on Receipt');

  // Documents
  const [documentFooter, setDocumentFooter] = useState('');
  const [invoiceNumberPrefix, setInvoiceNumberPrefix] = useState('');
  const [defaultTaxCode, setDefaultTaxCode] = useState('');

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
        setAddress(settings.address || '');
        setCityStateZip(settings.cityStateZip || '');
        setPhone(settings.phone || '');
        setEmail(settings.email || '');
        setWebsite(settings.website || '');
        setTaxPercent(String(settings.salesTaxRate));
        setExtraTypingPerPage(String(settings.extraTypingFinishingPerPage ?? 0));
        setSellingPricePerSheet(String(settings.manualSellingPricePerSheet ?? 0));
        setLogoBase64(settings.logoBase64 || '');
        setSignatureBase64(settings.signatureBase64 || '');
        setTheme(settings.theme || 'classic');
        setRoundingMode(settings.roundingMode || 'HALF_EVEN');
        setDecimalPlaces(String(settings.decimalPlaces ?? 2));
        setDefaultBankAccountId(settings.defaultBankAccountId || '');
        setDefaultPaymentTerms(settings.defaultPaymentTerms || 'Due on Receipt');
        setDocumentFooter(settings.documentFooter || '');
        setInvoiceNumberPrefix(settings.invoiceNumberPrefix || '');
        setDefaultTaxCode(settings.defaultTaxCode || '');
        updateCompanyProfile({
          name: settings.name,
          legalName: settings.legalName || settings.name,
          ein: settings.ein || '',
          address: settings.address || '',
          cityStateZip: settings.cityStateZip || '',
          phone: settings.phone || '',
          email: settings.email || '',
          website: settings.website || '',
          accountingMethod: settings.accountingMethod === 'cash' ? 'cash' : 'accrual',
          salesTaxRate: settings.salesTaxRate / 100,
          extraTypingFinishingPerPage: settings.extraTypingFinishingPerPage ?? 0,
          manualSellingPricePerSheet: settings.manualSellingPricePerSheet ?? 0,
          fiscalYearStartMonth: settings.fiscalYearStartMonth,
          currency: settings.currencySymbol || companyProfile.currency,
          theme: (settings.theme as any) || companyProfile.theme,
        });
        persistPdfConfig({
          name: settings.name,
          address: settings.address || '',
          cityStateZip: settings.cityStateZip || '',
          phone: settings.phone || '',
          email: settings.email || '',
          logoBase64: settings.logoBase64 || '',
          signatureBase64: settings.signatureBase64 || '',
          documentFooter: settings.documentFooter || '',
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

  // Load bank accounts for the default deposit account selector.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const accounts = await accountingApi.listAccounts(false);
        if (!cancelled) setBankAccounts(accounts.filter(a => (a as any).account_type === 'Bank' || (a as any).accountType === 'Bank'));
      } catch {
        // Non-fatal: selector simply stays empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });

  /**
   * Mirror the server-authoritative company branding/contact into the
   * localStorage key the PDF pipeline (getStoredCompanyConfig) reads, so
   * generated documents pick up the persisted logo, signature, address and
   * footer without an extra round-trip.
   */
  const persistPdfConfig = (s: {
    name: string; address: string; cityStateZip: string; phone: string; email: string;
    logoBase64: string; signatureBase64: string; documentFooter: string;
  }) => {
    try {
      const [city] = s.cityStateZip.split(',');
      localStorage.setItem(
        'nexus_company_config',
        JSON.stringify({
          companyName: s.name,
          addressLine1: s.address,
          city: (city || s.cityStateZip || '').trim(),
          country: '',
          phone: s.phone,
          email: s.email,
          logoBase64: s.logoBase64,
          signatureBase64: s.signatureBase64,
          footer: s.documentFooter,
          receiptFooter: s.documentFooter,
        })
      );
    } catch {
      // quota or private mode — PDF falls back to blank branding
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg)$/.test(file.type)) {
      setSaveError('Logo must be a PNG or JPEG image.');
      return;
    }
    try {
      setLogoBase64(await readFileAsDataUrl(file));
      setSaveError(null);
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to read logo');
    }
    if (e.target) e.target.value = '';
  };

  const handleSignatureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg)$/.test(file.type)) {
      setSaveError('Signature must be a PNG or JPEG image.');
      return;
    }
    try {
      setSignatureBase64(await readFileAsDataUrl(file));
      setSaveError(null);
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to read signature');
    }
    if (e.target) e.target.value = '';
  };

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
    const decimals = Number(decimalPlaces);
    if (!Number.isInteger(decimals) || decimals < 2 || decimals > 4) {
      setSaveError('Decimal places must be between 2 and 4.');
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
        address: address.trim(),
        cityStateZip: cityStateZip.trim(),
        phone: phone.trim(),
        email: email.trim(),
        website: website.trim(),
        salesTaxRate: percent,
        extraTypingFinishingPerPage: extraTyping,
        manualSellingPricePerSheet: sheetPrice,
        theme,
        roundingMode,
        decimalPlaces: decimals,
        defaultBankAccountId,
        defaultPaymentTerms,
        logoBase64,
        signatureBase64,
        documentFooter,
        invoiceNumberPrefix,
        defaultTaxCode,
      });
      updateCompanyProfile({
        name: res.company.name,
        legalName: res.company.legalName || res.company.name,
        ein: res.company.ein || '',
        address: res.company.address || '',
        cityStateZip: res.company.cityStateZip || '',
        phone: res.company.phone || '',
        email: res.company.email || '',
        website: res.company.website || '',
        salesTaxRate: res.company.salesTaxRate / 100,
        extraTypingFinishingPerPage: res.company.extraTypingFinishingPerPage ?? extraTyping,
        manualSellingPricePerSheet: res.company.manualSellingPricePerSheet ?? sheetPrice,
        theme: (res.company.theme as any) || theme,
      });
      setServerSettings(res.company);
      persistPdfConfig({
        name: res.company.name,
        address: res.company.address || '',
        cityStateZip: res.company.cityStateZip || '',
        phone: res.company.phone || '',
        email: res.company.email || '',
        logoBase64: res.company.logoBase64 || '',
        signatureBase64: res.company.signatureBase64 || '',
        documentFooter: res.company.documentFooter || '',
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

  const fieldClass = 'app-input';
  const disabled = !canEdit;

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto text-xs">
      <PageHeader
        title="Company Settings"
        subtitle="Legal identity, branding, financial defaults, document preferences, and unified design system standards. Changes are written to the server company record and captured in the audit trail."
        icon={<Building2 className="w-5 h-5" strokeWidth={1.75} />}
      />

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
      <input type="file" ref={logoInputRef} onChange={handleLogoUpload} accept="image/png,image/jpeg" className="hidden" />
      <input type="file" ref={signatureInputRef} onChange={handleSignatureUpload} accept="image/png,image/jpeg" className="hidden" />

      {/* Tab navigation */}
      <div role="tablist" aria-label="Company settings sections" className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-t-lg font-semibold transition-colors ${
                isActive
                  ? 'text-brand-700 dark:text-brand-300 border-b-2 border-brand-600 bg-brand-50/50 dark:bg-brand-950/20'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <form onSubmit={handleSaveCompany} className="surface p-6 space-y-5">
        {/* ===== LEGAL ENTITY ===== */}
        {activeTab === 'legal' && (
          <>
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="section-title flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-blue-600" />
                  <span>Legal Entity & Contact Information</span>
                </h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  These values appear on invoices, statements and tax reports issued by this company.
                </p>
              </div>
              <button type="submit" disabled={disabled || saving || loading} className="btn btn-primary">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>{saving ? 'Saving…' : 'Save to server'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="app-label">Company Display Name</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} className={fieldClass} disabled={disabled} required />
              </div>
              <div>
                <label className="app-label">Legal Entity Name</label>
                <input type="text" value={legalName} onChange={e => setLegalName(e.target.value)} className={fieldClass} disabled={disabled} required />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="app-label">Tax Identification (EIN / TPIN)</label>
                <input type="text" value={ein} onChange={e => setEin(e.target.value)} placeholder="XX-XXXXXXX" className="app-input app-input-mono" disabled={disabled} />
              </div>
              <div>
                <label className="app-label">Accounting Method</label>
                <input
                  type="text"
                  value={serverSettings ? (serverSettings.accountingMethod === 'cash' ? 'Cash basis' : 'Accrual basis') : companyProfile.accountingMethod === 'cash' ? 'Cash basis' : 'Accrual basis'}
                  className={fieldClass}
                  disabled
                  title="The accounting method is fixed by the company ledger configuration"
                />
              </div>
              <div>
                <label className="app-label">Default Currency</label>
                <input
                  type="text"
                  value={serverSettings ? `${serverSettings.currencySymbol} (${serverSettings.baseCurrency})` : companyProfile.currency}
                  className="app-input app-input-mono"
                  disabled
                  title="Currency is defined on the server company record"
                />
              </div>
              <div>
                <label className="app-label">Default Sales Tax Rate (%)</label>
                <input type="number" step="0.01" min="0" max="100" value={taxPercent} onChange={e => setTaxPercent(e.target.value)} className="app-input app-input-mono" disabled={disabled} />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="app-label">Street Address</label>
                <input type="text" value={address} onChange={e => setAddress(e.target.value)} className={fieldClass} disabled={disabled} placeholder="e.g. Along M5 Road, Mtakataka" />
              </div>
              <div>
                <label className="app-label">City / State / Zip</label>
                <input type="text" value={cityStateZip} onChange={e => setCityStateZip(e.target.value)} className={fieldClass} disabled={disabled} placeholder="e.g. Dedza, Malawi" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="app-label">Contact Phone</label>
                <input type="text" value={phone} onChange={e => setPhone(e.target.value)} className={fieldClass} disabled={disabled} />
              </div>
              <div>
                <label className="app-label">Accounting Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={fieldClass} disabled={disabled} />
              </div>
              <div>
                <label className="app-label">Website</label>
                <input type="text" value={website} onChange={e => setWebsite(e.target.value)} className={fieldClass} disabled={disabled} />
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              All contact and address fields are saved to the server company record and shared across every user in this
              company.
            </p>
          </>
        )}

        {/* ===== BRANDING ===== */}
        {activeTab === 'branding' && (
          <>
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="section-title flex items-center gap-2">
                <Palette className="w-4 h-4 text-pink-600" />
                <span>Branding & Appearance</span>
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Logo and signature appear on every printed document (invoices, contracts, statements). Theme controls the
                workspace colour scheme.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="app-label">Company Logo</label>
                <div className="flex items-center gap-3">
                  <div className="w-24 h-24 rounded-lg border border-slate-200 dark:border-slate-700 bg-white flex items-center justify-center overflow-hidden">
                    {logoBase64 ? (
                      <img src={logoBase64} alt="Company logo" className="max-w-full max-h-full object-contain" />
                    ) : (
                      <ImageIcon className="w-8 h-8 text-slate-300" />
                    )}
                  </div>
                  <div className="space-y-2">
                    <button type="button" onClick={() => logoInputRef.current?.click()} disabled={disabled} className="btn btn-secondary">
                      <Upload className="w-3.5 h-3.5" /> Upload
                    </button>
                    {logoBase64 && (
                      <button type="button" onClick={() => setLogoBase64('')} disabled={disabled} className="btn btn-danger">
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">PNG or JPEG. Used on all PDF documents.</p>
              </div>

              <div>
                <label className="app-label">Authorised Signature</label>
                <div className="flex items-center gap-3">
                  <div className="w-24 h-24 rounded-lg border border-slate-200 dark:border-slate-700 bg-white flex items-center justify-center overflow-hidden">
                    {signatureBase64 ? (
                      <img src={signatureBase64} alt="Authorised signature" className="max-w-full max-h-full object-contain" />
                    ) : (
                      <ImageIcon className="w-8 h-8 text-slate-300" />
                    )}
                  </div>
                  <div className="space-y-2">
                    <button type="button" onClick={() => signatureInputRef.current?.click()} disabled={disabled} className="btn btn-secondary">
                      <Upload className="w-3.5 h-3.5" /> Upload
                    </button>
                    {signatureBase64 && (
                      <button type="button" onClick={() => setSignatureBase64('')} disabled={disabled} className="btn btn-danger">
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">PNG or JPEG. Printed on contracts and completion receipts.</p>
              </div>
            </div>

            <div className="max-w-xs">
              <label className="app-label">Workspace Theme</label>
              <select value={theme} onChange={e => setTheme(e.target.value)} className={fieldClass} disabled={disabled}>
                <option value="classic">Classic</option>
                <option value="slate">Slate</option>
                <option value="midnight">Midnight</option>
              </select>
              <p className="text-[11px] text-slate-500 mt-1">Saved to the server and shared across users.</p>
            </div>
          </>
        )}

        {/* ===== FINANCIAL ===== */}
        {activeTab === 'financial' && (
          <>
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="section-title flex items-center gap-2">
                <Landmark className="w-4 h-4 text-emerald-600" />
                <span>Financial Defaults</span>
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Precision, deposit account and payment terms applied across accounting and printing documents.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="app-label">Rounding Mode</label>
                <select value={roundingMode} onChange={e => setRoundingMode(e.target.value)} className={fieldClass} disabled={disabled}>
                  <option value="HALF_EVEN">Half Even (banker's)</option>
                  <option value="HALF_UP">Half Up</option>
                </select>
              </div>
              <div>
                <label className="app-label">Decimal Places</label>
                <select value={decimalPlaces} onChange={e => setDecimalPlaces(e.target.value)} className={fieldClass} disabled={disabled}>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </select>
              </div>
              <div>
                <label className="app-label">Default Payment Terms</label>
                <select value={defaultPaymentTerms} onChange={e => setDefaultPaymentTerms(e.target.value)} className={fieldClass} disabled={disabled}>
                  {PAYMENT_TERMS_OPTIONS.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="max-w-md">
              <label className="app-label">Default Deposit Account</label>
              <select value={defaultBankAccountId} onChange={e => setDefaultBankAccountId(e.target.value)} className={fieldClass} disabled={disabled}>
                <option value="">— None —</option>
                {bankAccounts.map(a => (
                  <option key={a.id} value={String(a.id)}>
                    {a.code ? `${a.code} · ` : ''}{a.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 mt-1">Bank account used by default for deposits and payment receipts.</p>
            </div>

            <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Printer className="w-4 h-4 text-purple-600" />
                  <span>Print Desk Pricing Defaults</span>
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  The only place these desk rates are set. The Quick Photocopy desk and the print job forms read them
                  automatically, so every operator quotes the same price.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="app-label">Extra Typing / Finishing per Page ({companyProfile.currency})</label>
                  <input type="number" step="0.01" min="0" value={extraTypingPerPage} onChange={e => setExtraTypingPerPage(e.target.value)} className="app-input app-input-mono" disabled={disabled} />
                  <p className="text-[11px] text-slate-500 mt-1">Applied per document page for Type &amp; Print jobs only.</p>
                </div>
                <div>
                  <label className="app-label">Manual Selling Price per Sheet ({companyProfile.currency})</label>
                  <input type="number" step="0.01" min="0" value={sellingPricePerSheet} onChange={e => setSellingPricePerSheet(e.target.value)} className="app-input app-input-mono" disabled={disabled} />
                  <p className="text-[11px] text-slate-500 mt-1">Selling rate multiplied by sheets used (duplex-aware).</p>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ===== DOCUMENTS ===== */}
        {activeTab === 'documents' && (
          <>
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="section-title flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-600" />
                <span>Document Defaults</span>
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Footer text, numbering prefix and default tax code applied to generated documents.
              </p>
            </div>

            <div className="max-w-2xl">
              <label className="app-label">Document Footer Text</label>
              <textarea
                value={documentFooter}
                onChange={e => setDocumentFooter(e.target.value)}
                className="app-input min-h-[72px]"
                disabled={disabled}
                placeholder="e.g. This is a computer-generated document. Scan QR Code to Verify. For enquiries contact +265 992 528 222"
              />
              <p className="text-[11px] text-slate-500 mt-1">Printed at the foot of every page on invoices, receipts and statements.</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="app-label">Invoice Number Prefix</label>
                <input type="text" value={invoiceNumberPrefix} onChange={e => setInvoiceNumberPrefix(e.target.value)} className="app-input app-input-mono" disabled={disabled} placeholder="e.g. INV" />
                <p className="text-[11px] text-slate-500 mt-1">Prepended to generated invoice numbers.</p>
              </div>
              <div>
                <label className="app-label">Default Tax Code</label>
                <input type="text" value={defaultTaxCode} onChange={e => setDefaultTaxCode(e.target.value)} className="app-input app-input-mono" disabled={disabled} placeholder="e.g. VAT16" />
                <p className="text-[11px] text-slate-500 mt-1">Applied to new invoices and bills by default.</p>
              </div>
            </div>
          </>
        )}

        {/* ===== DATA ===== */}
        {activeTab === 'data' && (
          <>
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="section-title flex items-center gap-2">
                <Server className="w-4 h-4 text-purple-600" />
                <span>Browser Working Copy</span>
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                A convenience cache used for offline form state and quick comparison. It is not a backup of the server
                ledger, and restoring it does not repost any journal entry.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <button type="button" onClick={exportDataToJson} className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-blue-500 hover:bg-slate-50 dark:hover:bg-slate-850 flex flex-col items-center gap-2 text-center transition-colors">
                <Download className="w-6 h-6 text-blue-600" />
                <span className="font-bold text-slate-900 dark:text-white">Download working copy</span>
                <span className="text-[11px] text-slate-500">JSON snapshot of this browser's cached lists</span>
              </button>

              <button type="button" onClick={() => fileInputRef.current?.click()} className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-emerald-500 hover:bg-slate-50 dark:hover:bg-slate-850 flex flex-col items-center gap-2 text-center transition-colors">
                <Upload className="w-6 h-6 text-emerald-600" />
                <span className="font-bold text-slate-900 dark:text-white">Restore working copy</span>
                <span className="text-[11px] text-slate-500">Reload a JSON snapshot into this browser</span>
              </button>

              {import.meta.env.DEV && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await appDialog.confirm({
                      title: 'Reload Demo Data',
                      message: 'Reload the demonstration dataset into this browser cache? The server ledger is not changed.',
                      confirmLabel: 'Reload Demo Data',
                      tone: 'amber',
                    });
                    if (ok) resetToDemoData();
                  }}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-amber-500 hover:bg-slate-50 dark:hover:bg-slate-850 flex flex-col items-center gap-2 text-center transition-colors"
                >
                  <RefreshCw className="w-6 h-6 text-amber-600" strokeWidth={1.75} />
                  <span className="font-bold text-slate-900 dark:text-white">Reload demo data</span>
                  <span className="text-[11px] text-slate-600 dark:text-slate-400">Populate demo lists in this browser only (dev-only)</span>
                </button>
              )}
            </div>

            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-bold text-rose-600 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" strokeWidth={1.75} />
                  Clear browser working copy
                </div>
                <div className="text-[11px] text-slate-600 dark:text-slate-400">
                  Removes cached lists and preferences from this browser. Server records, journals and attachments are untouched.
                </div>
              </div>
              <Button
                type="button"
                variant="danger"
                icon={<Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />}
                onClick={async () => {
                  const ok = await appDialog.confirm({
                    title: 'Clear Browser Working Copy',
                    message: 'Clear the browser working copy? Server ledger data will not be deleted.',
                    confirmLabel: 'Clear Working Copy',
                    destructive: true,
                  });
                  if (ok) clearAllData();
                }}
              >
                Clear working copy
              </Button>
            </div>
          </>
        )}

        {/* ===== DESIGN SYSTEM & STANDARDS (01-10) ===== */}
        {activeTab === 'design' && (
          <div className="space-y-6">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="section-title flex items-center gap-2">
                  <Layers className="w-4 h-4 text-brand-600" strokeWidth={1.75} />
                  <span>Design System &amp; UI Standards (v{DESIGN_TOKENS.version})</span>
                </h2>
                <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
                  Unified visual consistency, typographic hierarchy, AA color contrast, 4px spacing scale,
                  standardized components, Lucide iconography, responsive adaptation, accessibility, UI states, and tokens.
                </p>
              </div>
              <StatusBadge tone="info" showIcon>10 Standards Active</StatusBadge>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {[
                { num: '01', name: 'Visual Consistency', detail: 'Unified surfaces, chrome & 3 themes' },
                { num: '02', name: 'Typography', detail: 'Plus Jakarta Sans · DM Serif · JetBrains Mono' },
                { num: '03', name: 'Color', detail: 'AA >=4.9:1 brand & icon-paired semantics' },
                { num: '04', name: 'Spacing & Layout', detail: '4px base grid & flat 1px borders' },
                { num: '05', name: 'Components', detail: 'Standard Buttons, Inputs, Tabs & Dialogs' },
                { num: '06', name: 'Iconography', detail: 'Lucide 1.75px stroke, xs–xl scale' },
                { num: '07', name: 'Responsive UI', detail: 'Mobile drawer, scroll tables & 44px touch' },
                { num: '08', name: 'Accessibility', detail: 'Skip link, focus trap & reduced motion' },
                { num: '09', name: 'UI States', detail: 'Loading, Empty, Error, Success & Disabled' },
                { num: '10', name: 'Design System', detail: 'Canonical DESIGN_TOKENS & primitives' },
              ].map(std => (
                <div key={std.num} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 bg-slate-50/60 dark:bg-white/[0.02]">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-[11px] font-bold text-brand-700 dark:text-brand-300">{std.num}</span>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} aria-hidden="true" />
                  </div>
                  <div className="mt-1 font-semibold text-slate-900 dark:text-white">{std.name}</div>
                  <div className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400 leading-snug">{std.detail}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3">
                <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
                  <Type className="w-4 h-4 text-brand-600" strokeWidth={1.75} />
                  <span>Typography &amp; Tabular Numerals</span>
                </div>
                <div className="space-y-1.5">
                  <div style={{ fontFamily: DESIGN_TOKENS.typography.fontFamily.display }} className="text-xl text-slate-900 dark:text-white">
                    Display Serif Headline
                  </div>
                  <div className="page-title">Page Title — 22px Semibold/Bold</div>
                  <div className="section-title">Section Title — 15px Bold</div>
                  <div className="text-[13px] text-slate-700 dark:text-slate-300">Body Copy — 13px Plus Jakarta Sans for dense operational tables.</div>
                  <div className="font-mono tabular-nums text-[13px] font-semibold text-slate-900 dark:text-white">
                    {companyProfile.currency} 1,248,500.00 · INV-2026-0042
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3">
                <div className="font-semibold text-slate-900 dark:text-white">Semantic Status &amp; Button Hierarchy</div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge tone="neutral">Draft</StatusBadge>
                  <StatusBadge tone="info" showIcon>In Transit</StatusBadge>
                  <StatusBadge tone="success" showIcon>Posted / Paid</StatusBadge>
                  <StatusBadge tone="warning" showIcon>Pending Review</StatusBadge>
                  <StatusBadge tone="danger" showIcon>Overdue</StatusBadge>
                  <StatusBadge tone="purple" showIcon>Approved</StatusBadge>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button variant="primary" size="sm">Primary</Button>
                  <Button variant="secondary" size="sm">Secondary</Button>
                  <Button variant="emerald" size="sm">Confirm</Button>
                  <Button variant="danger" size="sm">Void</Button>
                  <Button variant="ghost" size="sm">Ghost</Button>
                  <Button variant="primary" size="sm" disabled>Disabled</Button>
                </div>
                <div className="pt-1">
                  <Tabs
                    ariaLabel="Preview tabs"
                    value="loading"
                    onChange={() => {}}
                    tabs={[
                      { id: 'loading', label: 'Interactive Tab', badge: 3 },
                      { id: 'empty', label: 'Secondary Tab' },
                    ]}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-lg border border-slate-200 dark:border-slate-800">
                <LoadingState label="Standardized loading state" rows={2} />
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800">
                <EmptyState title="Empty state" description="Clear next step guidance when no records match." />
              </div>
              <ErrorState
                title="Recoverable error state"
                message="Non-blocking error feedback with retry action."
                onRetry={() => triggerShortcutNotice('Retry action triggered')}
              />
            </div>
          </div>
        )}
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
            <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{activeCompany?.name || companyProfile.name}</dd>
            <dd className="text-[11px] text-slate-500 font-mono">{serverSettings?.slug || '—'}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold text-slate-500">Your Role</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{activeCompany?.role || serverSettings?.role || companyProfile.currentUserRole}</dd>
            <dd className="text-[11px] text-slate-500">Company membership is re-verified per request.</dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold text-slate-500">Base Currency</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-white font-mono">{serverSettings?.baseCurrency || '—'}</dd>
            <dd className="text-[11px] text-slate-500">Symbol {serverSettings?.currencySymbol || companyProfile.currency}</dd>
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
            The server PostgreSQL ledger is the system of record. Roles, permissions, period locks and the audit trail cannot be overridden from the browser.
          </span>
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