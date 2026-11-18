import React, { useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { commercialApi } from '../../services/commercialApi';
import { EmployeeFilingStatus } from '../../types/accounting';
import { getCurrencySymbol } from '../../utils/currency';
import { AlertTriangle, Loader2, Save, Users, X } from 'lucide-react';

export const NewEmployeeModal: React.FC = () => {
  const { isNewEmployeeOpen, setIsNewEmployeeOpen, companyProfile, triggerShortcutNotice } = useAccounting();
  const { hasPermission } = useAuth();
  const canWriteEmployees = hasPermission('employees:write');
  const currencySymbol = getCurrencySymbol(companyProfile.currency);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('Shop Floor');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [ssn, setSsn] = useState('');
  const [hireDate, setHireDate] = useState(new Date().toISOString().split('T')[0]);
  const [payType, setPayType] = useState<'hourly' | 'salary'>('hourly');
  const [payRate, setPayRate] = useState<number>(32.00);
  const [payFrequency, setPayFrequency] = useState<'weekly' | 'biweekly' | 'semimonthly' | 'monthly'>('biweekly');
  const [filingStatus, setFilingStatus] = useState<EmployeeFilingStatus>('single');
  const [w4Allowances, setW4Allowances] = useState<number>(1);
  const [directDepositRouting, setDirectDepositRouting] = useState('041201381');
  const [directDepositAccount, setDirectDepositAccount] = useState('9941');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isNewEmployeeOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName || !lastName) return;
    if (!canWriteEmployees) {
      setErrorMsg('Your role cannot add employees (employees:write).');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      // Only the last four digits of the SSN are ever retained, and they are
      // masked before being sent to the server.
      const ssnLast4 = ssn ? ssn.slice(-4) : '';
      await commercialApi.createEmployee({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        jobTitle: title.trim() || null,
        department: department.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        hireDate,
        payType,
        payRate,
        payFrequency,
        filingStatus,
        w4Allowances,
      });

      triggerShortcutNotice(
        `Enrolled ${firstName.trim()} ${lastName.trim()} in the employee directory${
          ssnLast4 ? ` (SSN ending ${ssnLast4} recorded as masked)` : ''
        }`
      );
      setIsNewEmployeeOpen(false);
      setFirstName('');
      setLastName('');
      setTitle('');
      setEmail('');
      setPhone('');
      setSsn('');
    } catch (err: any) {
      const message = err?.message || 'Failed to add the employee';
      setErrorMsg(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
        <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-amber-400" />
            <h2 className="font-bold text-base tracking-tight">Add New Employee (US Payroll)</h2>
          </div>
          <button
            onClick={() => setIsNewEmployeeOpen(false)}
            className="p-1 rounded hover:bg-white/10 text-white/80 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">First Name</label>
              <input
                type="text"
                value={firstName}
                onChange={e => setFirstName(e.target.value)}
                placeholder="Marcus"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Last Name</label>
              <input
                type="text"
                value={lastName}
                onChange={e => setLastName(e.target.value)}
                placeholder="Vance"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Job Title</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Senior CNC Machinist"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Department</label>
              <input
                type="text"
                value={department}
                onChange={e => setDepartment(e.target.value)}
                placeholder="Machining / Operations"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Pay Type</label>
              <select
                value={payType}
                onChange={e => {
                  const t = e.target.value as any;
                  setPayType(t);
                  if (t === 'salary' && payRate < 1000) setPayRate(65000);
                  if (t === 'hourly' && payRate > 500) setPayRate(35);
                }}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-slate-100 outline-none"
              >
                <option value="hourly">Hourly Rate</option>
                <option value="salary">Annual Salary</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                {payType === 'hourly' ? `Hourly Rate (${currencySymbol}/hr)` : `Annual Salary (${currencySymbol})`}
              </label>
              <input
                type="number"
                step={payType === 'hourly' ? '0.25' : '1000'}
                min="0"
                value={payRate}
                onChange={e => setPayRate(parseFloat(e.target.value) || 0)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs font-mono font-bold text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Pay Frequency</label>
              <select
                value={payFrequency}
                onChange={e => setPayFrequency(e.target.value as any)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-slate-100 outline-none"
              >
                <option value="biweekly">Bi-weekly (26/yr)</option>
                <option value="weekly">Weekly (52/yr)</option>
                <option value="semimonthly">Semi-monthly (24/yr)</option>
                <option value="monthly">Monthly (12/yr)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">W-4 Filing Status</label>
              <select
                value={filingStatus}
                onChange={e => setFilingStatus(e.target.value as any)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
              >
                <option value="single">Single or Married Filing Separately</option>
                <option value="married">Married Filing Jointly</option>
                <option value="head_of_household">Head of Household</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">W-4 Allowances / Dependents</label>
              <input
                type="number"
                min="0"
                max="10"
                value={w4Allowances}
                onChange={e => setW4Allowances(parseInt(e.target.value) || 0)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Routing Number (ACH)</label>
              <input
                type="text"
                value={directDepositRouting}
                onChange={e => setDirectDepositRouting(e.target.value)}
                placeholder="9 digits"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Direct Deposit Account</label>
              <input
                type="text"
                value={directDepositAccount}
                onChange={e => setDirectDepositAccount(e.target.value)}
                placeholder="Account digits"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            {errorMsg && (
              <div
                role="alert"
                className="mr-auto p-2.5 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 flex items-start gap-2"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => setIsNewEmployeeOpen(false)}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !canWriteEmployees}
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-md transition-all active:scale-95 disabled:opacity-60"
              title={
                canWriteEmployees
                  ? 'Save this employee to the server HR directory'
                  : 'Requires employees:write permission'
              }
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              <span>{submitting ? 'Saving…' : 'Enroll Employee'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
