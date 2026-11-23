import React, { useState, useEffect } from 'react';
import { Activity, Database, Server, Wifi, HardDrive, Clock } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';

interface HealthData {
  status: string;
  service: string;
  database: string;
  uptime: number;
  timestamp: string;
}

interface Metrics {
  invoiceCount: number;
  customerCount: number;
  inventoryItemCount: number;
}

export const HealthDashboard: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchHealth = async () => {
    try {
      const res = await fetch('/api/admin/health', { credentials: 'include' });
      const data = await res.json();
      setHealth(data);
    } catch (err) {
      console.error('Health check failed:', err);
    }
  };

  const fetchMetrics = async () => {
    try {
      const res = await fetch('/api/admin/metrics', { credentials: 'include' });
      const data = await res.json();
      setMetrics(data.metrics);
    } catch (err) {
      console.error('Metrics fetch failed:', err);
    }
  };

  useEffect(() => {
    Promise.all([fetchHealth(), fetchMetrics()]).finally(() => setLoading(false));
    const interval = setInterval(() => {
      fetchHealth();
      fetchMetrics();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
  };

  if (loading) {
    return <div className="p-6 text-gray-500">Loading health data...</div>;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        <Activity className="w-6 h-6 text-blue-500" />
        System Health
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-2 mb-2">
            <Server className="w-5 h-5 text-green-500" />
            <span className="font-medium">Service Status</span>
          </div>
          <div className={`text-2xl font-bold ${health?.status === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
            {health?.status?.toUpperCase() || 'UNKNOWN'}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-2 mb-2">
            <Database className="w-5 h-5 text-blue-500" />
            <span className="font-medium">Database</span>
          </div>
          <div className={`text-2xl font-bold ${health?.database === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
            {health?.database?.toUpperCase() || 'UNKNOWN'}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-5 h-5 text-purple-500" />
            <span className="font-medium">Uptime</span>
          </div>
          <div className="text-lg font-bold text-gray-700">
            {health?.uptime ? formatUptime(health.uptime) : 'N/A'}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-2 mb-2">
            <Wifi className="w-5 h-5 text-amber-500" />
            <span className="font-medium">Last Check</span>
          </div>
          <div className="text-sm text-gray-600">
            {health?.timestamp ? new Date(health.timestamp).toLocaleTimeString() : 'N/A'}
          </div>
        </div>
      </div>

      {metrics && (
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-semibold mb-3">System Metrics</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold text-blue-600">{metrics.invoiceCount}</div>
              <div className="text-sm text-gray-500">Invoices</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-green-600">{metrics.customerCount}</div>
              <div className="text-sm text-gray-500">Customers</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-purple-600">{metrics.inventoryItemCount}</div>
              <div className="text-sm text-gray-500">Inventory Items</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};