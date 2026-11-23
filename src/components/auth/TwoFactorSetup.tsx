import React, { useState, useEffect } from 'react';
import { Shield, CheckCircle2, AlertTriangle, Key, Copy } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';

export const TwoFactorSetup: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [status, setStatus] = useState<{ enabled: boolean; hasSecret: boolean; backupCodesRemaining: number } | null>(null);
  const [enrollData, setEnrollData] = useState<{ secret: string; uri: string } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/auth/2fa/status', { credentials: 'include' });
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error('Failed to load 2FA status:', err);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  const handleEnroll = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/2fa/enroll', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      setEnrollData(data);
    } catch (err) {
      triggerShortcutNotice?.('Failed to start enrolment');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!verifyCode) return;
    setLoading(true);
    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: verifyCode }),
      });
      const data = await res.json();
      if (data.enabled) {
        triggerShortcutNotice?.('2FA enabled successfully');
        setEnrollData(null);
        setVerifyCode('');
        loadStatus();
      } else {
        triggerShortcutNotice?.('Invalid code. Please try again.');
      }
    } catch (err) {
      triggerShortcutNotice?.('Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateBackupCodes = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/2fa/backup-codes', { method: 'POST', credentials: 'include' });
      const data = await res.json();
      setBackupCodes(data.codes || []);
    } catch (err) {
      triggerShortcutNotice?.('Failed to generate backup codes');
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async () => {
    if (!confirm('Are you sure you want to disable 2FA?')) return;
    setLoading(true);
    try {
      const res = await fetch('/api/auth/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: prompt('Enter your password to confirm:') }),
      });
      const data = await res.json();
      if (data.disabled) {
        triggerShortcutNotice?.('2FA disabled');
        loadStatus();
      }
    } catch (err) {
      triggerShortcutNotice?.('Failed to disable 2FA');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    triggerShortcutNotice?.('Copied to clipboard');
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 max-w-lg">
      <div className="flex items-center gap-2 mb-4">
        <Shield className="w-6 h-6 text-blue-500" />
        <h2 className="text-xl font-semibold">Two-Factor Authentication</h2>
      </div>

      {status?.enabled ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-green-600">
            <CheckCircle2 className="w-5 h-5" />
            <span className="font-medium">2FA is enabled</span>
          </div>
          <p className="text-sm text-gray-600">
            Backup codes remaining: {status.backupCodesRemaining}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleGenerateBackupCodes}
              className="flex items-center gap-2 bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
              disabled={loading}
            >
              <Key className="w-4 h-4" />
              Regenerate Backup Codes
            </button>
            <button
              onClick={handleDisable}
              className="flex items-center gap-2 bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600"
              disabled={loading}
            >
              Disable 2FA
            </button>
          </div>
          {backupCodes.length > 0 && (
            <div className="bg-gray-50 rounded p-4">
              <p className="text-sm font-medium mb-2">Save these backup codes in a safe place:</p>
              <div className="grid grid-cols-2 gap-1 font-mono text-sm">
                {backupCodes.map((code, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span>{code}</span>
                    <button onClick={() => copyToClipboard(code)} className="text-blue-500">
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : enrollData ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Scan this QR code with your authenticator app, or enter the secret manually:
          </p>
          <div className="bg-gray-50 rounded p-4 font-mono text-sm break-all">
            {enrollData.secret}
          </div>
          <p className="text-xs text-gray-500">URI: {enrollData.uri}</p>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Enter TOTP Code to Verify</label>
            <input
              type="text"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              className="w-full border rounded px-3 py-2"
              placeholder="000000"
              maxLength={6}
            />
          </div>
          <button
            onClick={handleVerify}
            className="w-full bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600"
            disabled={loading || verifyCode.length !== 6}
          >
            {loading ? 'Verifying...' : 'Verify & Enable'}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-amber-600">
            <AlertTriangle className="w-5 h-5" />
            <span className="font-medium">2FA is not enabled</span>
          </div>
          <p className="text-sm text-gray-600">
            Enable two-factor authentication to add an extra layer of security to your account.
          </p>
          <button
            onClick={handleEnroll}
            className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
            disabled={loading}
          >
            {loading ? 'Starting...' : 'Enable 2FA'}
          </button>
        </div>
      )}
    </div>
  );
};