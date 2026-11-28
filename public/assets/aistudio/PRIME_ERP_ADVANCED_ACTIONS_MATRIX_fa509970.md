# PRIME ERP Advanced Actions Matrix

**Purpose:** Recommended contextual actions by discovered module/record type.  
**Design principle:** Actions must be **status-aware, permission-aware, transaction-aware**, and must invoke **existing verified backend/service workflows** where available. Actions not backed by verified capabilities are marked `MISSING`, `PARTIAL`, or `UNVERIFIED`.

## Legend
- **Capability:** `Implemented` (UI/action exists and wired), `Partial` (some workflow exists), `Missing` (no verified implementation), `Unsafe` (must not be offered as direct/uncontrolled operation), `UNVERIFIED`.
- **Priority:** `P0` critical financial/security, `P1` essential operational, `P2` productivity, `P3` UX/convenience.

## A. Dashboard
| Record/context | Action | Capability | Preconditions (status/permission) | Backend/service dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| KPI / metric card | View underlying transactions (drill-down) | Partial/UNVERIFIED | `reports:read` | `reportsRoutes.ts`, domain list/report APIs | Audit: read-only | P2 |
| Overdue invoices widget | Open invoice / Receive payment | Partial | Invoice open & `invoices:read`/`invoices:write` | `salesRoutes.ts` (`/invoices`, `/payments`) | Confirm none for view | P1 |
| Outstanding bills widget | Open bill / Pay bill | Partial | Bill open & `bills:read`/`bills:write` | `purchasingRoutes.ts` | Payment confirm | P1 |
| Stock alerts | Open inventory item / Adjust or requisition | Partial | `inventory:read` (+`inventory:write`/`bills:write`) | Inventory/procurement services | Confirm for stock/financial effects | P1 |
| Financial summary | Export/print/compare periods | Partial/UNVERIFIED | `reports:read`/`reports:export` | Reports/export services | Audit export if implemented | P2 |

## B. Customers (`CustomersView`, `salesRoutes`)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Customer | View profile/details | Implemented/Partial | `customers:read` | `GET /customers` | Read-only | P1 |
| Customer | Edit customer | Partial | `customers:write`, active record | `PATCH /customers/:id` | Audit recommended | P1 |
| Customer | View invoices / estimates / payments / orders history | Partial | `customers:read` + related read perms | Sales list/filter endpoints | Read-only | P1 |
| Customer | View/generate statement | Implemented/Partial | `customers:read` | `GET /customers/:id/statement` | Audit snapshot if saved | P1 |
| Customer | View outstanding balance / aging | Partial | `customers:read` | AR aging/report/customer balance fields | Read-only | P1 |
| Customer | View wallet/referral/credit info | Missing/UNVERIFIED | N/A | No verified wallet/referral modules | N/A | P2/P3 (gap) |
| Customer | Print/export transactions | Partial/UNVERIFIED | `customers:read`/`reports:export` | Reporting/export/documents | Audit export | P2 |
| Customer | Deactivate customer | Missing/UNVERIFIED | `customers:write`, no blocking open balance policy (UNVERIFIED) | Customer update/status endpoint `UNVERIFIED` | Confirm + audit | P2 |

## C. Invoices (`InvoicesView`, `salesRoutes`, `documentsRoutes`)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Invoice/Sales Receipt | View / Preview / Print / Download PDF | Implemented/Partial | `invoices:read` | `documentsApi` preview, document generation | Read-only/audit access optional | P1 |
| Invoice (draft/editable) | Edit draft | Partial/UNVERIFIED | `invoices:write`, draft & not posted/voided | Invoice update endpoint `UNVERIFIED` | Confirm save + audit | P1 |
| Invoice | Duplicate | Partial/UNVERIFIED | `invoices:write` | Create invoice from template/client copy logic `UNVERIFIED` | Confirm | P2 |
| Invoice | Email/share/send reminder | Partial | `invoices:read`/write as applicable, comms configured | Communications/reminder endpoints/services | Audit send | P2 |
| Invoice (open/partial/overdue) | Receive payment / partial payment | Implemented/Partial | `invoices:write`, status not `paid/voided`, balance > 0 | `POST /payments` (sales) | Confirm amount/allocation; idempotency required | P0/P1 |
| Invoice | View payment history / allocations | Partial | `invoices:read` | `GET /payments`, invoice detail joins | Read-only | P1 |
| Invoice | Create/apply credit memo | Partial | `invoices:write`, eligible balance/status | Credit memo create/apply endpoints | Confirm financial impact + audit | P0/P1 |
| Invoice | Process refund | Missing/UNVERIFIED | Authorized finance workflow required | Refund workflow not verified | Confirm + dual control recommended | P1 (gap) |
| Invoice | Void invoice | Partial | `invoices:write`, not already voided, financial controls/period checks | `POST /invoices/:id/void` (evidenced in route) | **Strong confirm + reason + audit** | P0 |
| Invoice | View audit/history/related docs | Partial/UNVERIFIED | `invoices:read`/`audit:read` as needed | Audit/document linkage APIs | Read-only | P2 |

