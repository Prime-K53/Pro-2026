import React, { useState, useEffect } from 'react';
import { Shield, Plus, CheckCircle2, XCircle } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';

interface Consent { id: number; customerId: number; channel: string; consentType: string; status: string; createdAt: string; }

export const ConsentManagement: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [consents, setConsents] = useState<Consent[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ customerId: '', channel: 'email', consentType: 'marketing', status: 'granted' });

  const load = async () => {
    const res = await fetch('/api/communications/consents', { credentials: 'include' });
    const data = await res.json();
    setConsents(data.consents || []);
    const custRes = await fetch('/api/customers', { credentials: 'include' });
    const custData = await custRes.json();
    setCustomers(custData.customers || custData || []);
  };
  useEffect(() => { load(); }, []);

  const handleSubmit = async () => {
    const res = await fetch('/api/communications/consents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ customerId: Number(form.customerId), channel: form.channel, consentType: form.consentType, status: form.status }),
    });
    if (res.ok) { triggerShortcutNotice?.('Consent recorded'); setShowForm(false); load(); }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2"><Shield className="w-5 h-5" /> Consent Management</h3>
        <button onClick={() => setShowForm(!showForm)} className="bg-blue-500 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-600"><Plus className="w-4 h-4 inline mr-1" /> Add Consent</button>
      </div>
      {showForm && (
        <div className="bg-gray-50 rounded p-4 mb-4 space-y-3">
          <select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} className="w-full border rounded px-3 py-2">
            <option value="">Select Customer</option>
            {customers.map((c: any) => <option key={c.id} value={c.id}>{c.name || c.companyName}</option>)}
          </select>
          <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} className="w-full border rounded px-3 py-2">
            <option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option>
          </select>
          <select value={form.consentType} onChange={(e) => setForm({ ...form, consentType: e.target.value })} className="w-full border rounded px-3 py-2">
            <option value="marketing">Marketing</option><option value="transactional">Transactional</option><option value="both">Both</option>
          </select>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full border rounded px-3 py-2">
            <option value="granted">Granted</option><option value="withdrawn">Withdrawn</option>
          </select>
          <button onClick={handleSubmit} className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600">Save</button>
        </div>
      )}
      <div className="space-y-2">
        {consents.map((c) => (
          <div key={c.id} className="flex justify-between items-center bg-gray-50 rounded p-3">
            <div>
              <span className="font-medium">Customer #{c.customerId}</span>
              <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{c.channel}</span>
              <span className="ml-2 text-xs text-gray-500">{c.consentType}</span>
            </div>
            {c.status === 'granted' ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : <XCircle className="w-5 h-5 text-red-500" />}
          </div>
        ))}
        {consents.length === 0 && <p className="text-gray-500 text-sm text-center py-4">No consents recorded</p>}
      </div>
    </div>
  );
};