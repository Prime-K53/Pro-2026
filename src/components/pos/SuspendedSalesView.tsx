import React, { useState, useEffect } from 'react';
import { Pause, Play, ShoppingCart, Clock, RefreshCw } from 'lucide-react';
import { smartOpsApi } from '../../services/smartOpsApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';

interface SuspendedSale {
  id: number;
  posOrderId: number;
  suspendedAt: string;
  status: string;
}

interface SuspendedSalesViewProps {
  onResume?: (posOrderId: number) => void;
}

export const SuspendedSalesView: React.FC<SuspendedSalesViewProps> = ({ onResume }) => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const [suspendedSales, setSuspendedSales] = useState<SuspendedSale[]>([]);
  const [loading, setLoading] = useState(false);

  const loadSuspended = async () => {
    setLoading(true);
    try {
      const res = await smartOpsApi.listSuspendedSales();
      setSuspendedSales(res.suspendedSales || []);
    } catch (err) {
      console.error('Failed to load suspended sales:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSuspended(); }, []);

  const handleResume = async (suspendedId: number) => {
    try {
      const res = await smartOpsApi.resumePosOrder(suspendedId);
      triggerShortcutNotice?.('Sale resumed');
      onResume?.(res.suspendedSale.posOrderId);
      loadSuspended();
    } catch (err: any) {
      triggerShortcutNotice?.(err?.message || 'Failed to resume sale');
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Pause className="w-5 h-5 text-amber-500" />
          Suspended Sales
        </h3>
        <button
          onClick={loadSuspended}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {suspendedSales.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-4">No suspended sales</p>
      ) : (
        <div className="space-y-2">
          {suspendedSales.map((sale) => (
            <div key={sale.id} className="flex items-center justify-between bg-gray-50 rounded p-3">
              <div className="flex items-center gap-3">
                <ShoppingCart className="w-5 h-5 text-gray-400" />
                <div>
                  <div className="font-medium">Order #{sale.posOrderId}</div>
                  <div className="text-sm text-gray-500 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(sale.suspendedAt).toLocaleString()}
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleResume(sale.id)}
                className="flex items-center gap-1 bg-green-500 text-white px-3 py-1.5 rounded text-sm hover:bg-green-600"
              >
                <Play className="w-4 h-4" />
                Resume
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};