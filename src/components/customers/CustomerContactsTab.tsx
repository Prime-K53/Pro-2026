import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, User, Mail, Phone } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';

interface Contact {
  id: number;
  contactName: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
}

interface CustomerContactsTabProps {
  customerId: number;
}

export const CustomerContactsTab: React.FC<CustomerContactsTabProps> = ({ customerId }) => {
  const { triggerShortcutNotice } = useAccounting();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ contactName: '', role: '', email: '', phone: '', isPrimary: false });

  const loadContacts = async () => {
    try {
      const res = await fetch(`/api/customers/${customerId}/contacts`, { credentials: 'include' });
      const data = await res.json();
      setContacts(data.contacts || []);
    } catch (err) {
      console.error('Failed to load contacts:', err);
    }
  };

  useEffect(() => { loadContacts(); }, [customerId]);

  const handleSubmit = async () => {
    try {
      const url = editingId
        ? `/api/customers/${customerId}/contacts/${editingId}`
        : `/api/customers/${customerId}/contacts`;
      const method = editingId ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      });
      if (res.ok) {
        triggerShortcutNotice?.(editingId ? 'Contact updated' : 'Contact added');
        setShowForm(false);
        setEditingId(null);
        setForm({ contactName: '', role: '', email: '', phone: '', isPrimary: false });
        loadContacts();
      }
    } catch (err) {
      triggerShortcutNotice?.('Failed to save contact');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this contact?')) return;
    try {
      await fetch(`/api/customers/${customerId}/contacts/${id}`, { method: 'DELETE', credentials: 'include' });
      triggerShortcutNotice?.('Contact deleted');
      loadContacts();
    } catch (err) {
      triggerShortcutNotice?.('Failed to delete contact');
    }
  };

  const handleEdit = (contact: Contact) => {
    setForm({
      contactName: contact.contactName,
      role: contact.role || '',
      email: contact.email || '',
      phone: contact.phone || '',
      isPrimary: contact.isPrimary,
    });
    setEditingId(contact.id);
    setShowForm(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Contacts</h3>
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ contactName: '', role: '', email: '', phone: '', isPrimary: false }); }}
          className="flex items-center gap-1 bg-blue-500 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-600"
        >
          <Plus className="w-4 h-4" /> Add Contact
        </button>
      </div>

      {showForm && (
        <div className="bg-gray-50 rounded p-4 space-y-3">
          <input
            placeholder="Contact Name *"
            value={form.contactName}
            onChange={(e) => setForm({ ...form, contactName: e.target.value })}
            className="w-full border rounded px-3 py-2"
          />
          <input
            placeholder="Role"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="w-full border rounded px-3 py-2"
          />
          <input
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full border rounded px-3 py-2"
          />
          <input
            placeholder="Phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full border rounded px-3 py-2"
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isPrimary}
              onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
            />
            Primary Contact
          </label>
          <div className="flex gap-2">
            <button onClick={handleSubmit} className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600">
              {editingId ? 'Update' : 'Add'}
            </button>
            <button onClick={() => setShowForm(false)} className="bg-gray-200 text-gray-700 px-4 py-2 rounded hover:bg-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {contacts.map((contact) => (
          <div key={contact.id} className="flex items-center justify-between bg-gray-50 rounded p-3">
            <div className="flex items-center gap-3">
              <User className="w-5 h-5 text-gray-400" />
              <div>
                <div className="font-medium">
                  {contact.contactName}
                  {contact.isPrimary && <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">Primary</span>}
                </div>
                <div className="text-sm text-gray-500 flex items-center gap-3">
                  {contact.role && <span>{contact.role}</span>}
                  {contact.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{contact.email}</span>}
                  {contact.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{contact.phone}</span>}
                </div>
              </div>
            </div>
            <div className="flex gap-1">
              <button onClick={() => handleEdit(contact)} className="p-1.5 text-blue-500 hover:bg-blue-50 rounded">
                <Edit2 className="w-4 h-4" />
              </button>
              <button onClick={() => handleDelete(contact.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
        {contacts.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-4">No contacts yet. Add one to get started.</p>
        )}
      </div>
    </div>
  );
};