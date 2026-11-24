import { requestJson } from './http';
import { emitAccountingUpdated } from './accountingApi';

/**
 * Fixed-asset register & depreciation client. Thin wrappers over
 * `/api/fixed-asset-types` and `/api/fixed-assets`.
 */

export interface ApiFixedAssetType {
  id: number;
  name: string;
  asset_account_id: number | null;
  accum_depr_account_id: number | null;
  depr_expense_account_id: number | null;
  depreciation_method: 'straight_line' | 'declining_balance';
  effective_life_years: string | null;
  annual_rate: string | null;
  is_active: boolean;
  asset_account_code?: string | null;
  asset_account_name?: string | null;
}

export interface ApiFixedAsset {
  id: number;
  asset_type_id: number;
  asset_type_name: string;
  asset_number: string;
  name: string;
  purchase_date: string;
  purchase_price: string;
  salvage_value: string;
  accumulated_depreciation: string;
  last_depreciation_date: string | null;
  disposal_date: string | null;
  status: 'registered' | 'disposed';
  description: string | null;
  net_book_value: string;
}

export interface ApiRollForward {
  activeCount: number;
  disposedCount: number;
  totalCost: number;
  totalAccumulatedDepreciation: number;
  totalNetBookValue: number;
}

export const fixedAssetApi = {
  async listTypes(): Promise<ApiFixedAssetType[]> {
    const d = await requestJson<{ types: ApiFixedAssetType[] }>('/api/fixed-asset-types');
    return d.types || [];
  },

  async createType(payload: {
    name: string;
    assetAccountId?: number | null;
    accumDeprAccountId?: number | null;
    deprExpenseAccountId?: number | null;
    depreciationMethod?: 'straight_line' | 'declining_balance';
    effectiveLifeYears?: number | null;
    annualRate?: number | null;
  }): Promise<ApiFixedAssetType> {
    const d = await requestJson<{ type: ApiFixedAssetType }>('/api/fixed-asset-types', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.type;
  },

  async listAssets(): Promise<ApiFixedAsset[]> {
    const d = await requestJson<{ assets: ApiFixedAsset[] }>('/api/fixed-assets');
    return d.assets || [];
  },

  async getAsset(id: number): Promise<ApiFixedAsset> {
    const d = await requestJson<{ asset: ApiFixedAsset }>(`/api/fixed-assets/${id}`);
    return d.asset;
  },

  async createAsset(payload: {
    assetTypeId: number;
    assetNumber: string;
    name: string;
    purchaseDate: string;
    purchasePrice: string | number;
    salvageValue?: string | number | null;
    description?: string | null;
  }): Promise<ApiFixedAsset> {
    const d = await requestJson<{ asset: ApiFixedAsset }>('/api/fixed-assets', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.asset;
  },

  async runDepreciation(periodDate?: string): Promise<any> {
    const d = await requestJson<any>('/api/fixed-assets/depreciation/run', {
      method: 'POST',
      body: JSON.stringify({ periodDate: periodDate ?? null }),
    });
    emitAccountingUpdated();
    return d;
  },

  async dispose(
    id: number,
    payload: {
      disposalDate?: string | null;
      proceeds?: string | number | null;
      proceedsAccountId?: number | null;
      lossAccountId?: number | null;
      gainAccountId?: number | null;
      reason?: string | null;
    }
  ): Promise<any> {
    const d = await requestJson<{ disposal: any }>(`/api/fixed-assets/${id}/dispose`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.disposal;
  },

  async rollForward(): Promise<ApiRollForward> {
    const d = await requestJson<{ summary: ApiRollForward }>('/api/fixed-assets/roll-forward');
    return d.summary;
  },
};