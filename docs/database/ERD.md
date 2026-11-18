# Target Entity-Relationship Diagram (ERD) — Printing Management System

This document defines the complete target PostgreSQL 17 entity-relationship architecture reconstructed from `SlowBooks-Pro-2026` and extended for commercial & educational printing operations. Every tenant-scoped entity includes `company_id` paired with composite `UNIQUE (company_id, id)` parent keys and Row-Level Security (`FORCE ROW LEVEL SECURITY`).

---

## Domain 1: Identity, Company Isolation & Core Accounting (Migrations `0001`–`0002`)

```mermaid
erDiagram
    companies ||--o{ company_memberships : "has members"
    users ||--o{ company_memberships : "belongs to"
    companies ||--o{ api_tokens : "scopes"
    users ||--o{ api_tokens : "owns"
    companies ||--o{ company_settings : "configures"
    companies ||--o{ payment_terms : "defines"
    companies ||--o{ txn_classes : "classifies"
    txn_classes ||--o{ txn_classes : "parent_id"

    companies ||--o{ accounts : "owns COA"
    accounts ||--o{ accounts : "sub-account parent_id"
    companies ||--o{ fiscal_periods : "defines lock windows"

    companies ||--o{ journal_transactions : "records"
    txn_classes ||--o{ journal_transactions : "tags"
    journal_transactions ||--o| journal_transactions : "reverses / reversed_by"
    journal_transactions ||--|{ journal_lines : "splits (SUM debit = SUM credit)"
    accounts ||--o{ journal_lines : "posts to"
    txn_classes ||--o{ journal_lines : "allocates"
```

---

## Domain 2: Customers, Sales, Receivables, Suppliers, Purchases & Banking (Migrations `0003`–`0004`)

```mermaid
erDiagram
    companies ||--o{ customers : "serves"
    customers ||--o{ customers : "sub-customer parent"
    payment_terms ||--o{ customers : "defaults"
    customers ||--o{ reseller_permits : "holds exemption"
    customers ||--o{ estimates : "receives quote"
    estimates ||--|{ estimate_lines : "contains"
    estimates ||--o{ invoices : "converts to"

    customers ||--o{ invoices : "billed on"
    journal_transactions ||--o| invoices : "posts AR & Revenue"
    invoices ||--|{ invoice_lines : "itemizes"
    invoices ||--o{ invoice_reminders : "triggers"
    invoice_reminder_rules ||--o{ invoice_reminders : "governs"

    customers ||--o{ payments : "remits"
    accounts ||--o{ payments : "deposits to"
    payments ||--|{ payment_allocations : "settles"
    invoices ||--o{ payment_allocations : "paid by"

    customers ||--o{ credit_memos : "issued"
    credit_memos ||--|{ credit_memo_lines : "details"
    credit_memos ||--o{ credit_applications : "applied via"
    invoices ||--o{ credit_applications : "credited by"

    customers ||--o{ recurring_invoices : "schedules"
    recurring_invoices ||--|{ recurring_invoice_lines : "templates"

    companies ||--o{ vendors : "buys from"
    accounts ||--o{ vendors : "default expense"
    vendors ||--o{ purchase_orders : "receives PO"
    purchase_orders ||--|{ purchase_order_lines : "orders"
    vendors ||--o{ bills : "issues bill"
    bills ||--|{ bill_lines : "expensed on"
    vendors ||--o{ bill_payments : "paid via"
    bill_payments ||--|{ bill_payment_allocations : "settles"
    bills ||--o{ bill_payment_allocations : "paid by"
    vendors ||--o{ vendor_credits : "grants"
    vendor_credits ||--|{ vendor_credit_lines : "details"
    vendor_credits ||--o{ vendor_credit_applications : "offsets"
    bills ||--o{ vendor_credit_applications : "reduced by"

    accounts ||--|| bank_accounts : "linked GL"
    bank_accounts ||--o{ reconciliations : "reconciled by"
    bank_accounts ||--o{ bank_transactions : "holds feed/register"
    reconciliations ||--o{ bank_transactions : "clears"
    bank_transactions ||--o| bank_check_details : "check stub"
    bank_transactions ||--o{ deposit_other_lines : "multi-source deposit"
    bank_transactions ||--o{ duplicate_dismissals : "dismissed dup"
```

