export const currencyService = {
  getCurrency: (code: string) => ({ code, symbol: code === 'MWK' ? 'K' : '$' }),
  getBaseCurrency: () => 'MWK',
};