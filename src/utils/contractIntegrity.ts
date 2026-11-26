/**
 * Contract content-integrity helpers.
 *
 * Produces a deterministic SHA-256 hash over the canonical (key-sorted) form of
 * the material contract fields, plus a short human-readable code. Volatile
 * fields (timestamps, server ids) are excluded so the hash is stable across
 * reads and matches the value printed on the document.
 */

import type { PrintingContract } from '../types/accounting';

/** Deterministic JSON with sorted object keys (stable across key order). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** The subset of contract fields covered by the integrity hash. */
export function contractIntegrityMaterial(contract: PrintingContract): Record<string, unknown> {
  return {
    contractNumber: contract.contractNumber,
    schoolCustomerId: contract.schoolCustomerId,
    title: contract.title,
    academicYear: contract.academicYear,
    startDate: contract.startDate,
    endDate: contract.endDate,
    totalPrepaidAmount: contract.totalPrepaidAmount,
    totalAssessments: contract.totalAssessments,
    depositBankAccountId: contract.depositBankAccountId,
    assessments: contract.assessments.map(a => ({
      assessmentNumber: a.assessmentNumber,
      label: a.label,
      scheduledDate: a.scheduledDate,
      agreedAmount: a.agreedAmount,
      status: a.status,
    })),
  };
}

/** Lowercase hex SHA-256 of a string (uses the Web Crypto API). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Short, human-readable integrity code (e.g. `4849-ad3f-40b8`). */
export function shortIntegrityCode(hash: string): string {
  const h = hash.replace(/[^a-f0-9]/gi, '').toLowerCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

/** Compute the integrity hash + short code for a contract. */
export async function computeContractIntegrity(
  contract: PrintingContract
): Promise<{ hash: string; shortCode: string }> {
  const canonical = stableStringify(contractIntegrityMaterial(contract));
  const hash = await sha256Hex(canonical);
  return { hash, shortCode: shortIntegrityCode(hash) };
}