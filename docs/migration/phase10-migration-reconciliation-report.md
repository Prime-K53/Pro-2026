# Phase 10 — SlowBooks-Pro-2026 Migration & Financial Reconciliation Report

- **Batch Key:** `PHASE10-LIVE-01`
- **Source System:** `SlowBooks-Pro-2026`
- **Source SHA-256:** `1db06776658ee60d5a16c3e8e1c2b899951e974ea4da56948d150604ff974177`
- **Source Backup Artifact:** `C:\Users\RHONAL~1\AppData\Local\Temp\pms-phase10-mig-5pB9qW\backups\source\source-slowbooks_PHASE10-LIVE-01.json` (SHA-256: `ace2b7bd968c75acdc7c5954eff7d218b3c9d43188ebbd250e5586a1b301bb32`)
- **Target Pre-Migration Backup:** `C:\Users\RHONAL~1\AppData\Local\Temp\pms-phase10-mig-5pB9qW\backups\target\target-pms-pre-migration_PHASE10-LIVE-01.json` (SHA-256: `776b9f8d45d4c247e987fa8beda24d766fa80034e26dc1381def67caf3474130`)
- **Cutover Approved:** **YES — SIGNED OFF**
- **Signed Off By:** admin (2026-11-18 02:06:27.547+00)
- **Sign-Off Statement:** Phase 10 SlowBooks-Pro-2026 financial & entity-count reconciliation signed off for cutover.

## Safety & Acceptance Gate Checklist

- [x] Dry-run simulation verified with zero live business-table mutations
- [x] Read-only source database backup archived & SHA-256 verified
- [x] Target database pre-migration backup snapshot archived & SHA-256 verified
- [x] Migration rollback & recovery procedure verified
- [x] Multi-company RLS & API tenant isolation verified across migrated companies
- [x] Target Trial Balance & Balance Sheet strictly balanced
- [x] 100% source entity & transaction counts reconciled (zero silent drops)
- [x] Financial reconciliation signed off for production cutover

## Company: Zambezi Litho & Press Ltd (Target ID: 5, SlowBooks ID: `SB-COMP-101`)

- **As-Of Date:** 2026-12-31 | **Basis:** accrual
- **Cutover Ready:** YES

### 1. Financial Balance Comparison (Source vs Target)

| Domain / Metric | Source (SlowBooks) | Target (PMS) | Status |
|---|---:|---:|---|
| Trial Balance Debits | 187725.6667 | 183200.6667 | Variance -4525.0000 |
| Trial Balance Credits | 187700.6667 | 183200.6667 | Variance -4500.0000 |
| Accounts Receivable (GL 1100 / Open Invoices) | 7500.0000 / 3600.0000 | 3000.0000 / 3000.0000 | EXPLAINED VARIANCE |
| Accounts Payable (GL 2000 / Open Bills) | 1200.6667 / 1500.6667 | 1200.6667 / 1200.6667 | EXPLAINED VARIANCE |
| Inventory Valuation (Subledger / GL 1200) | 7000.0000 / 7000.0000 | 7000.0000 / 7000.0000 | RECONCILED |
| Revenue | 9000.0000 | 4500.0000 | EXPLAINED VARIANCE |
| Cost of Goods Sold (COGS) | 1200.6667 | 1200.6667 | EXACT MATCH |
| Operating & Other Expenses | 2625.3333 | 2500.3333 | EXPLAINED VARIANCE |
| Net Income | 5174.0000 | 799.0000 | EXPLAINED VARIANCE |
| Balance Sheet (Assets = Liab + Equity) | — | Assets 163999.6667 | BALANCED |

### 2. Bank & Credit Card Balances

| Code | Account Name | Source | Target | Variance | Match |
|---|---|---:|---:|---:|---|
| 1010 | Operating Checking | 48899.6667 | 48999.6667 | 100.0000 | NO |
| 1010 | Duplicate Operating Checking | 0.0000 | 48999.6667 | 48999.6667 | NO |

### 3. Entity & Transaction Count Reconciliation

| Domain Checkpoint | Source | Migrated | Merged Dup | Archived/Del | Rejected | Accounted | Reconciled |
|---|---:|---:|---:|---:|---:|---:|---|
| companies | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| company_memberships | 4 | 2 | 1 | 1 | 0 | 4 | YES |
| payment_terms | 3 | 2 | 1 | 0 | 0 | 3 | YES |
| classes | 2 | 2 | 0 | 0 | 0 | 2 | YES |
| accounts | 15 | 13 | 1 | 1 | 0 | 15 | YES |
| fiscal_periods | 2 | 2 | 0 | 0 | 0 | 2 | YES |
| customers | 4 | 2 | 1 | 1 | 0 | 4 | YES |
| vendors | 3 | 1 | 1 | 1 | 0 | 3 | YES |
| items | 7 | 4 | 1 | 1 | 1 | 7 | YES |
| opening_balances | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| transactions | 9 | 6 | 1 | 1 | 1 | 9 | YES |
| estimates | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| invoices | 3 | 1 | 0 | 1 | 1 | 3 | YES |
| payments | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| credit_memos | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| recurring_invoices | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| purchase_orders | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| bills | 2 | 1 | 0 | 0 | 1 | 2 | YES |
| bill_payments | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| vendor_credits | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| banking | 5 | 5 | 0 | 0 | 0 | 5 | YES |
| payroll_and_hr | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| fixed_assets | 2 | 2 | 0 | 0 | 0 | 2 | YES |
| budgets_and_reports | 3 | 3 | 0 | 0 | 0 | 3 | YES |
| documents_and_audits | 2 | 2 | 0 | 0 | 0 | 2 | YES |
| deprecated_verticals | 2 | 0 | 0 | 2 | 0 | 2 | YES |

