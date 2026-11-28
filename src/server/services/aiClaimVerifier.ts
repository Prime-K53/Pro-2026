/**
 * D-06 deterministic claim verification.
 *
 * A model-produced financial claim is only "verified" when every field matches
 * an authoritative EvidenceItem produced by the server for THIS request. This is
 * typed field comparison (exact 4-dp decimal, currency, status, date, entity),
 * never naive substring/number matching. The model cannot mint evidence ids and
 * cannot attach a genuine citation to an unrelated claim.
 *
 * Two claim shapes are supported:
 *  - Row-level claims (`claimType` = balance|total|quantity): resolved to a
 *    single distinct entity by name/id (never by amount) and matched field-wise.
 *  - Report-level aggregates (`claimType` = aggregate): resolved to a single
 *    authoritative report row (one recordId) and matched field-wise. An
 *    aggregate may never span multiple records or combine unrelated rows.
 */
import type { EvidenceItem, EvidenceRecordType, EvidenceSet } from './aiFinancialGrounding.ts';
import { normMoney } from './aiFinancialGrounding.ts';

export interface FinancialClaim {
  claimType: 'balance' | 'total' | 'quantity' | 'aggregate';
  metric: string;
  entity?: string;
  recordType?: EvidenceRecordType;
  amount?: string;
  currency?: string | null;
  unit?: string | null;
  date?: string | null;
  status?: string | null;
  evidenceIds: string[];
  explanation?: string;
}

export interface Citation {
  evidenceId: string;
  kind: EvidenceRecordType;
  id: number;
  label: string;
}

export interface VerifiedClaim extends FinancialClaim {
  citations: Citation[];
}

export interface ClaimRejection {
  claim: FinancialClaim;
  reason: string;
}

export interface ClaimVerdict {
  verified: VerifiedClaim[];
  rejected: ClaimRejection[];
}

function hasAmount(c: FinancialClaim): boolean {
  return c.amount !== undefined && c.amount !== null && String(c.amount).trim() !== '';
}

const distinctIds = (arr: EvidenceItem[]): number[] =>
  Array.from(new Set(arr.map((it) => it.recordId)));

