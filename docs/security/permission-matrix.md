# Phase 3 — Role-Based Access Control (RBAC) Permission Matrix

All permissions below are enforced server-side via `requirePermission(...)` middleware in `/src/server/middleware/auth.ts` backed by `/src/server/permissions.ts`. Client-side UI states mirror these rules for usability only and are never trusted for security decisions.

## 1. Five-Role Matrix (Preserving `SlowBooks-Pro-2026` + Printing Production Domain)

| Capability | Administrator | Bookkeeper | Accountant | ProductionManager | Read-Only |
|---|:---:|:---:|:---:|:---:|:---:|
| `companies:create` | Allow | — | — | — | — |
| `companies:settings:write` | Allow | — | — | — | — |
| `users:list` / `users:invite` / `users:manage` | Allow | — | — | — | — |
| `audit:read` | Allow | — | Allow | — | — |
| `accounts:read` | Allow | Allow | Allow | Allow | Allow |
| `accounts:write` | Allow | Allow | — | — | — |
| `journals:read` | Allow | Allow | Allow | — | Allow |
| `journals:write` | Allow | Allow | Allow | — | — |
| `invoices:read` | Allow | Allow | Allow | Allow | Allow |
| `invoices:write` | Allow | Allow | — | — | — |
| `estimates:read` | Allow | Allow | Allow (Redacted) | Allow | Allow (Redacted) |
| `estimates:read_costs` (`unitCost`, `totalCost`, `estimatedProfit`) | Allow | Allow | — | Allow | — |
| `estimates:write` | Allow | Allow | — | Allow | — |
| `inventory:read` | Allow | Allow | Allow | Allow | Allow |
| `inventory:write` | Allow | Allow | — | Allow | — |
| `printing:read` | Allow | Allow | Allow | Allow | Allow |
| `printing:write` | Allow | Allow | — | Allow | — |
| `employees:read` | Allow | Allow (Redacted) | — | — | Allow (Redacted) |
| `employees:read_sensitive` (`payRate`, `ssnMasked`) | Allow | — | — | — | — |
| `employees:write` | Allow | — | — | — | — |
| `payroll:read` / `payroll:write` | Allow | — | — | — | — |
| `reports:read` | Allow | Allow | Allow | Allow | Allow |
| `reports:export` | Allow | Allow | Allow | — | — |
| `reports:schedule` | Allow | — | Allow | — | — |
| `approvals:read` | Allow | Allow | Allow | Allow | — |
| `approvals:decide` | Allow | — | Allow | — | — |
| `approvals:configure` | Allow | — | — | — | — |
| `periods:close` | Allow | — | Allow | — | — |
| `periods:reopen` | Allow | — | — | — | — |
| `attachments:read` | Allow | Allow | Allow | Allow | Allow |
| `attachments:write` | Allow | Allow | — | Allow | — |

## 2. Special Domain & Safety Rules

1. **Last-Administrator Guard (`409 Conflict`):** Neither `PATCH /api/users/:userId/membership` nor `DELETE /api/users/:userId/membership` permits demoting, deactivating, or revoking the last active `Administrator` in a company.
2. **Self-Deactivation Guard (`409 Conflict`):** `POST /api/users/:userId/deactivate` blocks an Administrator from deactivating their own global user account while logged in.
3. **SlowBooks `#824` Estimate Cost Redaction:** `Accountant` and `Read-Only` receive estimate totals/customer lines with `totalCost` and `estimatedProfit` stripped server-side (`costDetailsIncluded: false`).
4. **SlowBooks HR & Payroll Isolation:** Only `Administrator` may view payroll runs (`/api/payroll/runs`) or employee compensation/SSN details. `Bookkeeper` and `Read-Only` receive public contact directory fields only; `Accountant` and `ProductionManager` receive `403 Forbidden`.
5. **Maker-Checker Segregation of Duties:** Approval policies are configured by `Administrator` (`approvals:configure`). Requests can be raised by any role that can create the underlying document. Approval/rejection requires `approvals:decide` (`Administrator` or `Accountant`), and the requester can never approve their own request (`409 SELF_APPROVAL_FORBIDDEN`). The approved document is created only when the creation route is retried with `approvalRequestId`; the request is then marked consumed and cannot be reused.
6. **Period Close Enforcement:** Checklist tasks are generated from ledger evidence (trial balance, bank reconciliation, AR/AP/inventory subledger ties, pending approvals) plus manual governance sign-off. When `period_close_requires_checklist` is enabled, `/api/periods/:id/close` and `/soft-close` return `409 CLOSE_CHECKLIST_INCOMPLETE` until every required task is complete or explicitly waived with a note.