---

## Domain 3: Paper Specs, Materials, 4-Type Inventory, Variants, BOMs & Payroll/Assets/Audit (Migrations `0005`–`0006`)

```mermaid
erDiagram
    paper_specifications ||--o{ inventory_items : "specifies paper"
    inventory_items ||--o| material_specifications : "extends raw_material"
    inventory_items ||--o{ item_variants : "has variants (stationery / printed_product)"
    inventory_items ||--o{ item_bom_components : "parent BOM (printed_product / printing_service)"
    item_variants ||--o{ item_bom_components : "variant BOM override"
    inventory_items ||--o{ item_bom_components : "consumes raw_material"
    inventory_items ||--o{ inventory_movements : "tracks perpetual stock"
    item_variants ||--o{ inventory_movements : "tracks variant stock"
    inventory_items ||--o{ invoice_lines : "sold (excluding raw_material)"

    employees ||--o{ employee_bank_accounts : "direct deposit"
    employees ||--o{ employee_benefits : "enrolled in"
    benefit_codes ||--o{ employee_benefits : "defines"
    pay_runs ||--|{ pay_stubs : "generates"
    employees ||--o{ pay_stubs : "receives"
    pay_stubs ||--o{ pay_stub_benefits : "withholds"
    employees ||--o{ pto_accruals : "accrues"
    pto_policies ||--o{ pto_accruals : "governs"
    employees ||--o{ onboarding_tasks : "completes"
    employees ||--o{ time_entries : "logs hours"

    fixed_asset_types ||--o{ fixed_assets : "categorizes"
    accounts ||--o{ budgets : "budgeted monthly"
    stored_files ||--o{ attachments : "attaches to entities"
    companies ||--o{ audit_log : "append-only SHA-256 trail"
```

---

## Domain 4: Printing Estimates, Machines, Production, Finishing, QC, Delivery, Exams & Contracts (Migration `0007`)

```mermaid
erDiagram
    fixed_assets ||--o| printing_machines : "capitalizes"
    customers ||--o{ printing_estimates : "quoted on"
    estimates ||--o| printing_estimates : "synced commercial quote"
    printing_estimates ||--|{ printing_estimate_lines : "calculates press & material cost"
    paper_specifications ||--o{ printing_estimate_lines : "uses spec"
    printing_machines ||--o{ printing_estimate_lines : "runs on"

    customers ||--o{ printing_contracts : "prepays retainer"
    printing_contracts ||--|{ contract_assessment_milestones : "2 to 5 dated assessments"
    inventory_items ||--o{ contract_assessment_milestones : "raw paper & toner estimate"
    invoices ||--o| contract_assessment_milestones : "linked billing"

    customers ||--o{ exam_assessment_batches : "school assessment class"
    printing_contracts ||--o{ exam_assessment_batches : "covered by retainer"
    invoices ||--o{ exam_assessment_batches : "consolidated school invoice (1 line/class)"
    exam_assessment_batches ||--|{ exam_papers : "contains subject papers"
    paper_specifications ||--o{ exam_papers : "uses spec"
    inventory_items ||--o{ exam_papers : "consumes raw paper & toner"

    customers ||--o{ printing_jobs : "orders"
    printing_estimates ||--o{ printing_jobs : "converts to"
    exam_papers ||--o| printing_jobs : "executed as"
    printing_machines ||--o{ printing_jobs : "assigned press"
    invoices ||--o| printing_jobs : "billed on"

    printing_jobs ||--|{ production_operations : "prepress / plate / press run"
    printing_machines ||--o{ production_operations : "operates"
    printing_jobs ||--o{ finishing_operations : "cutting / binding / lamination"
    inventory_items ||--o{ finishing_operations : "consumes binding/lamination raw material"
    printing_jobs ||--o{ quality_control_inspections : "inspected by QC"

    customers ||--o{ delivery_notes : "dispatched to"
    delivery_notes ||--|{ delivery_note_lines : "delivers"
    printing_jobs ||--o{ delivery_note_lines : "ships job"
    exam_papers ||--o{ delivery_note_lines : "ships exam paper"
```
