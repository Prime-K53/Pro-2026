import React, { useCallback, useEffect, useState } from 'react';
import {
  MessageSquare,
  Send,
  FileText,
  Ban,
  RefreshCw,
  Coins,
  Plus,
} from 'lucide-react';
import {
  commsApi,
  CommunicationMessage,
  CommunicationTemplate,
  Consent,
  Suppression,
} from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { InlineAlert, Panel, StatCard, StatusBadge } from '../common/ui';

type Tab = 'inbox' | 'templates' | 'suppressions';

/**
 * WS-7 — communications inbox.
 *
 * Outbound messages, templates, suppression list and provider cost monitoring,
 * backed by `/api/communications/*`. SMS and WhatsApp are sent through the
 * configured Twilio adapter; email stays on the nodemailer queue.
 */
export const InboxView: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [tab, setTab] = useState<Tab>('inbox');
  const [messages, setMessages] = useState<CommunicationMessage[]>([]);
  const [templates, setTemplates] = useState<CommunicationTemplate[]>([]);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [costs, setCosts] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [sendForm, setSendForm] = useState({ channel: 'sms', recipient: '', body: '' });
  const [templateForm, setTemplateForm] = useState({ name: '', channel: 'sms', body: '' });
  const [suppForm, setSuppForm] = useState({ channel: 'sms', recipient: '', reason: '' });
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, t, s, c, cost] = await Promise.all([
        commsApi.messages(100),
        commsApi.templates(),
        commsApi.suppressions(),
        commsApi.consents(),
        commsApi.costs().catch(() => null),
      ]);
      setMessages(m.messages || []);
      setTemplates(t.templates || []);
      setSuppressions(s.suppressions || []);
      setConsents(c.consents || []);
      setCosts(cost);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to load communications', 'error');
    } finally {
      setLoading(false);
    }
  }, [triggerShortcutNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const send = async () => {
    if (!sendForm.recipient.trim() || !sendForm.body.trim()) {
      triggerShortcutNotice('Recipient and message are required', 'error');
      return;
    }
    setSending(true);
    try {
      const res = await commsApi.send({
        channel: sendForm.channel,
        recipient: sendForm.recipient.trim(),
        body: sendForm.body.trim(),
      });
      const status = res.message.status;
      if (status === 'failed') {
        triggerShortcutNotice(`Message not sent: ${res.message.error || 'failed'}`, 'error');
      } else {
        triggerShortcutNotice(`Message ${status}`);
      }
      setSendForm({ ...sendForm, recipient: '', body: '' });
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const addTemplate = async () => {
    if (!templateForm.name.trim() || !templateForm.body.trim()) {
      triggerShortcutNotice('Template name and body are required', 'error');
      return;
    }
    try {
      await commsApi.createTemplate(templateForm);
      setTemplateForm({ name: '', channel: 'sms', body: '' });
      triggerShortcutNotice('Template saved');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to save template', 'error');
    }
  };

  const addSuppression = async () => {
    if (!suppForm.recipient.trim()) {
      triggerShortcutNotice('Recipient is required', 'error');
      return;
    }
    try {
      await commsApi.createSuppression(suppForm);
      setSuppForm({ channel: 'sms', recipient: '', reason: '' });
      triggerShortcutNotice('Recipient suppressed');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to suppress recipient', 'error');
    }
  };

  const statusTone = (status: string) =>
    status === 'sent' || status === 'delivered'
      ? 'success'
      : status === 'failed'
      ? 'danger'
      : status === 'queued'
      ? 'warning'
      : 'neutral';

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Messages"
          value={costs?.totalMessages ?? messages.length}
          hint={`${messages.filter(m => m.status === 'sent' || m.status === 'delivered').length} sent`}
          icon={<MessageSquare className="h-4 w-4" />}
          tone="blue"
        />
        <StatCard
          label="Provider cost"
          value={formatCurrency(Number(costs?.totalCost || 0), currency)}
          hint="SMS and WhatsApp usage"
          icon={<Coins className="h-4 w-4" />}
          tone="emerald"
        />
        <StatCard
          label="Suppressed"
          value={suppressions.length}
          hint={`${consents.filter(c => c.status === 'withdrawn').length} withdrawn consents`}
          icon={<Ban className="h-4 w-4" />}
          tone="rose"
        />
      </div>

      <div className="flex w-fit flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 text-xs font-semibold shadow-xs dark:border-slate-800 dark:bg-slate-900">
        {(
          [
            { id: 'inbox', label: 'Inbox', icon: MessageSquare },
            { id: 'templates', label: 'Templates', icon: FileText },
            { id: 'suppressions', label: 'Suppressions', icon: Ban },
          ] as Array<{ id: Tab; label: string; icon: React.ElementType }>
        ).map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 transition-colors ${
                tab === item.id
                  ? 'bg-[#0f3d63] text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === 'inbox' && (
        <Panel
          title="Send a message"
          description="SMS and WhatsApp dispatch through the configured provider; email is queued for the mailer."
          icon={<Send className="h-4 w-4 text-emerald-600" />}
          actions={
            <button type="button" onClick={load} className="btn btn-secondary py-1.5 text-xs">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Channel</span>
              <select
                value={sendForm.channel}
                onChange={e => setSendForm({ ...sendForm, channel: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Recipient</span>
              <input
                value={sendForm.recipient}
                onChange={e => setSendForm({ ...sendForm, recipient: e.target.value })}
                placeholder="+265…"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="block text-xs sm:col-span-2">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Message</span>
              <input
                value={sendForm.body}
                onChange={e => setSendForm({ ...sendForm, body: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={send} disabled={sending} className="btn btn-primary">
              <Send className="h-3.5 w-3.5" />
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>

          <div className="mt-4">
            {messages.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">No messages yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>Recipient</th>
                      <th>Message</th>
                      <th>Status</th>
                      <th className="text-right">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map(m => (
                      <tr key={m.id}>
                        <td>
                          <StatusBadge tone="neutral">{m.channel}</StatusBadge>
                        </td>
                        <td className="font-mono text-xs">{m.recipient}</td>
                        <td className="max-w-[320px] truncate text-xs">{m.body}</td>
                        <td>
                          <StatusBadge tone={statusTone(m.status)}>{m.status}</StatusBadge>
                          {m.error && (
                            <div className="text-[10px] text-rose-500">{m.error}</div>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-right text-xs text-slate-500">
                          {m.sentAt ? new Date(m.sentAt).toLocaleString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Panel>
      )}

      {tab === 'templates' && (
        <Panel
          title="Templates"
          description="Reusable bodies. Suppression is checked before any send goes out."
          icon={<FileText className="h-4 w-4 text-brand-600" />}
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Name</span>
              <input
                value={templateForm.name}
                onChange={e => setTemplateForm({ ...templateForm, name: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Channel</span>
              <select
                value={templateForm.channel}
                onChange={e => setTemplateForm({ ...templateForm, channel: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
              </select>
            </label>
            <label className="block text-xs sm:col-span-2">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Body</span>
              <input
                value={templateForm.body}
                onChange={e => setTemplateForm({ ...templateForm, body: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={addTemplate} className="btn btn-primary">
              <Plus className="h-3.5 w-3.5" />
              Add template
            </button>
          </div>

          <div className="mt-4">
            {templates.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">No templates.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Channel</th>
                      <th>Body</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map(t => (
                      <tr key={t.id}>
                        <td className="font-medium">{t.name}</td>
                        <td>
                          <StatusBadge tone="info">{t.channel}</StatusBadge>
                        </td>
                        <td className="max-w-[420px] truncate text-xs text-slate-500">{t.body}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Panel>
      )}

      {tab === 'suppressions' && (
        <div className="space-y-4">
          <Panel
            title="Suppress a recipient"
            description="Suppressed recipients never receive a message. Consent withdrawal also blocks sends."
            icon={<Ban className="h-4 w-4 text-rose-600" />}
          >
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="block text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-300">Channel</span>
                <select
                  value={suppForm.channel}
                  onChange={e => setSuppForm({ ...suppForm, channel: e.target.value })}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                >
                  <option value="sms">SMS</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email</option>
                </select>
              </label>
              <label className="block text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-300">Recipient</span>
                <input
                  value={suppForm.recipient}
                  onChange={e => setSuppForm({ ...suppForm, recipient: e.target.value })}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
              <label className="block text-xs sm:col-span-2">
                <span className="font-semibold text-slate-700 dark:text-slate-300">Reason</span>
                <input
                  value={suppForm.reason}
                  onChange={e => setSuppForm({ ...suppForm, reason: e.target.value })}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                />
              </label>
            </div>
            <div className="mt-3 flex justify-end">
              <button type="button" onClick={addSuppression} className="btn btn-danger">
                <Ban className="h-3.5 w-3.5" />
                Suppress
              </button>
            </div>
          </Panel>

          <Panel title="Suppression list" icon={<Ban className="h-4 w-4 text-rose-600" />}>
            {suppressions.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">No suppressed recipients.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>Recipient</th>
                      <th>Reason</th>
                      <th className="text-right">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppressions.map(s => (
                      <tr key={s.id}>
                        <td>
                          <StatusBadge tone="neutral">{s.channel}</StatusBadge>
                        </td>
                        <td className="font-mono text-xs">{s.recipient}</td>
                        <td className="text-xs text-slate-500">{s.reason || '—'}</td>
                        <td className="text-right text-xs text-slate-500">
                          {new Date(s.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {consents.length > 0 && (
            <Panel
              title="Consents"
              description="Channel-specific consent records; withdrawn consent blocks sends."
              icon={<FileText className="h-4 w-4 text-brand-600" />}
            >
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Channel</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {consents.map(c => (
                      <tr key={c.id}>
                        <td className="font-mono text-xs">#{c.customerId}</td>
                        <td>{c.channel}</td>
                        <td>{c.consentType}</td>
                        <td>
                          <StatusBadge tone={c.status === 'granted' ? 'success' : 'danger'}>
                            {c.status}
                          </StatusBadge>
                        </td>
                        <td className="text-xs text-slate-500">{c.source || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      )}

      {loading && <InlineAlert tone="info">Loading…</InlineAlert>}
    </div>
  );
};