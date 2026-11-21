# Printing Contract — Comparative Analysis & Adoption Plan

**Analysis date:** 2026-11-21
**Reference projects:**
- **Current** — `C:\Users\Rhonald Chiwatu\Desktop\Projects\Printing System` (React + Express + Postgres, mature audit already performed)
- **Reference** — `C:\Users\Rhonald Chiwatu\orca\PrimeERPsystem` (TypeScript contract layer under `contracts/`, document-layout engine, stricter lifecycle/consistency patterns)

**Goal:** Identify which patterns from the PrimeERP `contracts/` layer can be **adopted** into the Printing System **without breaking** the existing implementation (no schema rewrites, no API breaking changes, no rewrite of `printingRecordsService`).

---

## 1. Executive Summary

The PrimeERP `contracts/` directory is a **document-layer contract library**, not a contracts-domain schema. It provides:

| Concern | PrimeERP contract file |
|---|---|
| Generic document model (identity, payload, links, hash) | `DocumentContract.ts` |
| Strict state machine + immutability rules + versioning | `DocumentLifecycle.ts` + `LifecycleDesign.md` |
| Normalized money/invoice payload | `InvoicePayload.ts` + `schemas/invoice-payload.schema.json` |
| Renderer-agnostic layout blueprint | `LayoutBlueprint.ts` + `blueprints/*.json` |
| Absolute-coordinate render tree | `RenderModel.ts` |
| Pre-flight consistency lock (SHA-256 render fingerprint) | `ConsistencyLock.ts` |

The Printing System already has:
- A mature printing-contract domain (`printing_contracts`, `contract_assessment_milestones`, `exam_assessment_batches`)
- A double-entry engine (`accountingEngine.ts`)
- A documents service that renders contract previews + generates invoices (`documentsService.ts`)
- A separate audit report (`PRINTING_CONTRACT_MODULE_AUDIT_REPORT.md`) with 9 critical S1 findings

The PrimeERP contracts layer does **not** directly fix any of those S1 findings (it is about the *document rendering / lifecycle* layer, not about *contract money movement*). However, several patterns are **additive** and can be adopted as new, opt-in layers without touching existing code paths:

1. **Document contract + lifecycle** — adopted as a new module that the existing `documentsService` can delegate to. The current `PrintingContract` entity remains the source of truth; the new `DocumentContract` is a *rendering-time envelope*.
2. **ConsistencyLock** — adopted as a pre-flight validation step inside `documentsService.generateContractPreview` (additive, no breaking change).
3. **Normalized `Money` + `InvoicePayload`** — adopted as a *serialization contract* between `documentsService` and the PDF/print renderer; existing `total_cost`/`profit` columns are unaffected.
4. **LayoutBlueprint + RenderModel** — adopted as an internal, optional render path behind a feature flag. Existing preview rendering keeps working.
5. **State machine with `requiredRole` and `isImmutabilityTrigger`** — adopted as a *pure helper* (`contractLifecycle.ts`) that the existing `printingRecordsService` can call instead of its current ad-hoc `if (status === 'active')` guards. Existing endpoints keep their signatures.
6. **`LifecycleAuditEntry.payloadHash`** — adopted as a new column on the existing `audit_log` payload (additive `payload_hash` field) without changing the audit log schema.

What should **not** be adopted (because it conflicts with the existing implementation):
- PrimeERP's wallet-as-source-of-truth model — Printing System already uses `postJournalEntry` as the source of truth; swapping it would break C-01..C-09 remediation.
- PrimeERP's `prepaid_amount` (commercial figure, separate from wallet) — Printing System's `total_prepaid_amount` + `remaining_balance` are already authoritative and must stay.
- PrimeERP's permissive sync model — Printing System has no sync gateway; adding one is out of scope.
- PrimeERP's contract status names (`draft`/`active`/`completed`/`cancelled`/`amended`) — Printing System uses `pending`/`active`/`exhausted`/`cancelled` and already has a remediation plan; renaming would break the existing UI and the migration.

---

## 2. Side-by-side Comparison

### 2.1 Document Identity & Payload

