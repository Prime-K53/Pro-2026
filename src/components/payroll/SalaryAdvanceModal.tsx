import React, { useState, useEffect } from 'react';
import { Plus, Trash2, DollarSign, Calendar, FileText } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';

interface SalaryAdvance {
  id: number;
  employeeId: number;
  amount: string;
  status: string;
  createdAt: string;
}

export const SalaryAdvanceModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { triggerShortcutNotice } = useAccounting();
  const [advances, setAdvances] = useState<SalaryAdvance[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [form, setForm] = useState({ employeeId: '', amount: '', repaymentMonths: '6' });
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    try {
      const res = await fetch('/api/payroll/advances', { credentials: 'include' });
      const data = await res.json();
      setAdvances(data.advances || []);
      const empRes = await fetch('/api/employees', { credentials: 'include' });
      const empData = await empRes.json();
      setEmployees(empData.employees || empData || []);
    } catch (err) { console.error(err); }
  };

  useEffect(() => { load(); }, []);

  const handleSubmit = async () => {
    try {
      const schedule = [];
      const amt = Number(form.amount) / Number(form.repaymentMonths);
      for (let i = 1; i <= Number(form.repaymentMonths); i++) {
        schedule.push({ month: i, amount: amt });
      }
      const res = await fetch('/api/payroll/advances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ employeeId: Number(form.employeeId), amount: Number(form.amount), repaymentSchedule: schedule }),
      });
      if (res.ok) {
        triggerShortcutNotice?.('Advance created');
        setShowForm(false);
        setForm({ employeeId: '', amount: '', repaymentMonths: '6' });
        load();
      }
    } catch (err) { triggerShortcutNotice?.('Failed to create advance'); }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2"><DollarSign className="w-5 h-5" /> Salary Advances</h3>
        <button onClick={() => setShowForm(!showForm)} className="bg-blue-500 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-600">
          <Plus className="w-4 h-4 inline mr-1" /> New Advance
        </button>
      </div>
      {showForm && (
        <div className="bg-gray-50 rounded p-4 mb-4 space-y-3">
          <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} className="w-full border rounded px-3 py-2">
            <option value="">Select Employee</option>
            {employees.map((e: any) => <option key={e.id} value={e.id}>{e.firstName || e.first_name} {e.lastName || e.last_name}</option>)}
          </select>
          <input type="number" placeholder="Amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-full border rounded px-3 py-2" />
          <input type="number" placeholder="Repayment Months" value={form.repaymentMonths} onChange={(e) => setForm({ ...form, repaymentMonths: e.target.value })} className="w-full border rounded px-3 py-2" />
          <button onClick={handleSubmit} className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600">Create</button>
        </div>
      )}
      <div className="space-y-2">
        {advances.map((a) => (
          <div key={a.id} className="flex justify-between items-center bg-gray-50 rounded p-3">
            <div>
              <span className="font-medium">Employee #{a.employeeId}</span>
              <span className="ml-2 text-sm text-gray-500">{a.status}</span>
            </div>
            <span className="font-semibold">{a.amount}</span>
          </div>
        ))}
        {advances.length === 0 && <p className="text-gray-500 text-sm text-center py-4">No advances</p>}
      </div>
    </div>
  );
};