**Unsafe/forbidden:** direct delete/edit of posted financial records, silent re-posting, duplicate payment submission.

## D. Estimates / Quotations
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Estimate | View/preview/print/download/email | Partial | `estimates:read` | `listEstimates`, documents/comms | Read-only/audit send | P1 |
| Estimate (draft/pending) | Edit | Partial/UNVERIFIED | `estimates:write` | Update endpoint `UNVERIFIED` | Audit | P1 |
| Estimate | Duplicate / Revise / Version history | Partial/Missing/UNVERIFIED | `estimates:write` | Revision model not fully verified | Confirm | P2 |
| Estimate | Approve / Reject | Partial | `estimates:write` or approval policy gate, status pending | `approveEstimate`/`rejectEstimate` in sales service/routes | Audit (+ approval) | P1 |
| Estimate | Convert to invoice / sales order | Partial | Accepted/eligible, `estimates:write` + `invoices:write` | `convertEstimateToInvoice`; sales-order target `UNVERIFIED` | Confirm + idempotency | P1 |
| Estimate | Mark expired / Cancel | Partial/UNVERIFIED | Eligible non-terminal status | Status update endpoint `UNVERIFIED` | Audit | P2 |

## E. Sales Orders
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Sales Order | All listed (view/edit/confirm/fulfill/convert/cancel/etc.) | **Missing/UNVERIFIED** | N/A | No dedicated sales-order view/route/entity evidenced in sampled inventory | N/A | P1 (if required by business) |

## F. Job Orders (Printing Jobs / Quick Print / Exam-linked jobs)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Printing/Quick-print job | View/preview/print job card or receipt | Partial | `printing:read` / document read | `printingApi`, `documentsApi` | Read-only | P1 |
| Job (eligible) | Edit/schedule/assign operator/machine | Partial/UNVERIFIED | `printing:write`, status allows | `printingRoutes.ts`, `productionService.ts` | Audit | P1 |
| Job | Start/pause/resume/complete/QA transitions | Partial | `printing:write`, valid status transitions | Production workflow services/routes | Audit state change | P1 |
| Job | Record material usage/wastage/quantity | Partial | `printing:write` + `inventory:write` as required | Inventory/production posting services | Confirm inventory impact | P0/P1 |
| Job | Generate delivery/invoice (where supported) | Partial | Eligible status/linkage, `invoices:write` | Printing-sales/document integration | Confirm + idempotency | P1 |
| Job | View production/cost/audit history | Partial/UNVERIFIED | `printing:read`/`reports:read` | Reports/production records | Read-only | P2 |

## G. Production (Operations/Batches/Finishing/QC)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Production batch/operation | View, assign, schedule, record consumption/wastage/output, QC disposition, approve/reprint request | **Partial/UNVERIFIED** | `printing:write`, status/stage-valid | `productionService.ts`, `printingRoutes.ts`, inventory services | Audit + confirmations for material/cost impact | P1 |

## H. Delivery and Dispatch
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Delivery note/dispatch | View/assign/schedule/dispatch/confirm/partial/fail/reschedule/print/signature capture | **Partial/UNVERIFIED** | `printing:read/write` or delivery perms (if defined), status-valid | Delivery entities/routes/services evidenced in schema/docs; UI exposure `UNVERIFIED` | Audit; prevent duplicate confirmations | P1 |