/** Verify claims against the evidence set. Pure/deterministic (no DB, no model). */
export function verifyClaims(claims: FinancialClaim[], set: EvidenceSet): ClaimVerdict {
  const byId = new Map<string, EvidenceItem>();
  for (const it of set.items) {
    if (it.companyId === set.companyId) byId.set(it.evidenceId, it);
  }

  const verified: VerifiedClaim[] = [];
  const rejected: ClaimRejection[] = [];

  for (const claim of claims) {
    if (!hasAmount(claim)) {
      // Not a financial assertion; handled as free-form explanation, not verified.
      rejected.push({ claim, reason: 'no_financial_amount' });
      continue;
    }

    const want = normMoney(claim.amount);
    const ids = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
    if (ids.length === 0) {
      rejected.push({ claim, reason: 'no_evidence' });
      continue;
    }

    // Every referenced id must exist in THIS request's set (blocks invented ids
    // and cross-company ids — the set only contains this company's items).
    const items: EvidenceItem[] = [];
    let unknown = false;
    for (const id of ids) {
      const it = byId.get(id);
      if (!it) {
        unknown = true;
        break;
      }
      items.push(it);
    }
    if (unknown) {
      rejected.push({ claim, reason: 'unknown_evidence' });
      continue;
    }

    // The claim's metric must exist on the supporting item(s).
    const metric = claim.metric;
    if (!metric || items.some((it) => !(metric in it.fields))) {
      rejected.push({ claim, reason: 'metric_not_in_evidence' });
      continue;
    }

    // Eligible set: evidence items of the claimed record type (if specified).
    const eligible = claim.recordType ? items.filter((it) => it.recordType === claim.recordType) : items;
    if (eligible.length === 0) {
      rejected.push({ claim, reason: 'record_type_mismatch' });
      continue;
    }

    // ── Report-level aggregate: resolve to exactly ONE authoritative report
    // row and match the metric field-wise. Never spans records, never resolved
    // by amount. ──
    if (claim.claimType === 'aggregate') {
      const distinct = distinctIds(eligible);
      if (distinct.length !== 1) {
        // An aggregate may never combine unrelated records.
        rejected.push({ claim, reason: 'unsupported_aggregate' });
        continue;
      }
      const resolved = eligible.find((it) => it.recordId === distinct[0])!;
      if (normMoney(resolved.fields[metric]) !== want) {
        rejected.push({ claim, reason: 'amount_mismatch' });
        continue;
      }
      if (claim.currency && resolved.currency && claim.currency !== resolved.currency) {
        rejected.push({ claim, reason: 'currency_mismatch' });
        continue;
      }
      if (claim.status && resolved.status && claim.status !== resolved.status) {
        rejected.push({ claim, reason: 'status_mismatch' });
        continue;
      }
      if (claim.date && resolved.txnDate && claim.date !== resolved.txnDate) {
        rejected.push({ claim, reason: 'date_mismatch' });
        continue;
      }
      verified.push({
        ...claim,
        citations: [{ evidenceId: resolved.evidenceId, kind: resolved.recordType, id: resolved.recordId, label: resolved.label }],
      });
      continue;
    }

    // ── Deterministic UNIQUE entity resolution. Amount NEVER participates in
    // choosing the entity (that is the D-06/R1-C defect being corrected). ──
    let resolved: EvidenceItem;
    if (claim.entity !== undefined && String(claim.entity).trim() !== '') {
      const e = String(claim.entity).toLowerCase().trim();
      const firstTok = (s: string) => s.toLowerCase().trim().split(/\s+/)[0];
      const byIdMatch = eligible.filter((it) => String(it.recordId) === e);
      const byExact = eligible.filter((it) => it.label.toLowerCase().trim() === e);
      const byToken = eligible.filter((it) => firstTok(it.label) === e);
      const pool = byIdMatch.length > 0 ? byIdMatch : byExact.length > 0 ? byExact : byToken;
      const distinct = distinctIds(pool);
      if (distinct.length === 0) {
        rejected.push({ claim, reason: 'entity_mismatch' });
        continue;
      }
      if (distinct.length > 1) {
        // Multiple distinct entities share the token/name — never pick by amount.
        rejected.push({ claim, reason: 'ambiguous_entity' });
        continue;
      }
      resolved = pool.find((it) => it.recordId === distinct[0])!;
    } else {
      // No entity supplied: amount must resolve to exactly one distinct entity.
      const amt = eligible.filter((it) => normMoney(it.fields[metric]) === want);
      const distinct = distinctIds(amt);
      if (distinct.length === 0) {
        rejected.push({ claim, reason: 'amount_mismatch' });
        continue;
      }
      if (distinct.length > 1) {
        rejected.push({ claim, reason: 'ambiguous_entity' });
        continue;
      }
      resolved = amt.find((it) => it.recordId === distinct[0])!;
    }

    // Amount must match the RESOLVED entity's authoritative field.
    if (normMoney(resolved.fields[metric]) !== want) {
      rejected.push({ claim, reason: 'amount_mismatch' });
      continue;
    }
    if (claim.currency && resolved.currency && claim.currency !== resolved.currency) {
      rejected.push({ claim, reason: 'currency_mismatch' });
      continue;
    }
    if (claim.status && resolved.status && claim.status !== resolved.status) {
      rejected.push({ claim, reason: 'status_mismatch' });
      continue;
    }
    if (claim.date && resolved.txnDate && claim.date !== resolved.txnDate) {
      rejected.push({ claim, reason: 'date_mismatch' });
      continue;
    }

    // Cite every evidence row for the resolved entity (dedupe by record id).
    const seen = new Set<number>();
    const citations: Citation[] = [];
    for (const it of eligible) {
      if (it.recordId === resolved.recordId && !seen.has(it.recordId)) {
        seen.add(it.recordId);
        citations.push({ evidenceId: it.evidenceId, kind: it.recordType, id: it.recordId, label: it.label });
      }
    }
    verified.push({ ...claim, citations });
  }

  return { verified, rejected };
}