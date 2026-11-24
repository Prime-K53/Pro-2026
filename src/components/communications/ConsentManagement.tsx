import React, { useCallback, useEffect, useState } from 'react';
import { Shield, Plus, CheckCircle2, XCircle, Mail, MessageSquare, Smartphone } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';
import { requestJson } from '../../services/http';
import {
  EmptyState,
  FormField,
  InlineAlert,
  Panel,
  StatusBadge,
} from '../common/ui';

interface Consent {
  id: number;
  customerId: number;
  channel: string;
  consentType: string;
  status: string;
  source?: string | null;
  createdAt: string;
}

interface CustomerLite {
  id: number;
  companyName?: string;
  name?: string;
}

const CHANNEL_ICON: Record<string, React.ElementType> = {
  email: Mail,
  sms: Smartphone,
  whatsapp: MessageSquare,
};

export const ConsentManagement: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [consents, setConsents] = useState<Consent[]>([]);
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    customerId: '',
    channel: 'email',
    consentType: 'marketing',
    status: 'granted',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, cust] = await Promise.all([
        requestJson<{ consents: Consent[] }>('/api/communications/consents'),
        requestJson<{ customers?: CustomerLite[] } | CustomerLite[]>('/api/customers'),
      ]);
      setConsents(c.consents || []);
      setCustomers(Array.isArray(cust) ? cust : cust.customers || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load consents');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const custName = (id: number) => {
    const c = customers.find(x => String(x.id) === String(id));
    return c?.companyName || c?.name || `Customer #${id}`;
  };

  const submit = async () => {
    if (!form.customerId) {
      setError('Select a customer');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestJson('/api/communications/consents', {
        method: 'POST',
        body: JSON.stringify({ ...form, customerId: Number(form.customerId) }),
      });
      triggerShortcutNotice?.('Consent recorded');
      setShowForm(false);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to record consent');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Consent management"
      description="Channel-specific consent. Withdrawn consent blocks marketing sends automatically."
      icon={<Shield className="h-4 w-4 text-brand-600" />}
      actions={
        <button
          type="button"
          onClick={() => {
            setError(null);
            setShowForm(v => !v);
          }}
          className="btn btn-secondary py-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          Add consent
        </button>
      }
    >
      <div className="space-y-4">
        {error && (
          <InlineAlert tone="error" onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        )}

        {showForm && (
          <div className="surface space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <FormField label="Customer" required>
                <select
                  value={form.customerId}
                  onChange={e => setForm({ ...form, customerId: e.target.value })}
                  className="app-input"
                >
                  <option value="">Select customer</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.companyName || c.name || `Customer #${c.id}`}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Channel">
                <select
                  value={form.channel}
                  onChange={e => setForm({ ...form, channel: e.target.value })}
                  className="app-input"
                >
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
              </FormField>
              <FormField label="Consent type">
                <select
                  value={form.consentType}
                  onChange={e => setForm({ ...form, consentType: e.target.value })}
                  className="app-input"
                >
                  <option value="marketing">Marketing</option>
                  <option value="transactional">Transactional</option>
                  <option value="both">Both</option>
                </select>
              </FormField>
              <FormField label="Status">
                <select
                  value={form.status}
                  onChange={e => setForm({ ...form, status: e.target.value })}
                  className="app-input"
                >
                  <option value="granted">Granted</option>
                  <option value="withdrawn">Withdrawn</option>
                </select>
              </FormField>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={submit} disabled={busy} className="btn btn-primary">
                <Plus className="h-4 w-4" />
                {busy ? 'Saving…' : 'Save consent'}
              </button>
            </div>
          </div>
        )}

        {consents.length === 0 ? (
          <EmptyState
            title="No consents recorded"
            description="Record consent before sending marketing messages on any channel."
            icon={<Shield className="h-6 w-6" />}
          />
        ) : (
          <ul className="space-y-2">
            {consents.map(c => {
              const Icon = CHANNEL_ICON[c.channel] || Mail;
              const granted = c.status === 'granted';
              return (
                <li
                  key={c.id}
                  className="surface surface-hover flex flex-wrap items-center justify-between gap-3 p-3.5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-white/[0.05] dark:text-slate-400">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white">
                        {custName(c.customerId)}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <StatusBadge tone="neutral">{c.channel}</StatusBadge>
                        <StatusBadge tone="info">{c.consentType}</StatusBadge>
                        {c.source && (
                          <span className="text-[11px] text-slate-400">{c.source}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {granted ? (
                      <>
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        <StatusBadge tone="success">Granted</StatusBadge>
                      </>
                    ) : (
                      <>
                        <XCircle className="h-4 w-4 text-rose-500" />
                        <StatusBadge tone="danger">Withdrawn</StatusBadge>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
};