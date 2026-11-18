export type RoundingMode = 'HALF_EVEN' | 'HALF_UP';

const SCALE4 = 10000n;

/**
 * Parses a decimal string, number, or bigint into an exact 4-decimal scaled BigInt (1.0000 === 10000n).
 * Never uses binary floating-point arithmetic on parsed digits.
 */
export function parseDecimal4(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value * SCALE4;

  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!raw) return 0n;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
    throw new Error(`Invalid decimal monetary value: "${raw}"`);
  }

  const neg = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  const intPart = BigInt(intPartRaw || '0');

  if (fracPartRaw.length <= 4) {
    const padded = fracPartRaw.padEnd(4, '0');
    const scaled = intPart * SCALE4 + BigInt(padded);
    return neg ? -scaled : scaled;
  }

  // Round beyond 4 fractional places using HALF_EVEN
  const head4 = BigInt(fracPartRaw.slice(0, 4));
  const nextDigit = Number(fracPartRaw[4]);
  const restNonZero = /[1-9]/.test(fracPartRaw.slice(5));
  let roundedHead = head4;

  if (nextDigit > 5 || (nextDigit === 5 && (restNonZero || head4 % 2n === 1n))) {
    roundedHead += 1n;
  }
  const scaled = intPart * SCALE4 + roundedHead;
  return neg ? -scaled : scaled;
}

/**
 * Formats a 4-decimal scaled BigInt as an exact PostgreSQL NUMERIC(19,4) string (e.g. "1234.5600").
 */
export function formatDecimal4(scaled: bigint): string {
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const whole = abs / SCALE4;
  const frac = (abs % SCALE4).toString().padStart(4, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Rounds a 4-decimal scaled BigInt to 2-decimal cents scaled BigInt (1.00 === 100n).
 */
export function round4ToCents(scaled4: bigint, mode: RoundingMode = 'HALF_EVEN'): bigint {
  const neg = scaled4 < 0n;
  const abs = neg ? -scaled4 : scaled4;
  const quotient = abs / 100n;
  const remainder = abs % 100n;

  let rounded = quotient;
  if (remainder > 50n) {
    rounded += 1n;
  } else if (remainder === 50n) {
    if (mode === 'HALF_UP' || quotient % 2n === 1n) {
      rounded += 1n;
    }
  }
  return neg ? -rounded : rounded;
}

/**
 * Formats a 4-decimal scaled BigInt rounded to 2 decimal places (e.g. "1234.56").
 */
export function formatDecimal2(scaled4: bigint, mode: RoundingMode = 'HALF_EVEN'): string {
  const cents = round4ToCents(scaled4, mode);
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Converts a 4-decimal scaled BigInt to a 2-decimal JS number strictly for JSON numeric display convenience.
 * All arithmetic MUST happen in BigInt before calling this.
 */
export function toMoneyNumber(scaled4: bigint, mode: RoundingMode = 'HALF_EVEN'): number {
  return Number(formatDecimal2(scaled4, mode));
}

export function sumDecimal4(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

export function absBigInt(v: bigint): bigint {
  return v < 0n ? -v : v;
}
