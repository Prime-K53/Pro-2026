import React, { useState, useEffect } from 'react';
import { TrendingUp, BarChart3 } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';

interface Trend { period: string; invoiceCount: number; revenue: string; cost: string; margin: string; }

export const SalesTrendsView: React.FC = () => {
  const { companyProfile } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const [trends, setTrends] = useState<Trend[]>([]);
  const [period, setPeriod] = useState('monthly');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/bi/sales-trends?period=${period}`, { credentials: 'include' });
      const data = await res.json();
      setTrends(data.trends || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [period]);

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2"><TrendingUp className="w-5 h-5" /> Sales Trends</h3>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="border rounded px-3 py-1.5">
          <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option>
        </select>
      </div>
      {loading ? <p className="text-gray-500">Loading...</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b"><th className="text-left py-2">Period</th><th className="text-right py-2">Invoices</th><th className="text-right py-2">Revenue</th><th className="text-right py-2">Cost</th><th className="text-right py-2">Margin</th></tr></thead>
            <tbody>
              {trends.map((t, i) => (
                <tr key={i} className="border-b hover:bg-gray-50">
                  <td className="py-2">{t.period}</td>
                  <td className="text-right py-2">{t.invoiceCount}</td>
                  <td className="text-right py-2">{formatCurrency(Number(t.revenue), currency)}</td>
                  <td className="text-right py-2">{formatCurrency(Number(t.cost), currency)}</td>
                  <td className="text-right py-2">{formatCurrency(Number(t.margin), currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trends.length === 0 && <p className="text-gray-500 text-center py-4">No data available</p>}
        </div>
      )}
    </div>
  );
};

export const KpiScorecardView: React.FC = () => {
  const [kpis, setKpis] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bi/kpi-scorecard', { credentials: 'include' });
      const data = await res.json();
      setKpis(data.kpis);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (loading) return <div className="p-6 text-gray-500">Loading KPIs...</div>;

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold flex items-center gap-2 mb-4"><BarChart3 className="w-5 h-5" /> KPI Scorecard</h3>
      {kpis && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="bg-blue-50 rounded p-4 text-center">
            <div className="text-2xl font-bold text-blue-600">{kpis.totalInvoices}</div>
            <div className="text-sm text-gray-600">Total Invoices</div>
          </div>
          <div className="bg-green-50 rounded p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{kpis.totalCustomers}</div>
            <div className="text-sm text-gray-600">Customers</div>
          </div>
          <div className="bg-purple-50 rounded p-4 text-center">
            <div className="text-2xl font-bold text-purple-600">{kpis.totalInventoryItems}</div>
            <div className="text-sm text-gray-600">Inventory Items</div>
          </div>
          <div className="bg-amber-50 rounded p-4 text-center">
            <div className="text-2xl font-bold text-amber-600">{kpis.totalRevenue}</div>
            <div className="text-sm text-gray-600">Total Revenue</div>
          </div>
          <div className="bg-red-50 rounded p-4 text-center">
            <div className="text-2xl font-bold text-red-600">{kpis.outstandingReceivables}</div>
            <div className="text-sm text-gray-600">Outstanding Receivables</div>
          </div>
        </div>
      )}
    </div>
  );
};