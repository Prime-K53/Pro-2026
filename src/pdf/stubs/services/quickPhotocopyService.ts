export const isQuickPhotocopyItem = (_item: any) => false;
export const getQuickPhotocopyTotals = (item: any) => ({ lineTotal: 0, totalPages: 0 });
export const getQuickPhotocopyLineDisplay = (item: any, _currency: string) => ({
  name: item?.desc || '',
  qty: String(item?.qty || 1),
  rate: '',
  unitPrice: 0,
  amount: 0,
});
export const formatQuickPhotocopyPriceLabel = (price: number, _currency?: string) => String(price);
export const formatQuickPhotocopyQty = (qty: number) => String(qty);
