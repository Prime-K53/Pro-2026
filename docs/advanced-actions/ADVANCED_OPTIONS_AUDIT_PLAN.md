# Advanced Options — Audit & Implementation Plan

## Scope
Implement the "advanced option" contextual action sets for:
1. Invoices (sales ledger)
2. Printing Contracts (contract register + assessment schedule)

Constraint: backend remains authoritative; no unrestricted editing/deletion of posted financial transactions; reuse existing services/workflows; no duplicate wallet deduction or job-order logic.

## Audit — Invoices
Existing endpoints (salesRoutes.ts):
- GET /invoices, GET /invoices/:id, POST /invoices, POST /invoices/:id/void
- POST /invoices/:id/remind
- GET /payments, POST /payments, POST /payments/:id/void
- GET /credit-memos, POST /credit-memos, POST /credit-memos/:id/apply, POST /credit-memos/:id/void
- GET /customers/:id/statement
- GET /estimates, POST /estimates, approve/reject/convert

Existing frontend (InvoicesView):
- View & Print (document preview)
- Receive Payment (opens payment modal; supports partial via amount)
- Send Payment Reminder
- Void Document (Reverse GL) with confirmation
- Copy Document #
- Credit Memo create/apply/void flows
- Customer Statement modal (global)

Gaps for requested advanced actions:
- Edit draft invoice: no PATCH /invoices/:id endpoint; would need backend + draft-only guard.
- Duplicate invoice: no duplicate endpoint; can add POST /invoices/:id/duplicate reusing create logic.
- Download PDF: no dedicated PDF endpoint; can use print-to-PDF via preview or add export.
- Email invoice: no email send endpoint; reminder endpoint exists (logs reminder). Could add /invoices/:id/email.
- Share invoice: no public share link; could copy a deep link or generate share token.
- Receive partial payment: already supported via Receive Payment amount/allocation.
- View payment history: filter payments by invoice (client-side from payments list).
- View customer statement: CustomerStatementModal exists; can open with customer selected.
- Create credit note: Credit Memo modal exists.
- Process refund: no refund endpoint; could be modeled as credit memo or void payment; needs backend policy.
- Record internal note: invoice has notes field but no PATCH; could add PATCH /invoices/:id/notes (draft only or append-only audit).
- View audit history: audit logs exist (audit.ts) but no per-invoice audit query endpoint.
- View related sales order / job order: no explicit links in ApiInvoice; could filter by customer or pass through.

## Audit — Printing Contracts
Existing endpoints (printingRoutes.ts):
- POST /printing/contracts (create)
- POST /printing/jobs/:id/invoice, cancel, reprint, etc.
- No contract view/amend/activate/cancel/renew/assessment endpoints.

Existing frontend (PrintingContractsView):
- Contract register with assessment schedule
- Generate retainer/milestone invoices
- Deduct assessment (creates deduction target)
- Open examination module

Gaps: nearly all requested contract actions lack backend. Need new contract management endpoints (GET/PATCH/activate/cancel/renew/amend, assessment add/remove, wallet transactions, production progress, history). Wallet deduction behavior must not be duplicated; reuse existing deduction flow.

## Plan (phased)
Phase A (this pass): Invoices frontend advanced actions that can be wired now:
- Download PDF (print preview)
- Email invoice (reuse reminder endpoint + notice; add dedicated endpoint later)
- Share invoice (copy deep link)
- View payment history (filter payments by invoice; open a small modal/list)
- View customer statement (open statement modal for invoice customer)
- Create credit note (open credit memo modal prefilled)
- View audit history (open a modal listing audit entries for invoice if available; else notice)
- View related sales order / job order (navigate/filter)
- Receive partial payment (already; add explicit "Receive Partial Payment" alias)
- Process refund (alias to create credit memo / void payment notice)
- Record internal note (append to notes via prompt + reload; requires endpoint later)
- Edit draft invoice (disabled unless backend exists; add endpoint later)
- Duplicate invoice (add endpoint + action)
Phase B: Backend endpoints for edit/duplicate/email/share/notes/audit/related + contract management.
Phase C: Printing Contracts backend + frontend advanced actions.

## Safety
- Posted invoices cannot be edited/deleted; only draft invoices editable.
- Void remains the only reversal path for posted documents.
- Contract wallet deductions reuse existing deduction target flow; no new deduction logic.
- All mutations go through existing/added backend endpoints with permission guards.