| Concern | PrimeERP `DocumentContract.ts` | Current Printing System |
|---|---|---|
| Identity | `uid`, `sequenceId`, `type`, `version`, `parentUid`, `tenantId` | `id` (number), `contract_number`, `company_id`, no version chain |
| Lifecycle | `state`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `finalizedAt`, `tags` | `status`, `created_at`, `updated_at`, no `finalizedAt`, no `tags` |
| Payload | Generic `header + lines + totals` | Domain-specific columns on `printing_contracts` + `contract_assessment_milestones` |
| Links | `DocumentLink[]` with `relationship: SOURCE/AMENDMENT/Fulfillment/PAYMENT` | Manual `linked_invoice_id` on milestones; no first-class link table |
| Hash | `hash?: string` (integrity check of the payload) | Not present; audit log has no payload hash |

**Verdict:** PrimeERP's `DocumentIdentity` and `DocumentLink` are **additive** — they can be introduced as a *view model* computed at serialization time. No migration needed if you treat them as a projection.

### 2.2 Lifecycle & Immutability

| Concern | PrimeERP | Current |
|---|---|---|
| States | `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `FINALIZED`, `CANCELLED`, `CLOSED` | `pending`, `active`, `exhausted`, `cancelled` |
| Transitions | `DOCUMENT_TRANSITIONS` table with `requiredRole` and `isImmutabilityTrigger` | Ad-hoc guards inside `printingRecordsService` |
| Immutability | `IMMUTABILITY_RULES: Record<DocumentState, boolean>` | No explicit table; guarded per-service |
| Versioning | `REVISE` action creates v(n+1) with `parentUid` | No versioning; amend mutates in place |

**Verdict:** PrimeERP's transition-table pattern is a **drop-in helper** for the existing service. You do not need to rename states — you can define a Printing-specific transition table that maps current statuses to the same actions.

### 2.3 Money & Invoice Payload

| Concern | PrimeERP | Current |
|---|---|---|
| Money type | `{ amount: string, currency: string, precision: number }` | `NUMERIC(19,4)` columns; client uses `number` |
| Line item | `sequence`, `id`, `description`, `quantity: string`, `uom`, `pricing: { unitPrice, subtotalNet, subtotalGross }` | `description`, `quantity: number`, `rate: number`, `taxable` |
| Discounts | First-class `DiscountDetail[]` | Not modelled at line level |
| Payment summary | `totalPaid`, `totalRemaining`, `status`, `installments[]` | `remaining_balance` on contract; no installments |
| References | `purchaseOrderNumber`, `quotationUid`, `salesOrderUid`, `jobOrderUid` | `postgresContractId`, `postgresMilestoneNumber` (partial) |

**Verdict:** The PrimeERP `InvoicePayload` is **richer** than the current `WorkflowInvoiceLineInput`, but adopting it wholesale would break the existing `documentsService.generateWorkflowInvoice` contract. Instead, adopt it as an **output contract**: `documentsService` continues to accept the existing input, but internally maps to `InvoicePayload` before passing to the renderer. The renderer then never sees `number`-typed money again.

### 2.4 Layout & Rendering

| Concern | PrimeERP | Current |
|---|---|---|
| Layout model | `LayoutBlueprint` (containers, tables, fixed + flow sections, page sizes) | React-based preview; PDF generation ad-hoc |
| Render model | `RenderModel` with absolute coordinates per page | Implicit via React/CSS |
| Consistency | `ConsistencyLock` with SHA-256 fingerprint | Not present |

**Verdict:** PrimeERP's `LayoutBlueprint` + `RenderModel` is a **new, optional rendering path**. The current React preview can stay. The new path can be feature-flagged and used only for the PDF/print export, which is exactly where it adds value (deterministic, testable output).

### 2.5 Audit & Immutability

| Concern | PrimeERP | Current |
|---|---|---|
| Audit entry | `LifecycleAuditEntry` with `payloadHash` | `audit_log` table with `action`, `entity`, `entity_id`, `actor`, `metadata` |
| Hash | SHA-256 of payload at transition | Not computed |
| Reason field | Required for `REJECT`/`VOID` | `notes` field on contract; not enforced |

**Verdict:** PrimeERP's `payloadHash` is **purely additive** — it can be stored as a new optional column on the existing audit log, or as a field inside the `metadata` JSONB. No migration breakage.

---

## 3. What Can Be Adopted Without Breaking Current Implementation

The following adoptions are **non-invasive**. Each is opt-in and leaves the current code paths intact until you choose to switch over.

### A1. Introduce a `DocumentContract` view-model layer (additive, no schema change)

**What:** Add `contracts/DocumentContract.ts` (adapted) to the Printing System's `src/types/`. The existing `PrintingContract` interface stays as-is. A new function `mapContractToDocumentContract(contract, milestones, company)` produces the envelope.

**Why safe:**
- Pure function, no I/O.
- Existing code does not import it until you choose to.
- The mapping uses only fields already present on `PrintingContract` and `ContractAssessmentMilestone`.

**Mapping sketch:**

```ts
// src/types/documentContract.ts (new file, adapted from PrimeERP)
export type DocumentState = 'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'FINALIZED' | 'CANCELLED' | 'CLOSED';

