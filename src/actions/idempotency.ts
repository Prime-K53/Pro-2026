export function createActionIdempotencyKey(actionId: string, recordKey?: string | number | null): string {
  const recordPart = recordKey === undefined || recordKey === null || recordKey === '' ? 'global' : String(recordKey);
  const timePart = Date.now().toString(36);
  const randPart = Math.random().toString(36).slice(2, 10);
  const safeAction = String(actionId || 'action').replace(/[^a-zA-Z0-9:._-]/g, '_');
  return `${safeAction}:${recordPart}:${timePart}:${randPart}`;
}

/**
 * Attach an idempotency key to a payload object without mutating the original.
 * Only use when the target API/service contract is verified to accept it.
 */
export function withIdempotencyKey<T extends Record<string, unknown>>(
  payload: T,
  idempotencyKey: string,
  field: string = 'idempotencyKey'
): T & Record<string, string> {
  return { ...payload, [field]: idempotencyKey } as T & Record<string, string>;
}
