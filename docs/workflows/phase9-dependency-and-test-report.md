# Phase 9 — End-to-End Business Workflow Dependency Map & Test Report

- **Executed At:** 2026-11-25T14:28:57.832Z
- **Summary:** **7/7 PASSED**, 0 FAILED

## 1. Module & GL Account Dependency Map

```
Sales & Estimates (/api/estimates)
  └─▶ POST /estimates/:id/approve ──▶ POST /estimates/:id/create-job
                                          │
Procurement (/api/requisitions, /purchase-orders, /goods-receipts)
  ├─▶ Demand/Reorder -> Requisition -> Approve -> PO (uq_po_company_requisition)
  ├─▶ Pre-Billed Flow: PO -> Bill (Dr 1210 Purchases In Transit / Cr 2000 AP)
  │                      └─▶ Goods Receipt (Dr 1200 Inventory / Cr 1210 Transit)
  └─▶ Physical First:  PO -> Goods Receipt (Dr 1200 Inventory / Cr 2055 GRNI)
                         └─▶ Bill (Dr 2055 GRNI / Cr 2000 AP)
                                          │
Production Floor (/api/printing/jobs/:id/...)
  ├─▶ Shared Calc Engine (paperCalc.ts + tonerCalc.ts + printingWorkflows.ts)
  ├─▶ approve-budget ──▶ materials/reserve (inventory_items.reserved_qty locks)
  ├─▶ materials/issue (Dr 1250 WIP / Cr 1200 Inventory Asset)
  ├─▶ materials/consume (Good vs Waste -> actual_waste_cost) & materials/return (Dr 1200 / Cr 1250)
  ├─▶ operations & finishing (Dr 1250 WIP / Cr 2110 Direct Labour + Cr 6310 Machine Overhead)
  ├─▶ qc (qc_approved_qty <= produced_good_qty)
  ├─▶ /printing/deliveries (delivered_qty <= qc_approved_qty, supports partial delivery)
  ├─▶ /printing/jobs/:id/invoice (delivery_notes.invoice_id NULL guard + Dr 5000 COGS / Cr 1250 WIP)
  ├─▶ cancel (releases reserve, returns unused -> 1200, writes off sunk WIP -> Dr 5100 Variance / Cr 1250)
  └─▶ reprint (manual_selling_price = 0, linked via reprint_of_job_id, combined profitability report)

Cash, Banking & Statements (/api/payments, /api/banking/deposits, /reconciliations)
  ├─▶ Invoice Payments & Sales Receipts -> 1050 Undeposited Funds (stays out of 1010 bank ledger)
  ├─▶ POST /banking/deposits (paymentIds[]) -> Dr 1010 Bank / Cr 1050 (sets deposited_bank_txn_id)
  └─▶ Reconciliations -> Zero-Diff Lock -> Trial Balance, P&L, Balance Sheet, Valuation (/inventory/valuation)
```

## 2. Automated E2E Workflow Execution Results

| Status | Workflow | Scenario | Duration | Details |
| :--- | :--- | :--- | ---: | :--- |
| PASS | Workflow 2: Procurement -> Inventory | Demand Requisition -> Approve -> PO -> Goods Receipt -> Supplier Bill -> Payment -> GL | 1144ms | Demand Req -> Approve -> PO -> Goods Receipt (1200/2055) -> Supplier Bill (clears 2055) -> Bill Payment verified |
| PASS | Workflow 2B: Pre-Billed PO Flow | PO -> Bill (1210 In Transit) -> Partial GRs -> Over-Receipt Block (409) -> Avg Cost Update | 594ms | Pre-billed PO -> 1210 Purchases In Transit -> Partial GRs -> Over-Receipt 409 rollback -> Exact Weighted Avg Cost (153.75/Ream) verified |
| PASS | Workflow 3: Material Consumption & Valuation | Reserve -> Oversell Block -> Issue to WIP (Idempotent) -> Consumption/Waste -> Return Unused -> Valuation Reconciliation | 1788ms | Material reservation, unreserved stock lock (409), stationery oversell block, idempotent issue, waste tracking, unused return to 1200, and valuation check verified |
| PASS | Workflows 1 & 4: Sales -> Production -> Profitability | Quotation -> Approve -> Job -> Budget -> Partial Ops/Finishing/QC/Delivery -> Duplicate-Safe Invoices -> Real Profit | 1731ms | Quotation gate, Job costing, Partial Press/Finishing/QC/Delivery, Duplicate Invoice 409 guard, 100% WIP COGS relief, and Profit=3076.25 verified |
| PASS | Exceptions: Controlled Reprint & Cancellation | Controlled Reprint Erodes Order Profit; Cancelled Job Returns Unused Material & Writes Off Sunk WIP to 5100 | 902ms | Controlled reprint margin erosion & job cancellation (material return + 80 sunk WIP -> 5100 write-off) verified |
| PASS | Workflow 5: Financial Reconciliation | AR Payments -> 1050 Undeposited Funds -> Single Batch Deposit -> Double-Deposit Block (409) -> Bank Reconciliation Zero-Diff -> FS | 727ms | Undeposited Funds (1050) -> Batch Deposit (3500) -> Double-Deposit 409 lock -> Bank Recon Completed -> Balanced TB/BS/P&L verified |
| PASS | Cross-Cutting: Audit & Multi-Company Isolation | Verify Audit Trail Attribution & Complete Tenant Isolation on Company B Switch | 216ms | All 10+ workflow audit log actions verified + Company B cross-tenant isolation confirmed |

## 3. Verified Integrity Controls

- Double-entry invariant enforced at PostgreSQL transaction commit on every Procurement, WIP, COGS, Cancellation Variance, Invoice, Payment, and Deposit journal.
- Reserved stock (`reserved_qty <= on_hand`) blocks overselling on both raw materials and retail stationery.
- Duplicate invoicing of already-invoiced Delivery Notes and double bank deposits of Undeposited Payments rejected with HTTP `409`.
- Request-level idempotency (`Idempotency-Key`) prevents duplicate Goods Receipts and duplicate WIP Material Issues.
- Cross-company RLS + RBAC verified across Administrator, ProductionManager, and Company B tenant switches.
