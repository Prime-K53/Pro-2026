import type { TransactionRef } from './types';

/**
 * Build a TransactionRef from a module record. Modules can override `number`
 * and `status` field names via options. Kept intentionally tiny — modules with
 * richer shapes can construct refs directly.
 */
export function createTransactionRef<TRecord>(
  record: TRecord,
  opts: {
    moduleKey: string;
    entityType: string;
    id: (record: TRecord) => string | number;
    number?: (record: TRecord) => string | undefined;
    status?: (record: TRecord) => string | null | undefined;
  }
): TransactionRef {
  return {
    id: opts.id(record),
    number: opts.number ? opts.number(record) : undefined,
    moduleKey: opts.moduleKey,
    entityType: opts.entityType,
    status: opts.status ? opts.status(record) ?? null : (record as { status?: string | null })?.status ?? null,
    record,
  };
}