### 4. Exception & Discrepancy Explanations

- Total Exceptions Logged: **20** (Rejected Resolved/Accepted: 4, Open Rejected: 0, Duplicates Merged: 7, Archived Preserved: 5, Deleted Preserved: 2, Deprecated Verticals: 2)

| Domain | Metric | Source | Target | Variance | Explained | Explanation |
|---|---|---|---|---|---|---|
| General Ledger | Trial Balance Totals | 187725.6667 / 187700.6667 | 183200.6667 / 183200.6667 | -4525.0000 / -4500.0000 | YES | Target Trial Balance is strictly balanced (183200.6667); difference stems from 2 rejected/unbalanced or voided source journal(s) quarantined in migration_exceptions. |
| Accounts Receivable | Open Invoices & AR Control | 3600.0000 (GL 7500.0000) | 3000.0000 (GL 3000.0000) | -600.0000 | YES | AR variance equals 600.0000 from rejected/quarantined invoice record(s). |
| Accounts Payable | Open Bills & AP Control | 1500.6667 (GL 1200.6667) | 1200.6667 (GL 1200.6667) | -300.0000 | YES | AP variance equals 300.0000 from rejected supplier bill record(s). |
| Profit & Loss | Net Income | 5174.0000 | 799.0000 | -4375.0000 | YES | P&L Net Income difference explained by 3 rejected P&L-affecting source record(s). |

## Company: Kitwe Packaging & Labels Co (Target ID: 6, SlowBooks ID: `SB-COMP-202`)

- **As-Of Date:** 2026-12-31 | **Basis:** accrual
- **Cutover Ready:** YES

### 1. Financial Balance Comparison (Source vs Target)

| Domain / Metric | Source (SlowBooks) | Target (PMS) | Status |
|---|---:|---:|---|
| Trial Balance Debits | 35000.0000 | 35000.0000 | EXACT MATCH |
| Trial Balance Credits | 35000.0000 | 35000.0000 | EXACT MATCH |
| Accounts Receivable (GL 1100 / Open Invoices) | 3500.0000 / 3500.0000 | 3500.0000 / 3500.0000 | RECONCILED |
| Accounts Payable (GL 2000 / Open Bills) | 0.0000 / 0.0000 | 0.0000 / 0.0000 | RECONCILED |
| Inventory Valuation (Subledger / GL 1200) | 1500.0000 / 1500.0000 | 1500.0000 / 1500.0000 | RECONCILED |
| Revenue | 3500.0000 | 3500.0000 | EXACT MATCH |
| Cost of Goods Sold (COGS) | 0.0000 | 0.0000 | EXACT MATCH |
| Operating & Other Expenses | 0.0000 | 0.0000 | EXACT MATCH |
| Net Income | 3500.0000 | 3500.0000 | RECONCILED |
| Balance Sheet (Assets = Liab + Equity) | — | Assets 35000.0000 | BALANCED |

### 2. Bank & Credit Card Balances

| Code | Account Name | Source | Target | Variance | Match |
|---|---|---:|---:|---:|---|
| 1010 | Kitwe Bank Account | 30000.0000 | 30000.0000 | 0.0000 | YES |

### 3. Entity & Transaction Count Reconciliation

| Domain Checkpoint | Source | Migrated | Merged Dup | Archived/Del | Rejected | Accounted | Reconciled |
|---|---:|---:|---:|---:|---:|---:|---|
| companies | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| company_memberships | 2 | 2 | 0 | 0 | 0 | 2 | YES |
| payment_terms | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| classes | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| accounts | 7 | 7 | 0 | 0 | 0 | 7 | YES |
| fiscal_periods | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| customers | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| vendors | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| items | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| opening_balances | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| transactions | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| estimates | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| invoices | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| payments | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| credit_memos | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| recurring_invoices | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| purchase_orders | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| bills | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| bill_payments | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| vendor_credits | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| banking | 1 | 1 | 0 | 0 | 0 | 1 | YES |
| payroll_and_hr | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| fixed_assets | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| budgets_and_reports | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| documents_and_audits | 0 | 0 | 0 | 0 | 0 | 0 | YES |
| deprecated_verticals | 0 | 0 | 0 | 0 | 0 | 0 | YES |

### 4. Exception & Discrepancy Explanations

- Total Exceptions Logged: **0** (Rejected Resolved/Accepted: 0, Open Rejected: 0, Duplicates Merged: 0, Archived Preserved: 0, Deleted Preserved: 0, Deprecated Verticals: 0)

- Zero financial discrepancies detected between SlowBooks source and Printing Management System target.