## I. Inventory (`InventoryView`, inventory/commercial services)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Inventory item | View/edit details | Partial | `inventory:read`/`inventory:write` | `commercialApi.updateInventoryItem` / inventory endpoints | Audit | P1 |
| Item | View stock ledger/movements/valuation/BOM/consumption | Partial/UNVERIFIED | `inventory:read`, `reports:read` for valuation | Inventory/report services | Read-only | P1 |
| Item (stocked) | Adjust stock / stock count / damage / transfer | Partial | `inventory:write`, valid qty/location rules | Stock adjustment endpoints/services (adjust evidenced in UI/service usage) | **Confirm + reason + audit; prevent unauthorized direct qty edits** | P0/P1 |
| Item | Generate purchase requisition/request | Partial | `bills:write`/procurement perms | Procurement/requisition endpoints | Confirm | P2 |
| Item | View supplier/transaction history | Partial/UNVERIFIED | Related read perms | Purchasing/inventory linkage queries | Read-only | P2 |
| Item | Deactivate item | Partial/UNVERIFIED | `inventory:write`, not referenced by blocking open workflows | Update/deactivate endpoint `UNVERIFIED` | Confirm + audit | P2 |

## J. Purchase Orders (`BillsView`/purchasing domain)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| PO (draft/open) | View/edit/duplicate | Partial/UNVERIFIED | `bills:read/write` | `list/create/update PO` (`update/duplicate UNVERIFIED`) | Audit | P1 |
| PO | Approve/reject/send to supplier/print/cancel | Partial/UNVERIFIED | Approval policy/role/status | `approvalRoutes`, PO status endpoints, documents/email | Confirm + audit | P1 |
| PO | Receive goods / partial receipt / convert to bill | Partial | `bills:write`, receivable status | Receive/GRN/bill-from-PO endpoints in purchasing/procurement | Confirm qty/financial impact + idempotency | P0/P1 |
| PO | View received items/audit history | Partial/UNVERIFIED | `bills:read` | GRN/PO detail/audit APIs | Read-only | P2 |

## K. Bills and Expenses (`BillsView`, `purchasingRoutes`)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Bill | View/edit eligible/attach docs/print | Partial | `bills:read/write`, `attachments:write` | Bill/document/attachment APIs | Audit | P1 |
| Bill | Approve/reject/schedule/pay/partial pay | Partial | Approval/permission/status, open balance | Approval + `recordBillPayment` | Confirm payment/allocation | P0/P1 |
| Bill | View payment history / vendor statement | Partial | `bills:read`, `vendors:read` | Payment list, vendor statement endpoint | Read-only | P1 |
| Bill | Void/reverse through authorized workflow | Partial | `bills:write`, eligible, period controls | `POST /bills/:id/void` (evidenced) or reversal workflow | **Strong confirm + reason + audit** | P0 |

## L. Vendors (`VendorsView`, `purchasingRoutes`)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Vendor | View/edit profile | Partial | `vendors:read/write` | Vendor list/create/update endpoints | Audit | P1 |
| Vendor | View purchase history/outstanding bills/payments/ledger/statement | Partial | `vendors:read`, `bills:read` | Bills/PO/payments/statement APIs | Read-only | P1 |
| Vendor | Print/export/deactivate | Partial/UNVERIFIED | `vendors:read/write`, `reports:export` | Export/deactivate support `UNVERIFIED` | Confirm + audit | P2 |

## M. Banking (`BankingRegisterView`, `BankReconciliationView`, `bankingRoutes`)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Bank transaction | View/categorize/match/unmatch/split/transfer | Partial/UNVERIFIED | `banking:read/write` | Banking service/routes | Audit | P1 |
| Reconciliation | Reconcile / view linked docs / reverse eligible | Partial | `banking:reconcile` (+write as needed) | Reconciliation endpoints/services | Confirm + audit; preserve lock rules | P0/P1 |
| Bank transaction | Export details | Partial/UNVERIFIED | `banking:read`/`reports:export` | Export/reporting | Audit export | P2 |