export interface DocumentIdentity {
  uid: string;             // = `contract-${contract.id}`
  sequenceId: string;      // = contract.contract_number
  type: 'PRINTING_CONTRACT' | 'CONTRACT_ASSESSMENT' | 'CONTRACT_INVOICE';
  version: number;         // = 1 for now; REVISE not yet enabled
  parentUid?: string;
  tenantId: string;        // = String(contract.company_id)
}

export interface DocumentLink {
  targetUid: string;
  targetType: DocumentIdentity['type'];
  relationship: 'SOURCE' | 'AMENDMENT' | 'FULFILLMENT' | 'PAYMENT';
}

export interface ERPDocument<THeader, TLine> {
  identity: DocumentIdentity;
  lifecycle: { state: DocumentState; createdAt: string; updatedAt: string; createdBy: string; updatedBy: string; };
  payload: { header: THeader; lines: TLine[]; totals: { subtotal: number; grandTotal: number; currency: string }; };
  metadata: Record<string, unknown>;
  links: DocumentLink[];
  hash?: string;
}
```

**Effort:** ~1 file, ~120 LOC. No DB migration. No API change.

---

### A2. Adopt the `Money` value object for the rendering boundary (additive)

**What:** Introduce `contracts/Money.ts` with the PrimeERP `Money` interface. Use it **only** at the boundary between `documentsService` and the renderer (PDF/layout). The database keeps `NUMERIC(19,4)`. The React preview keeps `number` if it wants.

**Why safe:**
- Pure type, no runtime cost.
- `documentsService.generateContractPreview` currently returns `total_cost: number`. You add a new optional field `money: Money` to the response without removing the existing field.
- The existing `AccountingContext` and `PrintingContractsView` continue to read `number` until you migrate them.

**Mapping:**

```ts
export interface Money {
  amount: string;     // formatDecimal4(total_cost)
  currency: string;   // company.currency_code
  precision: number;  // 4
}
```

**Effort:** ~1 file, ~20 LOC. No DB migration. No breaking API change.

---

### A3. Adopt `DocumentLifecycle` as a pure helper for status transitions (additive)

**What:** Add `src/server/services/contractLifecycle.ts` that exports:
- `CONTRACT_TRANSITIONS` — a transition table mapping current Printing statuses to actions.
- `assertTransition(from, action, role)` — throws `AccountingError` with 409 if the transition is not allowed.
- `IMMUTABILITY_RULES` — `exhausted`/`cancelled` are immutable for amend/add-assessment/remove-assessment.

**Why safe:**
- The helper is *called from* the existing `printingRecordsService` methods; it does not replace them.
- Existing status names (`pending`, `active`, `exhausted`, `cancelled`) are kept.
- Existing endpoints keep their signatures; only the internal guard becomes stricter.

**Transition table (Printing-specific):**

```ts
export const CONTRACT_TRANSITIONS: StateTransition[] = [
  { from: 'START', to: 'pending',  action: 'CREATE' },
  { from: 'pending', to: 'active',  action: 'ACTIVATE' },
  { from: 'pending', to: 'cancelled', action: 'VOID', requiredRole: ['Admin'] },
  { from: 'active',  to: 'exhausted', action: 'COMPLETE', isImmutabilityTrigger: true },
  { from: 'active',  to: 'cancelled', action: 'VOID', requiredRole: ['Admin'] },
  // REVISE is intentionally omitted — Printing System uses amend-in-place for now
];
```

**Effort:** ~1 file, ~80 LOC. No DB migration. No API change. Addresses H-02 and H-04 in the existing audit partially.

---

### A4. Adopt `ConsistencyLock` as a pre-flight check for contract previews (additive)

**What:** Add `src/server/services/contractConsistencyLock.ts` that:
- Accepts the assembled `DocumentContract` (or the existing preview model).
- Runs `checkOverlaps`, `checkPageBoundaries` (only when a `LayoutBlueprint` is present).
- Returns `ValidationResult { isValid, errors, warnings, fingerprint }`.
- `fingerprint` is a SHA-256 of the canonicalized JSON.

**Why safe:**
- Called inside `documentsService.generateContractPreview` **after** the existing assembly, not before.
- If `strictMode` is false (default), `warnings` are logged but do not block the response.
- Existing preview consumers receive the same payload plus an optional `consistency: ValidationResult` field.

**Effort:** ~1 file, ~100 LOC. No DB migration. No breaking API change.

---

### A5. Adopt `LayoutBlueprint` + `RenderModel` as an optional, feature-flagged PDF path (additive)

**What:**
- Add `contracts/LayoutBlueprint.ts`, `contracts/RenderModel.ts`, `contracts/blueprints/contract.prime.classic.json`.
- Add `src/server/services/contractLayoutEngine.ts` that takes a `DocumentContract` + `LayoutBlueprint` and produces a `RenderModel`.
- Add a new endpoint `POST /api/printing/contracts/:id/render` (or extend the existing preview endpoint with `?format=render-model`).
- The existing React preview and the existing `generateContractPreview` endpoint keep working.

**Why safe:**
- New endpoint, new file, no changes to existing endpoints.
- Feature-flagged; the React preview is the default.
- The PDF renderer can consume `RenderModel` directly, eliminating the "preview differs from printout" class of bugs.

**Effort:** ~3 files, ~300 LOC. No DB migration. No breaking API change.

---

### A6. Adopt `LifecycleAuditEntry.payloadHash` as an additive field on audit_log (additive)

**What:** When `printingRecordsService` writes an audit entry, compute a SHA-256 of the canonicalized contract payload at that moment and store it in the existing `audit_log.metadata` JSONB under `payloadHash`.

**Why safe:**
- The `audit_log` table already has a `metadata JSONB` column.
- No schema migration.
- Existing audit queries continue to work.
- Enables tamper-evidence without changing the audit log structure.

**Effort:** ~30 LOC in `printingRecordsService`. No migration.

---

## 4. What Should NOT Be Adopted (and Why)

| Pattern | Why not |
|---|---|
| PrimeERP's `wallet_transactions` as source of truth | Printing System already uses `postJournalEntry` + `bank_transactions`; swapping would break C-01..C-09 remediation and the existing `AccountingContext` contract. |
| PrimeERP's `prepaid_amount` (commercial, separate from wallet) | Printing System's `total_prepaid_amount` + `remaining_balance` are authoritative and tied to GL postings; a second "commercial" figure would create ambiguity. |
| PrimeERP's sync gateway (`POST /api/sync/ops`) | Printing System is server-authoritative; adding a sync gateway would introduce the dual-write problem the existing audit already flags (C-08, C-09). |
| Renaming `exhausted` → `completed` or `pending` → `draft` | Breaks existing UI, existing tests, and the existing remediation plan. Keep current status names; add a separate `DocumentState` projection for the new contract layer if needed. |
| PrimeERP's `REVISE` (void & replace) for contracts | Printing System's `amendPrintingContract` already mutates in place with an audit trail; adding void-and-replace would break the existing `amend` workflow. Defer until the existing remediation plan is complete. |
| Replacing `number`-typed money with `Money` everywhere | Too invasive. Adopt only at the rendering boundary (A2). |
| PrimeERP's `requiredRole: ['Manager', 'Admin']` semantics | Printing System has its own permission model (`printing:write`, `invoices:write`, `estimates:read_costs`). Map actions to existing permissions rather than inventing new role names. |

---

## 5. Recommended Adoption Order (Non-Breaking)

The adoptions are ordered by risk and dependency. Each step is independently shippable.

| Phase | Adoption | Risk | Depends on |
|---|---|---|---|
| 1 | A3 — `contractLifecycle.ts` helper (pure) | Very low | — |
| 2 | A6 — `payloadHash` on audit_log.metadata | Very low | — |
| 3 | A2 — `Money` value object at render boundary | Low | — |
| 4 | A1 — `DocumentContract` view-model | Low | A2 (optional) |
| 5 | A4 — `ConsistencyLock` pre-flight for previews | Low | A1 (optional) |
| 6 | A5 — `LayoutBlueprint` + `RenderModel` feature-flagged PDF path | Medium | A1, A2, A4 |
| 7 | Wire A5 into `documentsService` behind `?format=render-model` | Medium | A5 |
| 8 | Deprecate the React preview only after A5 has been in production for one release | High (deferred) | All above |

**Critical rule:** Do not begin Phase 6 until the existing remediation plan for the 9 S1 findings is complete. The new document layer does not fix financial-correctness defects, and layering it on top of an unresolved C-08/C-09 would make the dual-write problem harder to diagnose.

---

## 6. Concrete Mapping: PrimeERP → Printing System

| PrimeERP artifact | Printing System destination | Change type |
|---|---|---|
| `contracts/DocumentContract.ts` | `src/types/documentContract.ts` (new) | Additive |
| `contracts/DocumentLifecycle.ts` | `src/server/services/contractLifecycle.ts` (new) | Additive |
| `contracts/InvoicePayload.ts` | `src/types/invoicePayload.ts` (new) + used by `documentsService` output | Additive (output only) |
| `contracts/LayoutBlueprint.ts` | `contracts/LayoutBlueprint.ts` (new) | Additive |
| `contracts/RenderModel.ts` | `contracts/RenderModel.ts` (new) | Additive |
| `contracts/ConsistencyLock.ts` | `src/server/services/contractConsistencyLock.ts` (new) | Additive |
| `contracts/blueprints/invoice.prime.classic.json` | `contracts/blueprints/contract.prime.classic.json` (new, adapted) | Additive |
| `contracts/schemas/*.json` | `contracts/schemas/*.json` (new, adapted) | Additive |
| `contracts/LifecycleDesign.md` | `docs/contract-lifecycle.md` (adapted) | Documentation |

---

## 7. Verification Plan

After each phase, run the existing verification commands to confirm no regression:

```bash
# Type check
bun run tsc --noEmit

# Existing tests
bun test

# Migration suite (must still pass with 0 schema changes)
bun tests/db/migration-suite.ts

# Existing audit findings must not regress
# (Manually re-verify C-01..C-09 are not made worse by the new layer)
```

For A5 specifically, add a golden-file test:

```ts
// tests/contracts/render-golden.test.ts
import { mapContractToDocumentContract } from '../../src/types/documentContract';
import { renderDocument } from '../../src/server/services/contractLayoutEngine';
import blueprint from '../../contracts/blueprints/contract.prime.classic.json';

test('render contract matches golden model', () => {
  const contract = seedContractFixture();
  const doc = mapContractToDocumentContract(contract, contract.milestones, company);
  const model = renderDocument(doc, blueprint);
  expect(model).toMatchSnapshot();
});
```

---

## 8. Summary

The PrimeERP `contracts/` layer is a **document-engine contract**, not a contracts-domain schema. It can be adopted additively into the Printing System without breaking anything, provided you:

1. Keep the existing `printing_contracts` / `contract_assessment_milestones` schema as the source of truth.
2. Treat PrimeERP's `DocumentContract`, `Money`, `LayoutBlueprint`, `RenderModel`, `ConsistencyLock` as **projection/render-time** layers, not as replacements.
3. Adapt PrimeERP's state names to the existing Printing System statuses via a transition table, not by renaming.
4. Land the adoptions **after** the existing 9 S1 remediation is complete, because the document layer does not fix financial correctness and would complicate the dual-write diagnosis if layered too early.