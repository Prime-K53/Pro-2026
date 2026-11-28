import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, User, Mail, Phone, Star } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';
import { requestJson } from '../../services/http';
import {
  EmptyState,
  FormField,
  InlineAlert,
  ModalFooter,
  ModalHeader,
  ModalShell,
  Panel,
  StatusBadge,
} from '../common/ui';
import { appDialog } from '../../design-system';

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

const BLANK = { contactName: '', role: '', email: '', phone: '', isPrimary: false };

export const CustomerContactsTab: React.FC<CustomerContactsTabProps> = ({ customerId }) => {
  const { triggerShortcutNotice } = useAccounting();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await requestJson<{ contacts: Contact[] }>(
        `/api/customers/${customerId}/contacts`
      );
      setContacts(res.contacts || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load contacts');
    }
  }, [customerId]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setForm(BLANK);
    setError(null);
    setShowForm(true);
  };

  const openEdit = (contact: Contact) => {
    setEditingId(contact.id);
    setForm({
      contactName: contact.contactName,
      role: contact.role || '',
      email: contact.email || '',
      phone: contact.phone || '',
      isPrimary: contact.isPrimary,
    });
    setError(null);
    setShowForm(true);
  };

  const submit = async () => {
    if (!form.contactName.trim()) {
      setError('Contact name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await requestJson(`/api/customers/${customerId}/contacts/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(form),
        });
        triggerShortcutNotice?.('Contact updated');
      } else {
        await requestJson(`/api/customers/${customerId}/contacts`, {
          method: 'POST',
          body: JSON.stringify(form),
        });
        triggerShortcutNotice?.('Contact added');
      }
      setShowForm(false);
      setEditingId(null);
      setForm(BLANK);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to save contact');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (contact: Contact) => {
    const confirmed = await appDialog.confirm({
      title: 'Delete Contact',
      message: `Delete contact "${contact.contactName}"?`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await requestJson(`/api/customers/${customerId}/contacts/${contact.id}`, {
        method: 'DELETE',
      });
      triggerShortcutNotice?.('Contact deleted');
      await load();
    } catch (err: any) {
      triggerShortcutNotice?.(err?.message || 'Failed to delete contact', 'error');
    }
  };

  return (
    <Panel
      title="Contacts"
      description="People we deal with at this customer. Exactly one contact can be primary."
      icon={<User className="h-4 w-4 text-brand-600" />}
      actions={
        <button type="button" onClick={openCreate} className="btn btn-secondary py-1.5 text-xs">
          <Plus className="h-3.5 w-3.5" />
          Add contact
        </button>
      }
    >
      <div className="space-y-3">
        {contacts.length === 0 ? (
          <EmptyState
            title="No contacts yet"
            description="Add a contact person so statements and follow-ups reach the right person."
            icon={<User className="h-6 w-6" />}
            action={
              <button type="button" onClick={openCreate} className="btn btn-primary">
                <Plus className="h-4 w-4" />
                Add contact
              </button>
            }
          />
        ) : (
          <ul className="space-y-2">
            {contacts.map(contact => (
              <li
                key={contact.id}
                className="surface surface-hover flex flex-wrap items-start justify-between gap-3 p-3.5"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-white/[0.05] dark:text-slate-400">
                    <User className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">
                        {contact.contactName}
                      </span>
                      {contact.isPrimary && (
                        <StatusBadge tone="success">
                          <Star className="h-3 w-3" />
                          Primary
                        </StatusBadge>
                      )}
                    </div>
                    {contact.role && (
                      <div className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">
                        {contact.role}
                      </div>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                      {contact.email && (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3 w-3" />
                          {contact.email}
                        </span>
                      )}
                      {contact.phone && (
                        <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                          <Phone className="h-3 w-3" />
                          {contact.phone}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(contact)}
                    title="Edit contact"
                    className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-brand-50 hover:text-brand-600 dark:hover:bg-white/[0.06] dark:hover:text-brand-300"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(contact)}
                    title="Delete contact"
                    className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showForm && (
        <ModalShell open onClose={() => setShowForm(false)} size="md" titleId="contact-form-title">
          <ModalHeader
            title={editingId ? 'Edit contact' : 'Add contact'}
            subtitle="Contact details are used on statements and reminders."
            icon={<User className="h-4 w-4" />}
            tone="brand"
            onClose={() => setShowForm(false)}
          />
          <div className="space-y-4 overflow-y-auto p-5">
            <FormField label="Contact name" required>
              <input
                value={form.contactName}
                onChange={e => setForm({ ...form, contactName: e.target.value })}
                className="app-input"
                placeholder="e.g. Jane Banda"
              />
            </FormField>
            <FormField label="Role">
              <input
                value={form.role}
                onChange={e => setForm({ ...form, role: e.target.value })}
                className="app-input"
                placeholder="e.g. Accounts manager"
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Email">
                <input
                  type="email"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  className="app-input"
                  placeholder="name@company.com"
                />
              </FormField>
              <FormField label="Phone">
                <input
                  value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  className="app-input app-input-mono"
                  placeholder="+265…"
                />
              </FormField>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={form.isPrimary}
                onChange={e => setForm({ ...form, isPrimary: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              Primary contact — replaces any existing primary
            </label>
            {error && <InlineAlert tone="error">{error}</InlineAlert>}
          </div>
          <ModalFooter
            onCancel={() => setShowForm(false)}
            onSubmit={submit}
            submitLabel={editingId ? 'Update contact' : 'Add contact'}
            submitIcon={<Plus className="h-4 w-4" />}
            busy={busy}
          />
        </ModalShell>
      )}
    </Panel>
  );
};