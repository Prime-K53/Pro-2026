export function getCurrencySymbol(currency?: string): string {
  const trimmed = String(currency || '').trim();
  if (!trimmed) return 'K';
  if (trimmed.toUpperCase() === 'USD') return '$';
  return trimmed;
}

export function formatCurrency(
  amount: number,
  currency: string = 'K',
  options?: {
    decimals?: number;
    showSign?: boolean;
  }
): string {
  const symbol = getCurrencySymbol(currency);
  const decimals = options?.decimals ?? 2;
  const isNegative = amount < 0;
  const absFormatted = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  if (isNegative) {
    return `-${symbol}${absFormatted}`;
  }
  if (options?.showSign && amount > 0) {
    return `+${symbol}${absFormatted}`;
  }
  return `${symbol}${absFormatted}`;
}

export function formatCompactCurrency(amount: number, currency: string = 'K'): string {
  const symbol = getCurrencySymbol(currency);
  const absVal = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (absVal >= 1_000_000) {
    return `${sign}${symbol}${(absVal / 1_000_000).toFixed(1)}M`;
  }
  if (absVal >= 1_000) {
    return `${sign}${symbol}${(absVal / 1_000).toFixed(0)}k`;
  }
  return `${sign}${symbol}${absVal.toFixed(0)}`;
}

export function getCurrencyWord(currency?: string): string {
  const sym = getCurrencySymbol(currency);
  if (sym === 'K' || sym.toUpperCase() === 'ZMW' || sym.toUpperCase() === 'MWK' || sym.toUpperCase() === 'PGK') {
    return 'Kwacha';
  }
  if (sym === '$') {
    return 'Dollars';
  }
  return sym;
}
