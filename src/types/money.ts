/**
 * @file money.ts
 * @description String-backed money value object for the render boundary.
 *
 * Adapted from PrimeERPsystem/contracts/InvoicePayload.ts.
 *
 * This type is ADDITIVE: it is used ONLY at the boundary between the
 * documents/printing services and the renderer. The database keeps
 * NUMERIC(19,4); the React UI keeps `number`. The renderer (PDF, layout
 * engine) receives `Money` so it never re-parses floating-point values.
 *
 * Design rules:
 *   - Amounts are decimal strings, never JS numbers, to avoid precision loss.
 *   - Currency is an ISO 4217 code (e.g. "ZMW", "USD").
 *   - Precision matches the DB scale (4 for this project).
 */

/**
 * A monetary value with currency context.
 *
 * The `amount` field is a decimal string (e.g. "1500.5000") so it can be
 * transported across the API boundary without floating-point rounding.
 */
export interface Money {
  /** Decimal string. Always matches the configured precision. */
  amount: string;
  /** ISO 4217 currency code (e.g. "ZMW", "USD"). */
  currency: string;
  /** Number of decimal places the amount is formatted to (e.g. 4). */
  precision: number;
}

/**
 * Convenience constructors for building `Money` from the existing helpers.
 *
 * These are kept here so that services do not need to import the decimal
 * module directly at the render boundary.
 */
export function moneyFromNumber(value: number, currency: string, precision = 4): Money {
  const fixed = value.toFixed(precision);
  return { amount: fixed, currency, precision };
}

export function moneyFromString(amount: string, currency: string, precision = 4): Money {
  return { amount, currency, precision };
}

export function moneyZero(currency: string, precision = 4): Money {
  return { amount: (0).toFixed(precision), currency, precision };
}

/**
 * Returns true if `value` looks like a `Money` object.
 */
export function isMoney(value: unknown): value is Money {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Money).amount === 'string' &&
    typeof (value as Money).currency === 'string' &&
    typeof (value as Money).precision === 'number'
  );
}