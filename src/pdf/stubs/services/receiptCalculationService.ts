/**
 * Receipt payment badge.
 *
 * The receipt renderer reads `label` for the status text and `tone` as the
 * colour passed through `monoText`, so `tone` must be a concrete colour value.
 * Statuses follow the commercial receipt contract already compared by the
 * renderer: PAID, PARTIALLY PAID, OVERPAID, plus cancelled/voided receipts.
 */

export interface ReceiptPaymentBadgeInput {
  paymentStatus?: string | null;
  status?: string | null;
  isCancelled?: boolean;
  cancelled?: boolean;
}

export interface ReceiptPaymentBadge {
  label: string;
  tone: string;
}

const TONE = {
  paid: '#10b981',
  partial: '#f59e0b',
  overpaid: '#6366f1',
  outstanding: '#ef4444',
  cancelled: '#64748b',
} as const;

export const resolveReceiptPaymentBadge = (
  input: ReceiptPaymentBadgeInput | null | undefined
): ReceiptPaymentBadge => {
  if (input?.isCancelled === true || input?.cancelled === true) {
    return { label: 'CANCELLED', tone: TONE.cancelled };
  }

  const status = String(input?.paymentStatus || input?.status || '').trim().toUpperCase();

  if (status === 'PAID' || status === 'SETTLED') {
    return { label: 'PAID', tone: TONE.paid };
  }
  if (status === 'PARTIALLY PAID' || status === 'PARTIAL') {
    return { label: 'PARTIALLY PAID', tone: TONE.partial };
  }
  if (status === 'OVERPAID') {
    return { label: 'OVERPAID', tone: TONE.overpaid };
  }
  if (status === 'CANCELLED' || status === 'VOIDED' || status === 'VOID') {
    return { label: 'CANCELLED', tone: TONE.cancelled };
  }
  if (!status || status === 'UNPAID' || status === 'PENDING' || status === 'OPEN') {
    return { label: status || 'UNPAID', tone: TONE.outstanding };
  }

  // Unknown but present status: show it verbatim rather than inventing one.
  return { label: status, tone: TONE.outstanding };
};

export const buildReceiptAcknowledgement = (..._args: any[]) => '';