import React, { useState, useEffect } from 'react';
import { Plus, Truck, Users } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';

interface Vehicle { id: number; registration: string; make: string | null; model: string | null; status: string; }

export const VehicleManagement: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ registration: '', make: '', model: '', capacityKg: '' });

  const load = async () => {
    const res = await fetch('/api/delivery/vehicles', { credentials: 'include' });
    const data = await res.json();
    setVehicles(data.vehicles || []);
  };
  useEffect(() => { load(); }, []);

  const handleSubmit = async () => {
    const res = await fetch('/api/delivery/vehicles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ registration: form.registration, make: form.make, model: form.model, capacityKg: Number(form.capacityKg) || null }),
    });
    if (res.ok) { triggerShortcutNotice?.('Vehicle added'); setShowForm(false); setForm({ registration: '', make: '', model: '', capacityKg: '' }); load(); }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2"><Truck className="w-5 h-5" /> Vehicles</h3>
        <button onClick={() => setShowForm(!showForm)} className="bg-blue-500 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-600"><Plus className="w-4 h-4 inline mr-1" /> Add Vehicle</button>
      </div>
      {showForm && (
        <div className="bg-gray-50 rounded p-4 mb-4 space-y-3">
          <input placeholder="Registration *" value={form.registration} onChange={(e) => setForm({ ...form, registration: e.target.value })} className="w-full border rounded px-3 py-2" />
          <input placeholder="Make" value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} className="w-full border rounded px-3 py-2" />
          <input placeholder="Model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="w-full border rounded px-3 py-2" />
          <input type="number" placeholder="Capacity (kg)" value={form.capacityKg} onChange={(e) => setForm({ ...form, capacityKg: e.target.value })} className="w-full border rounded px-3 py-2" />
          <button onClick={handleSubmit} className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600">Add</button>
        </div>
      )}
      <div className="space-y-2">
        {vehicles.map((v) => (
          <div key={v.id} className="flex justify-between items-center bg-gray-50 rounded p-3">
            <div>
              <span className="font-medium">{v.registration}</span>
              <span className="ml-2 text-sm text-gray-500">{v.make} {v.model}</span>
            </div>
            <span className={`text-xs px-2 py-1 rounded ${v.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{v.status}</span>
          </div>
        ))}
        {vehicles.length === 0 && <p className="text-gray-500 text-sm text-center py-4">No vehicles</p>}
      </div>
    </div>
  );
};

export const DriverManagement: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [drivers, setDrivers] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', licenseNumber: '', licenseExpiry: '' });

  const load = async () => {
    const res = await fetch('/api/delivery/drivers', { credentials: 'include' });
    const data = await res.json();
    setDrivers(data.drivers || []);
  };
  useEffect(() => { load(); }, []);

  const handleSubmit = async () => {
    const res = await fetch('/api/delivery/drivers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify(form),
    });
    if (res.ok) { triggerShortcutNotice?.('Driver added'); setShowForm(false); setForm({ name: '', phone: '', licenseNumber: '', licenseExpiry: '' }); load(); }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2"><Users className="w-5 h-5" /> Drivers</h3>
        <button onClick={() => setShowForm(!showForm)} className="bg-blue-500 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-600"><Plus className="w-4 h-4 inline mr-1" /> Add Driver</button>
      </div>
      {showForm && (
        <div className="bg-gray-50 rounded p-4 mb-4 space-y-3">
          <input placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border rounded px-3 py-2" />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full border rounded px-3 py-2" />
          <input placeholder="License Number *" value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} className="w-full border rounded px-3 py-2" />
          <input type="date" placeholder="License Expiry" value={form.licenseExpiry} onChange={(e) => setForm({ ...form, licenseExpiry: e.target.value })} className="w-full border rounded px-3 py-2" />
          <button onClick={handleSubmit} className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600">Add</button>
        </div>
      )}
      <div className="space-y-2">
        {drivers.map((d) => (
          <div key={d.id} className="flex justify-between items-center bg-gray-50 rounded p-3">
            <div>
              <span className="font-medium">{d.name}</span>
              <span className="ml-2 text-sm text-gray-500">{d.licenseNumber}</span>
            </div>
            <span className={`text-xs px-2 py-1 rounded ${d.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{d.status}</span>
          </div>
        ))}
        {drivers.length === 0 && <p className="text-gray-500 text-sm text-center py-4">No drivers</p>}
      </div>
    </div>
  );
};