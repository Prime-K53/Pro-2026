import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Settings } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';

interface DeductionRule { id: number; name: string; deductionType: string; calculationMethod: string; formula: string | null; applicableTo: string; }

export const DeductionRulesView: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [rules, setRules] = useState<DeductionRule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ deductionType: 'tax', name: '', calculationMethod: 'percentage', formula: '', applicableTo: 'all' });

  const load = async () => {
    const res = await fetch('/api/payroll/deduction-rules', { credentials: 'include' });
    const data = await res.json();
    setRules(data.rules || []);
  };
  useEffect(() => { load(); }, []);

  const handleSubmit = async () => {
    const res = await fetch('/api/payroll/deduction-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify(form),
    });
    if (res.ok) { triggerShortcutNotice?.('Rule created'); setShowForm(false); setForm({ deductionType: 'tax', name: '', calculationMethod: 'percentage', formula: '', applicableTo: 'all' }); load(); }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2"><Settings className="w-5 h-5" /> Deduction Rules</h3>
        <button onClick={() => setShowForm(!showForm)} className="bg-blue-500 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-600"><Plus className="w-4 h-4 inline mr-1" /> New Rule</button>
      </div>
      {showForm && (
        <div className="bg-gray-50 rounded p-4 mb-4 space-y-3">
          <input placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border rounded px-3 py-2" />
          <select value={form.deductionType} onChange={(e) => setForm({ ...form, deductionType: e.target.value })} className="w-full border rounded px-3 py-2">
            <option value="tax">Tax</option><option value="pension">Pension</option><option value="loan">Loan</option><option value="other">Other</option>
          </select>
          <select value={form.calculationMethod} onChange={(e) => setForm({ ...form, calculationMethod: e.target.value })} className="w-full border rounded px-3 py-2">
            <option value="fixed">Fixed</option><option value="percentage">Percentage</option><option value="tiered">Tiered</option><option value="statutory">Statutory</option>
          </select>
          <input placeholder="Formula (e.g. 10%)" value={form.formula} onChange={(e) => setForm({ ...form, formula: e.target.value })} className="w-full border rounded px-3 py-2" />
          <button onClick={handleSubmit} className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600">Create</button>
        </div>
      )}
      <div className="space-y-2">
        {rules.map((r) => (
          <div key={r.id} className="flex justify-between items-center bg-gray-50 rounded p-3">
            <div>
              <span className="font-medium">{r.name}</span>
              <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{r.deductionType}</span>
              <span className="ml-2 text-xs text-gray-500">{r.calculationMethod}</span>
            </div>
            <span className="text-sm text-gray-600">{r.formula || '—'}</span>
          </div>
        ))}
        {rules.length === 0 && <p className="text-gray-500 text-sm text-center py-4">No deduction rules</p>}
      </div>
    </div>
  );
};