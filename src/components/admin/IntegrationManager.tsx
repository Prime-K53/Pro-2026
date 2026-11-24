import React, { useCallback, useEffect, useState } from 'react';
import { Plug, Plus, RefreshCw, KeyRound } from 'lucide-react';
import { adminApi, Integration } from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { Panel, StatusBadge } from '../common/ui';

/** WS-9 S12 — integration registry and secret rotation. */
export const IntegrationManager: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [type, setType] = useState('webhook');
  const [secret, setSecret] = useState('');
  const [rotatingId, setRotatingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.integrations();
      setIntegrations(res.integrations || []);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to load integrations', 'error');
    } finally {
      setLoading(false);
    }
  }, [triggerShortcutNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!name.trim()) {
      triggerShortcutNotice('Integration name is required', 'error');
      return;
    }
    try {
      await adminApi.createIntegration({ name: name.trim(), type });
      setName('');
      triggerShortcutNotice('Integration registered');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to register integration', 'error');
    }
  };

  const rotate = async (integration: Integration) => {
    if (!secret.trim()) {
      triggerShortcutNotice('Enter a new secret first', 'error');
      return;
    }
    setRotatingId(integration.id);
    try {
      await adminApi.rotateIntegrationSecret(integration.id, secret.trim());
      setSecret('');
      triggerShortcutNotice(`Secret rotated for ${integration.name}`);
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Rotation failed', 'error');
    } finally {
      setRotatingId(null);
    }
  };

  return (
    <Panel
      title="Integrations"
      description="Registered outbound integrations. Secrets are stored encrypted and only rotated here — never read back."
      icon={<Plug className="h-4 w-4 text-brand-600" />}
      actions={
        <button type="button" onClick={load} disabled={loading} className="btn btn-secondary py-1.5 text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="block text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Type</span>
          <select
            value={type}
            onChange={e => setType(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="webhook">Webhook</option>
            <option value="api">API</option>
            <option value="sftp">SFTP</option>
          </select>
        </label>
        <label className="block text-xs sm:col-span-2">
          <span className="font-semibold text-slate-700 dark:text-slate-300">
            New secret (for rotation)
          </span>
          <input
            type="password"
            value={secret}
            onChange={e => setSecret(e.target.value)}
            autoComplete="off"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
      </div>
      <div className="mt-3 flex justify-end">
        <button type="button" onClick={create} className="btn btn-primary">
          <Plus className="h-3.5 w-3.5" />
          Register
        </button>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th className="text-right">Created</th>
              <th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {integrations.map(i => (
              <tr key={i.id}>
                <td className="font-medium">{i.name}</td>
                <td>{i.type}</td>
                <td>
                  <StatusBadge tone={i.status === 'active' ? 'success' : 'neutral'}>
                    {i.status}
                  </StatusBadge>
                </td>
                <td className="text-right text-xs text-slate-500">
                  {new Date(i.createdAt).toLocaleDateString()}
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    onClick={() => rotate(i)}
                    disabled={rotatingId === i.id}
                    className="btn btn-secondary px-2 py-1 text-[11px]"
                  >
                    <KeyRound className="h-3 w-3" />
                    Rotate secret
                  </button>
                </td>
              </tr>
            ))}
            {integrations.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-xs text-slate-500">
                  No integrations registered.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
};