## N. Chart of Accounts (`ChartOfAccountsView`, `accountingRoutes`)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Account | View/edit ledger/activity/balance | Partial | `accounts:read/write` | Account and ledger APIs | Audit | P1 |
| Account | View linked transactions/audit history | Partial/UNVERIFIED | `accounts:read`/`journals:read`/`audit:read` | Journal/report/audit queries | Read-only | P2 |
| Account | Deactivate eligible account | Partial/UNVERIFIED | `accounts:write`, no posted-history/delete constraints violated | Account update endpoint/policy `UNVERIFIED` | Confirm + audit | P1 |
| Account | Delete account with history | **Unsafe / must not offer** | N/A | Violates accounting integrity | Blocked | P0 |

## O. Journal Entries
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Journal (draft) | View/edit/duplicate/validate/post | Partial/UNVERIFIED | `journals:read/write`, balanced, open period | `accountingRoutes.ts`, `accountingEngine.ts` | Confirm post + audit | P0/P1 |
| Journal (posted) | View/reverse via approved workflow / print / GL impact | Partial | `journals:read/write` as applicable, reversal rules | Reversal endpoint/service | **No direct edit/delete; confirm reversal** | P0 |

## P. Customer Wallet
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Wallet | View ledger/deposit/deduct/credit/refund/reconcile/statement | **Missing/UNVERIFIED** | N/A | No verified wallet domain/module found | N/A (do not invent) | P1 (business gap) |

## Q. Printing Contracts (`PrintingContractsView`)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Contract | View/preview/edit draft/activate/cancel/renew/amend | Partial/UNVERIFIED | `printing:read/write` and/or commercial perms by workflow | `printingRoutes.ts`, contract services | Confirm state changes + audit | P1 |
| Assessment milestone | Add/remove eligible/view/complete/generate job/invoice link | Partial | Milestone status pending/eligible, linked workflow perms | Contract/exam/printing/invoice integrations | Confirm financial/production effects | P1 |
| Contract financials | View prepaid/remaining/wallet-like balance, linked docs/history | Partial | Read perms | Contract records and linked invoices/docs | Read-only | P2 |

**Constraint:** Do not introduce duplicate job-order generation or new wallet-deduction behavior outside verified architecture.

## R. Referral Management
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Referral | View/approve/reverse/reward timeline/campaign/audit | **Missing/UNVERIFIED** | N/A | No verified referral module/engine found | N/A | P2 (gap) |

## S. Users and Permissions (`AccessControlView`, auth/user/company routes)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| User/member | View/edit role/permissions/deactivate/reset access/view activity | Partial/UNVERIFIED | `users:*`, `companies:settings:*`, admin role | `userRoutes.ts`, `authRoutes.ts`, `companyRoutes.ts` | Confirm sensitive changes + audit | P0/P1 |
| Role/permission | Manage assignments/matrix | Partial | Admin/manage permissions | `permissions.ts`, user/company APIs | Audit | P0 |

## T. Reports (`ReportsView`)
| Record type | Action | Capability | Preconditions | Dependency | Audit/confirm | Priority |
|---|---|---|---|---|---|---|
| Report/result row | Open, drill down, filter, export PDF/Excel, print, compare periods, view params | Partial/UNVERIFIED | `reports:read`/`reports:export`/`reports:schedule` | `reportsRoutes.ts`, `reportSchedulingRoutes.ts` | Audit export/schedule | P2 |

## Discovered Additional Modules
| Module | Actions (recommended) | Capability | Priority |
|---|---|---|---|
| All Documents (`AllDocumentsView`) | View/preview/download/print/open source record, attach/upload, link/unlink where supported, generate invoice for eligible workspace docs | Partial | P1/P2 |
| Payroll (`PayrollView`) | View employee/run, process/approve/reverse through authorized flows only, export/pay slips (if supported) | Partial/UNVERIFIED | P1 |
| Tax Forms (`TaxFormsView`) | View/prepare/export/file-status tracking (verified only) | Partial/UNVERIFIED | P2 |
| Finance Controls (`FinanceControlsView`) | View/approve/reject requests, complete/waive close tasks with evidence | Partial | P0/P1 |
| Settings/Backup/Migration (admin) | View/configure/execute authorized ops with confirmations and audit | Partial/UNVERIFIED | P1 |
