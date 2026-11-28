import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT, accountingApi, ApiAccount } from '../../services/accountingApi';
import { commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
import {
  Printer,
  Loader2,
  Percent,
  Save,
} from 'lucide-react';
import { appDialog } from '../../design-system';
import { Button, InlineAlert, MetricTile, PageHeader, PageShell, Tabs } from '../common/ui';

type TaxForm = 'salesTax' | 'payeQuarter' | 'payeAnnual' | 'p45' | 'contractor';

/**
 * Statutory tax summaries.
 *
 * The Sales & Use Tax (VAT) tab is live — it aggregates the general ledger.
 * The remaining tabs are DRAFT working papers computed from the payroll and
 * purchase ledgers (pay runs, pay stubs, bills and bill payments). They are
 * clearly labelled as drafts: they are not filed returns, carry no
 * cryptographic seal, and must be reviewed by a qualified accountant before
 * any submission to the Malawi Revenue Authority.
 */
export const TaxFormsView: React.FC = () => {
  const {
    companyProfile,
    employees,
    payrollRuns,
    vendors,
    bills,
    billPayments,
  } = useAccounting();
  const { activeCompany, hasPermission } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canWriteTax = hasPermission('tax:write');

  const [activeForm, setActiveForm] = useState<TaxForm>('salesTax');
  const [startDate, setStartDate] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-01-01`;
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [taxSummary, setTaxSummary] = useState<any | null>(null);
  const [accounts, setAccounts] = useState<ApiAccount[]>([]);
  const [taxLoading, setTaxLoading] = useState(false);
  const [taxError, setTaxError] = useState<string | null>(null);
  const [taxNotice, setTaxNotice] = useState<string | null>(null);

  const [mapAccountId, setMapAccountId] = useState<number>(0);
  const [mapTaxLine, setMapTaxLine] = useState<string>('output_vat_standard');
  const [savingMap, setSavingMap] = useState(false);
  const [filingPeriods, setFilingPeriods] = useState<any[]>([]);
  const [taxMappings, setTaxMappings] = useState<any[]>([]);

  const loadSalesTax = useCallback(async () => {
    setTaxLoading(true);
    setTaxError(null);
    try {
      const [summary, accts, periods, mappings] = await Promise.all([
        commercialApi.getTaxSummary(startDate, endDate),
        accountingApi.listAccounts(),
        commercialApi.listTaxFilingPeriods().catch(() => []),
        commercialApi.listTaxAccountMappings().catch(() => []),
      ]);
      setTaxSummary(summary);
      setAccounts(accts);
      setFilingPeriods(periods);
      setTaxMappings(mappings);
      setMapAccountId(prev => prev || accts[0]?.id || 0);
    } catch (err: any) {
      setTaxError(err?.message || 'Unable to load sales & use tax summary');
    } finally {
      setTaxLoading(false);
    }
  }, [startDate, endDate, activeCompany?.id]);

  useEffect(() => {
    if (activeForm === 'salesTax') {
      loadSalesTax();
    }
  }, [activeForm, loadSalesTax]);

  useEffect(() => {
    const handler = () => {
      if (activeForm === 'salesTax') loadSalesTax();
    };
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, [activeForm, loadSalesTax]);

  const handleSaveTaxMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mapAccountId || !mapTaxLine.trim()) return;
    setSavingMap(true);
    setTaxError(null);
    setTaxNotice(null);
    try {
      await commercialApi.upsertTaxMapping(mapAccountId, mapTaxLine.trim());
      setTaxNotice('Tax category mapping saved.');
      await loadSalesTax();
    } catch (err: any) {
      setTaxError(err?.message || 'Failed to save tax mapping');
    } finally {
      setSavingMap(false);
    }
  };

  const [selectedEmpId, setSelectedEmpId] = useState<string>(employees[0]?.id || '');
  const [selectedVendorId, setSelectedVendorId] = useState<string>(vendors[0]?.id || '');

  // Payroll runs within the selected period (inclusive).
  const runsInRange = payrollRuns.filter(
    r => r.payDate >= startDate && r.payDate <= endDate
  );

  const sumItems = (pick: (it: PayrollRunsItem) => number) =>
    runsInRange.reduce(
      (sum, r) => sum + r.items.reduce((s, it) => s + pick(it), 0),
      0
    );

  const totalEmployees = new Set(
    runsInRange.flatMap(r => r.items.map(it => it.employeeId))
  ).size;
  const totalWages = sumItems(it => it.grossPay);
  const totalPaye = sumItems(it => it.fit);
  const totalPensionEmployee = sumItems(it => it.socialSecurityEmployee);
  const totalPensionEmployer = sumItems(it => it.socialSecurityEmployer);
  const totalOtherDeductions = sumItems(it => it.sit);
  const totalEmployerOther = sumItems(it => it.medicareEmployer);
  const totalNetPay = sumItems(it => it.netPay);
  const totalEmployeeDeductions =
    totalPaye + totalPensionEmployee + totalOtherDeductions;

  const selectedEmp = employees.find(e => e.id === selectedEmpId) || employees[0];
  const empItems = runsInRange
    .flatMap(r => r.items)
    .filter(it => it.employeeId === selectedEmp?.id);
  const empTotals = empItems.reduce(
    (acc, it) => ({
      wages: acc.wages + it.grossPay,
      paye: acc.paye + it.fit,
      pension: acc.pension + it.socialSecurityEmployee,
      other: acc.other + it.sit,
      net: acc.net + it.netPay,
    }),
    { wages: 0, paye: 0, pension: 0, other: 0, net: 0 }
  );

  const selectedVendor = vendors.find(v => v.id === selectedVendorId) || vendors[0];
  const vendorDisbursements =
    billPayments
      .filter(bp => bp.vendorId === selectedVendor?.id)
      .reduce((sum, bp) => sum + bp.amount, 0) ||
    bills
      .filter(b => b.vendorId === selectedVendor?.id && b.status === 'paid')
      .reduce((sum, b) => sum + b.total, 0);

  const periodLabel = `${startDate} → ${endDate}`;

  return (
    <PageShell>
      <PageHeader
        title="Statutory Tax Summaries"
        subtitle="VAT return aggregated live from the general ledger. PAYE, P45 and contractor statements are draft summaries computed from the payroll and purchase ledgers."
        icon={<Percent className="w-5 h-5" strokeWidth={1.75} />}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => window.print()}
            icon={<Printer className="w-3.5 h-3.5" />}
          >
            Print Active Summary
          </Button>
        }
      />

      {/* Draft disclaimer */}
      <InlineAlert tone="warning">
        <span>
          <strong>Draft working papers.</strong> Except for the live VAT return, these
          summaries are computed from recorded payroll and purchase transactions. They are
          not filed returns, carry no cryptographic seal, and must be reviewed by a
          qualified accountant before submission to the Malawi Revenue Authority.
        </span>
      </InlineAlert>

      {/* Shared period selector */}
      <div className="surface p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="font-semibold text-slate-600 dark:text-slate-300">Period From:</label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="app-input app-input-mono !w-auto !py-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="font-semibold text-slate-600 dark:text-slate-300">To:</label>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="app-input app-input-mono !w-auto !py-1"
            />
          </div>
        </div>
        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
          Company:{' '}
          <strong className="text-slate-800 dark:text-slate-200">
            {activeCompany?.name || companyProfile.legalName}
          </strong>
        </div>
      </div>

      {/* Forms Nav Tabs */}
      <Tabs
        ariaLabel="Tax summary forms"
        value={activeForm}
        onChange={(id) => setActiveForm(id as TaxForm)}
        tabs={[
          { id: 'salesTax', label: 'Sales & Use Tax Return (VAT)', icon: <Percent className="w-3.5 h-3.5" /> },
          { id: 'payeQuarter', label: 'PAYE Summary (Period)' },
          { id: 'payeAnnual', label: 'Annual PAYE Reconciliation' },
          { id: 'p45', label: 'Employee P45 (Draft)' },
          { id: 'contractor', label: 'Contractor Statement (Draft)' },
        ]}
      />

      {/* LIVE SALES & USE TAX RETURN (VAT) */}
      {activeForm === 'salesTax' && (
        <div className="space-y-4">
          {taxError && (
            <InlineAlert tone="error" onDismiss={() => setTaxError(null)}>
              {taxError}
            </InlineAlert>
          )}
          {taxNotice && (
            <InlineAlert tone="success" onDismiss={() => setTaxNotice(null)}>
              {taxNotice}
            </InlineAlert>
          )}

          {taxLoading ? (
            <div className="surface p-10 flex items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Aggregating VAT, credit memo reversals, and purchase use tax from GL...</span>
            </div>
          ) : taxSummary ? (
            <div className="space-y-4">
              {/* KPI Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <MetricTile
                  label={`Gross Sales (${taxSummary.invoiceCount} docs)`}
                  value={formatCurrency(Number(taxSummary.grossSales || 0), currency)}
                  hint={`Taxable: ${formatCurrency(Number(taxSummary.taxableSales || 0), currency)} · Exempt: ${formatCurrency(Number(taxSummary.exemptSales || 0), currency)}`}
                />
                <MetricTile
                  label="Output VAT Collected"
                  value={formatCurrency(Number(taxSummary.outputVatCollected || 0), currency)}
                  tone="blue"
                  hint={`Less Credit Memos: -${formatCurrency(Number(taxSummary.creditMemoVatReversed || 0), currency)}`}
                />
                <MetricTile
                  label="Purchase Use Tax Accrued"
                  value={formatCurrency(Number(taxSummary.purchaseUseTaxAccrued || 0), currency)}
                  tone="amber"
                  hint="Accrued on vendor bills"
                />
                <MetricTile
                  label="Net Tax Payable (Period)"
                  value={formatCurrency(Number(taxSummary.netTaxPayableForPeriod || 0), currency)}
                  tone="emerald"
                  hint={`GL 2200 Balance: ${formatCurrency(Number(taxSummary.glTaxLiabilityBalance || 0), currency)}`}
                />
              </div>

              {/* Tax Category Mappings */}
              <div className="surface overflow-hidden">
                <div className="surface-header flex-wrap gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">GL Account Tax Line Mappings</h3>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Maps Chart of Accounts lines to statutory tax reporting schedules.</p>
                  </div>
                  {canWriteTax && (
                    <form onSubmit={handleSaveTaxMapping} className="flex flex-wrap items-center gap-2 text-xs">
                      <select
                        value={mapAccountId}
                        onChange={e => setMapAccountId(Number(e.target.value))}
                        className="app-input !w-auto !py-1.5"
                      >
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>
                            {a.code ? `${a.code} - ` : ''}{a.name} ({a.account_type})
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={mapTaxLine}
                        onChange={e => setMapTaxLine(e.target.value)}
                        placeholder="Tax schedule line (e.g. output_vat_standard)"
                        className="app-input app-input-mono !w-52 !py-1.5"
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        loading={savingMap}
                        icon={<Save className="w-3.5 h-3.5" />}
                      >
                        Save Mapping
                      </Button>
                    </form>
                  )}
                </div>
                <table className="data-table w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th>Account Code</th>
                      <th>Account Name</th>
                      <th>Type</th>
                      <th>Statutory Tax Line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(!taxSummary.mappings || taxSummary.mappings.length === 0) ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                          No custom tax category mappings configured yet. Output VAT defaults to account 2200.
                        </td>
                      </tr>
                    ) : (
                      taxSummary.mappings.map((m: any) => (
                        <tr key={m.id}>
                          <td className="font-mono font-semibold">{m.account_code || m.accountCode || '—'}</td>
                          <td className="font-semibold">{m.account_name || m.accountName}</td>
                          <td className="text-slate-500">{m.account_type || m.accountType}</td>
                          <td className="font-mono text-brand-700 dark:text-brand-300">{m.tax_line || m.taxLine}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="surface p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">Tax Compliance Controls</h3>
              <button type="button" className="btn btn-secondary btn-sm" onClick={async () => {
                const jurisdiction = await appDialog.prompt({
                  title: 'Add Tax Filing Period',
                  message: 'Enter the tax authority or jurisdiction code.',
                  label: 'Jurisdiction',
                  defaultValue: 'ZRA',
                  required: true,
                });
                if (!jurisdiction) return;
                const periodStart = await appDialog.prompt({
                  title: 'Filing Period Start',
                  message: 'Select the start date for this statutory filing period.',
                  label: 'Period start',
                  defaultValue: startDate,
                  inputType: 'date',
                  required: true,
                });
                if (!periodStart) return;
                const periodEnd = await appDialog.prompt({
                  title: 'Filing Period End',
                  message: 'Select the end date for this statutory filing period.',
                  label: 'Period end',
                  defaultValue: endDate,
                  inputType: 'date',
                  required: true,
                });
                if (!periodEnd) return;
                await commercialApi.upsertTaxFilingPeriod({ jurisdiction, periodStart, periodEnd, status: 'open' });
                setFilingPeriods(await commercialApi.listTaxFilingPeriods().catch(() => []));
                setTaxNotice(`Added ${jurisdiction} filing period (${periodStart} → ${periodEnd}).`);
              }}>Add Filing Period</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs"><thead className="text-[10px] uppercase text-slate-500"><tr><th className="py-1">Jurisdiction</th><th>Period</th><th>Status</th><th>Due</th><th className="text-right">Action</th></tr></thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">{filingPeriods.length === 0 ? <tr><td colSpan={5} className="py-3 text-slate-400">No filing periods.</td></tr> : filingPeriods.map((p: any) => (
                  <tr key={p.id}><td className="py-1">{p.jurisdiction}</td><td className="font-mono">{p.period_start || p.periodStart} → {p.period_end || p.periodEnd}</td><td>{p.status}</td><td className="font-mono">{p.due_date || p.dueDate || '-'}</td><td className="text-right">{p.status !== 'filed' && <button className="text-[11px] text-brand underline" onClick={async () => { await commercialApi.fileTaxFilingPeriod(Number(p.id), `FILE-${p.id}`); setFilingPeriods(await commercialApi.listTaxFilingPeriods().catch(() => [])); }}>Mark Filed</button>}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <div className="text-[11px] text-slate-500">Account mappings configured: {taxMappings.length}</div>
          </div>
        </div>
      )}

      {/* PAYE SUMMARY (PERIOD) */}
      {activeForm === 'payeQuarter' && (
        <div className="bg-white text-slate-950 rounded-xl border-2 border-slate-400 shadow-lg p-8 space-y-6 text-xs font-sans">
          <div className="flex justify-between items-start border-b-2 border-slate-900 pb-4">
            <div>
              <div className="text-xl font-black text-slate-900">PAYE Summary — {periodLabel}</div>
              <div className="text-xs font-bold text-slate-600">
                Pay As You Earn (PAYE) and statutory deductions for the selected period
              </div>
            </div>
            <div className="text-right font-mono text-xs">
              <div className="text-[10px] uppercase font-bold text-slate-500">Employer</div>
              <div className="font-bold">{companyProfile.legalName}</div>
              <div className="text-slate-600">TPIN: {companyProfile.ein}</div>
            </div>
          </div>

          <div className="space-y-3 font-mono">
            <Row label="1. Employees paid in period" value={String(totalEmployees)} />
            <Row label="2. Gross wages" value={formatCurrency(totalWages, currency)} />
            <Row label="3. PAYE withheld from employees" value={formatCurrency(totalPaye, currency)} />
            <Row label="4. Employee pension (deducted)" value={formatCurrency(totalPensionEmployee, currency)} />
            <Row label="5. Other employee deductions" value={formatCurrency(totalOtherDeductions, currency)} />
            <Row
              label="6. Total employee deductions (3 + 4 + 5)"
              value={formatCurrency(totalEmployeeDeductions, currency)}
            />
            <Row label="7. Net pay to employees" value={formatCurrency(totalNetPay, currency)} highlight />
            <div className="border-t pt-3">
              <div className="text-[10px] uppercase font-bold text-slate-500 mb-1">
                Employer contributions (informational)
              </div>
              <Row label="8. Employer pension contribution" value={formatCurrency(totalPensionEmployer, currency)} />
              <Row label="9. Other employer statutory costs" value={formatCurrency(totalEmployerOther, currency)} />
            </div>
          </div>

          <div className="p-3 bg-slate-50 border rounded-lg text-[11px] text-slate-600">
            Draft computed from {runsInRange.length} payroll run(s). Reconcile to the PAYE
            liability account (2100) before filing.
          </div>
        </div>
      )}

      {/* ANNUAL PAYE RECONCILIATION */}
      {activeForm === 'payeAnnual' && (
        <div className="bg-white text-slate-950 rounded-xl border-2 border-slate-400 shadow-lg p-8 space-y-6 text-xs font-sans">
          <div className="flex justify-between items-start border-b-2 border-slate-900 pb-4">
            <div>
              <div className="text-xl font-black text-slate-900">Annual PAYE Reconciliation — {periodLabel}</div>
              <div className="text-xs font-bold text-slate-600">
                Full-period reconciliation of gross pay, PAYE, pension and net disbursements
              </div>
            </div>
            <div className="text-right font-mono font-bold">TPIN: {companyProfile.ein}</div>
          </div>

          <div className="space-y-3 font-mono">
            <Row label="Total gross wages" value={formatCurrency(totalWages, currency)} />
            <Row label="Total PAYE withheld" value={formatCurrency(totalPaye, currency)} />
            <Row label="Total employee pension" value={formatCurrency(totalPensionEmployee, currency)} />
            <Row label="Total other deductions" value={formatCurrency(totalOtherDeductions, currency)} />
            <Row label="Total employer pension" value={formatCurrency(totalPensionEmployer, currency)} />
            <Row
              label="Total deductions & contributions"
              value={formatCurrency(
                totalPaye + totalPensionEmployee + totalOtherDeductions + totalPensionEmployer + totalEmployerOther,
                currency
              )}
            />
            <Row label="Net pay disbursed" value={formatCurrency(totalNetPay, currency)} highlight />
          </div>

          <div className="p-3 bg-slate-50 border rounded-lg text-[11px] text-slate-600">
            Draft computed from {runsInRange.length} payroll run(s). Verify against the payroll
            liability accounts before the annual ZRA filing.
          </div>
        </div>
      )}

      {/* EMPLOYEE P45 (DRAFT) */}
      {activeForm === 'p45' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Select Employee:
            </label>
            <select
              value={selectedEmpId}
              onChange={e => setSelectedEmpId(e.target.value)}
              className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-3 py-1.5 text-xs font-semibold"
            >
              {employees.map(e => (
                <option key={e.id} value={e.id}>
                  {e.firstName} {e.lastName}
                  {e.ssnMasked ? ` (${e.ssnMasked})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="bg-white text-slate-950 rounded-xl border-2 border-slate-900 shadow-lg p-6 space-y-4 text-xs font-sans">
            <div className="flex justify-between items-center border-b pb-2">
              <span className="font-black text-lg">P45 — Employee Leaving Summary (Draft)</span>
              <span className="font-bold text-slate-600">Period: {periodLabel}</span>
            </div>

            <div className="grid grid-cols-12 border border-slate-800">
              <div className="col-span-6 p-2 border-r border-b border-slate-800">
                <span className="text-[10px] font-bold uppercase text-slate-500">Employee</span>
                <div className="font-mono font-bold text-sm mt-1">
                  {selectedEmp ? `${selectedEmp.firstName} ${selectedEmp.lastName}` : '—'}
                </div>
                <div className="text-slate-600">{selectedEmp?.title || ''}</div>
              </div>
              <div className="col-span-6 p-2 border-b border-slate-800">
                <span className="text-[10px] font-bold uppercase text-slate-500">Employer TPIN</span>
                <div className="font-mono font-bold text-sm mt-1">{companyProfile.ein}</div>
              </div>

              <div className="col-span-3 p-2 border-r border-b border-slate-800 bg-slate-50 font-mono">
                <span className="text-[10px] font-bold uppercase text-slate-500">Gross wages</span>
                <div className="font-bold text-sm mt-1">{formatCurrency(empTotals.wages, currency)}</div>
              </div>
              <div className="col-span-3 p-2 border-r border-b border-slate-800 bg-slate-50 font-mono">
                <span className="text-[10px] font-bold uppercase text-slate-500">PAYE withheld</span>
                <div className="font-bold text-sm mt-1">{formatCurrency(empTotals.paye, currency)}</div>
              </div>
              <div className="col-span-3 p-2 border-r border-b border-slate-800 bg-slate-50 font-mono">
                <span className="text-[10px] font-bold uppercase text-slate-500">Employee pension</span>
                <div className="font-bold text-sm mt-1">{formatCurrency(empTotals.pension, currency)}</div>
              </div>
              <div className="col-span-3 p-2 border-b border-slate-800 bg-slate-50 font-mono">
                <span className="text-[10px] font-bold uppercase text-slate-500">Other deductions</span>
                <div className="font-bold text-sm mt-1">{formatCurrency(empTotals.other, currency)}</div>
              </div>

              <div className="col-span-6 p-2 border-r border-slate-800">
                <span className="text-[10px] font-bold uppercase text-slate-500">Employer</span>
                <div className="font-bold mt-1">{companyProfile.legalName}</div>
                <div className="text-[11px] text-slate-600">
                  {[companyProfile.address, companyProfile.cityStateZip].filter(Boolean).join(', ')}
                </div>
              </div>
              <div className="col-span-6 p-2 bg-emerald-50 font-mono">
                <span className="text-[10px] font-bold uppercase text-emerald-800">Net pay</span>
                <div className="font-black text-base mt-1 text-emerald-800">
                  {formatCurrency(empTotals.net, currency)}
                </div>
              </div>
            </div>

            <div className="text-[11px] text-slate-500">
              Draft — computed from {runsInRange.length} payroll run(s) for the selected period.
              Not a filed return.
            </div>
          </div>
        </div>
      )}

      {/* CONTRACTOR STATEMENT (DRAFT) */}
      {activeForm === 'contractor' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Select Contractor / Vendor:
            </label>
            <select
              value={selectedVendorId}
              onChange={e => setSelectedVendorId(e.target.value)}
              className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-3 py-1.5 text-xs font-semibold"
            >
              {vendors.map(v => (
                <option key={v.id} value={v.id}>
                  {v.companyName} ({v.name})
                </option>
              ))}
            </select>
          </div>

          <div className="bg-white text-slate-950 rounded-xl border-2 border-slate-400 shadow-lg p-8 space-y-6 text-xs font-sans">
            <div className="flex flex-wrap justify-between items-start gap-4 border-b-2 border-slate-900 pb-4">
              <div>
                <div className="text-xl font-black text-slate-900">Contractor Payment Statement (Draft)</div>
                <div className="text-xs font-bold text-slate-600 mt-0.5">
                  Payments to non-employee vendors for the selected period
                </div>
              </div>
              <div className="font-mono text-xs text-right">
                <span className="text-[10px] uppercase font-bold text-slate-500 block">Period</span>
                <span className="font-bold">{periodLabel}</span>
              </div>
            </div>

            <div className="border-2 border-slate-800 rounded-lg overflow-hidden bg-slate-50">
              <div className="grid grid-cols-12 text-slate-900">
                <div className="col-span-6 p-3 border-r-2 border-b-2 border-slate-800 bg-white space-y-1">
                  <span className="text-[10px] font-bold uppercase text-slate-500 block">
                    PAYER
                  </span>
                  <div className="font-bold text-sm text-slate-900">{companyProfile.legalName}</div>
                  <div className="text-slate-700">{companyProfile.address}</div>
                  <div className="text-slate-700">{companyProfile.cityStateZip}</div>
                  <div className="text-slate-600 text-[11px] font-mono">TPIN: {companyProfile.ein}</div>
                </div>

                <div className="col-span-6 border-b-2 border-slate-800 p-3 bg-amber-50/50 flex flex-col justify-between">
                  <div className="font-bold text-xs uppercase text-slate-800">
                    Total Paid (Period)
                  </div>
                  <div className="font-mono text-2xl font-black text-blue-900">
                    {formatCurrency(vendorDisbursements, currency)}
                  </div>
                </div>

                <div className="col-span-3 p-2.5 border-r border-b border-slate-800 font-mono">
                  <span className="text-[10px] font-bold uppercase text-slate-500 block">PAYER TIN</span>
                  <div className="font-bold text-sm mt-1">{companyProfile.ein}</div>
                </div>

                <div className="col-span-3 p-2.5 border-r-2 border-b border-slate-800 font-mono">
                  <span className="text-[10px] font-bold uppercase text-slate-500 block">RECIPIENT TIN</span>
                  <div className="font-bold text-sm mt-1">{selectedVendor?.einOrSsn || '—'}</div>
                </div>

                <div className="col-span-6 p-3 border-r-2 border-b border-slate-800 bg-white space-y-1">
                  <span className="text-[10px] font-bold uppercase text-slate-500 block">
                    RECIPIENT
                  </span>
                  <div className="font-bold text-sm text-slate-900">{selectedVendor?.companyName || '—'}</div>
                  <div className="text-xs text-slate-700">Attn: {selectedVendor?.name || '—'}</div>
                  <div className="text-slate-600 text-[11px]">{selectedVendor?.address || '—'}</div>
                </div>

                <div className="col-span-6 p-3 bg-slate-100 font-mono">
                  <span className="text-[10px] font-bold uppercase text-slate-500 block">
                    Basis
                  </span>
                  <div className="text-[11px] text-slate-700 mt-1">
                    Sum of recorded bill payments to this vendor in the selected period.
                  </div>
                </div>
              </div>
            </div>

            <div className="text-[11px] text-slate-500 flex items-center justify-between border-t pt-3">
              <span>Draft — computed from the purchase ledger. Not a filed return.</span>
              <span className="font-mono">Review before submission</span>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
};

type PayrollRunsItem = {
  employeeId: string;
  grossPay: number;
  fit: number;
  socialSecurityEmployee: number;
  socialSecurityEmployer: number;
  medicareEmployee: number;
  medicareEmployer: number;
  sit: number;
  netPay: number;
};

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between py-1.5 border-b ${
        highlight ? 'border-t-2 border-slate-900 bg-emerald-50 px-3 rounded font-black' : ''
      }`}
    >
      <span className="font-sans">{label}</span>
      <span className="font-bold tabular-nums text-sm">{value}</span>
    </div>
  );
}