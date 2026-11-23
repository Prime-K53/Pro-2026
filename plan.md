# Prime ERP — Gap Closure Plan v2 (Production-Grade with Architecture Corrections)

## Overview

This plan implements **10 active phases** (Phase 7 deferred) with architecture corrections:
- Single-company ERP (no multi-tenant switching)
- Offline-first sync architecture (IndexedDB → durable queue → `/api/sync/ops`)
- Reuse existing backend/ services and routing
- All financial postings use existing accounting services
- No silent fallback to legacy account codes
- Financial year restrictions enforced
- Inventory/sales/POS/payroll reconcile with GL
- QR verification with cryptographic tokens
- Twilio SMS/WhatsApp with consent management
- Local billing (no Stripe)
- Live AI provider with API key management

## Phase 0: Architecture & Production Readiness Audit

### 0.1 Audit Existing System

| Area | Current State | Evidence | Verdict |
|------|--------------|----------|---------|
| **Architecture** | React/Vite frontend, Express backend, Supabase/PostgreSQL, IndexedDB sync | `package.json`, `src/server/`, `src/components/`, `db/migrations/` | ✅ Established |
| **Accounting** | Double-entry GL, chart-of-account UUIDs, journal services | `0002_accounting_coa_and_general_ledger.up.sql`, `accountingEngine.ts` | ✅ Complete |
| **Offline sync** | IndexedDB → durable queue → `/api/sync/ops` | `src/components/sync/`, `src/server/routes/syncRoutes.ts` | ✅ Complete |
| **Auth** | HttpOnly cookies, password hashing, sessions | `authRoutes.ts`, `authMiddleware.ts` | ✅ Complete |
| **Tenant model** | Single-company (not multi-tenant) | `companies` table, `app_current_company_id()` | ✅ Correct |
| **Customer portal** | Separately deployed, not modified | External deployment | ✅ Deferred |

### 0.2 Migration Verification

- Latest migration: `0032_referral_governance.up.sql`
- Next available: `0033`, `0034`, ..., `0043`
- All new tables must have `company_id` and RLS with `app_current_company_id()`
- All migrations must be reversible

### 0.3 Implementation Contract

**Every phase follows:**

1. **Frontend (React/Vite)**: UI, validation, permissions, user interaction
2. **IndexedDB + durable queue**: Offline-first operational data
3. **Backend API (Express)**: Auth, authorization, validation, idempotency, business rules
4. **Supabase/PostgreSQL**: Durable records, constraints, transactions
5. **Realtime/SSE**: Consistent updates across clients

**Offline-capable**: POS checkout, inventory adjustments, customer creation, quote creation
**Online-only**: AI provider requests, Twilio messages, live model discovery, payment processing

---

## Phase 1: POS Completion (Stub → Complete) — Migration 0033

### 1.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Offline resilience (IndexedDB → durable queue → sync) | PARTIAL | Sync exists, but POS checkout not fully offline-capable |
| Barcode integrity (scan→lookup, unique per item) | FAIL | No `barcode` column on `inventory_items` |
| Shift accountability (open/close/reconcile, cashier ownership) | FAIL | No `pos_shifts` table |
| Cash drawer management (opening/closing float, cash in/out) | FAIL | No drawer/float concept |
| Split payments (multiple tenders with individual amounts) | FAIL | `posService.ts` — single tenderMode only |
| Suspended sales (park/resume, survives refresh/restart) | FAIL | No suspended sales table |
| Refund integrity (reverse GL + inventory) | PASS | `voidPosOrder` + GL reversal exist |
| Cashier reconciliation (cash count vs system, variance) | FAIL | No reconciliation endpoint |
| Shift-level audit trail | PARTIAL | Basic audit exists, no shift-level audit |
| Inventory atomicity (checkout decrements stock atomically) | PASS | `posService.ts` uses transaction |
| Stock concurrency (multiple terminals, same item) | PARTIAL | Transactions exist, but no explicit locking |

**Verdict: Stub — 5/11 principles FAIL**

### 1.2 Gaps

- **G1**: No `pos_shifts` table (shift open/close, drawer float, cashier ownership)
- **G2**: No `pos_suspended_sales` table (park/resume, survives restart)
- **G3**: No `barcode` column on `inventory_items`
- **G4**: No split payment support (multiple tenders per sale)
- **G5**: No shift reconciliation endpoint (cash count, variance)
- **G6**: POS checkout not fully offline-capable (needs IndexedDB queue integration)
- **G7**: No shift-level audit trail
- **G8**: No stock concurrency protection (explicit row locking)

### 1.3 Design

**New Tables (migration 0033):**
- `pos_shifts` (id, company_id, cashier_id, opened_at, closed_at, opening_float NUMERIC(12,2), closing_float NUMERIC(12,2), cash_in NUMERIC(12,2), cash_out NUMERIC(12,2), expected_cash NUMERIC(12,2), actual_cash NUMERIC(12,2), variance NUMERIC(12,2), status TEXT CHECK (status IN ('open', 'closed')), created_at, updated_at)
- `pos_suspended_sales` (id, company_id, shift_id, pos_order_id, suspended_at, resumed_at, status TEXT CHECK (status IN ('suspended', 'resumed')), created_at)
- `pos_transactions` (id, company_id, shift_id, order_id, tender_type TEXT, amount NUMERIC(12,2), tendered NUMERIC(12,2), change NUMERIC(12,2), created_at)
- `inventory_items.barcode` (TEXT, UNIQUE per company)

**Cash reconciliation formula (implemented in service):**
```
ExpectedCash = OpeningFloat + CashSales + CashIn - CashRefunds - CashOut - CashDeposits
Variance = ActualCash - ExpectedCash
```

**Service Changes:**
- `posService.ts`:
  - `openShift(tx, companyId, cashierId, openingFloat)` — opens shift, returns shift_id
  - `closeShift(tx, companyId, shiftId, actualCash, notes)` — reconciles, computes variance, closes shift
  - `suspendSale(tx, companyId, shiftId, posOrderId)` — parks order
  - `resumeSale(tx, companyId, suspendedSaleId)` — resumes parked order
  - `listSuspendedSales(tx, companyId)` — lists parked orders
  - Extend `checkoutPosOrder` to support `tenderMode='split'` with `tenderBreakdown` array
  - Add barcode lookup: `lookupBarcode(tx, companyId, barcode)`
- `inventoryService.ts`:
  - Add barcode column support
  - Add `lookupBarcode(tx, companyId, barcode)` service

**New APIs (integrated into existing routes):**
- `GET/POST /pos/shifts` — open/close/list shifts
- `POST /pos/shifts/:id/close` — reconcile and close
- `POST /pos/orders/:id/suspend` — park order
- `GET /pos/suspended` — list suspended
- `POST /pos/suspended/:id/resume` — resume
- `POST /pos/checkout` — extend for split payments (tenderMode='split', tenderBreakdown array)
- `GET /pos/catalog` — include barcode in response
- `POST /pos/scan` — barcode lookup
- `GET /pos/shifts/:id/transactions` — shift transaction history

**UI Components:**
- `src/components/pos/ShiftManager.tsx` — open/close shift
- `src/components/pos/ShiftReconciliation.tsx` — cash count UI with variance
- `src/components/pos/SplitPaymentModal.tsx` — split tender UI
- `src/components/pos/SuspendedSalesView.tsx` — list/resume
- `src/components/pos/BarcodeScanner.tsx` — scan input

### 1.4 Implementation Tasks

- [x] Create migration 0033
- [ ] Add `pos_shifts`, `pos_suspended_sales`, `pos_transactions` tables
- [ ] Add `barcode` column to `inventory_items`
- [ ] Implement shift open/close/reconcile service + routes
- [ ] Implement suspend/resume service + routes
- [ ] Extend checkout for split payments
- [ ] Add barcode to catalog + scan endpoint
- [ ] Build ShiftManager UI
- [ ] Build ShiftReconciliation UI
- [ ] Build SplitPaymentModal UI
- [ ] Build SuspendedSalesView UI
- [ ] Extend POS test suite with shift, split, suspend tests
- [ ] Run regression tests

---

## Phase 2: AI Assistant (Stub → Complete) — Migration 0034

### 2.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Record-grounded answers (only tenant data, no hallucination) | FAIL | No AI backend, no RAG |
| Live provider integration (OpenRouter, Gemini, etc. with API key) | FAIL | No provider integration |
| Role-aware data retrieval | FAIL | No AI routes |
| Source citations for answers | FAIL | No RAG |
| Prompt injection protection | FAIL | No guardrails |
| Token/cost/usage limits | FAIL | No limits |
| Conversation retention policy | FAIL | No retention |
| AI action preview + approval + execution audit | FAIL | No action layer |
| No automatic financial posting | FAIL | No AI action execution |
| Tenant isolation (single-company scoping) | FAIL | No AI routes |

**Verdict: Stub — 10/10 principles FAIL**

### 2.2 Gaps

- **G1**: No AI backend routes
- **G2**: No RAG pipeline
- **G3**: No live provider integration (API key management, live model discovery)
- **G4**: No role-aware retrieval
- **G5**: No source citations
- **G6**: No prompt injection protection
- **G7**: No token/cost/usage limits
- **G8**: No conversation retention policy
- **G9**: No action preview + approval workflow
- **G10**: No AI audit log

### 2.3 Design

**Provider abstraction:**
- `src/server/services/aiProvider.ts` — abstract provider interface (OpenRouter, Gemini, OpenAI, etc.)
- `ai_config` table: (id, company_id, provider, api_key_encrypted, model_name, enabled, created_at, updated_at)
- API key encryption: AES-256-GCM with company-specific key

**New Tables (migration 0034):**
- `ai_config` (id, company_id, provider, api_key_encrypted, model_name, enabled, created_at, updated_at)
- `ai_conversations` (id, company_id, user_id, title, created_at, updated_at)
- `ai_messages` (id, company_id, conversation_id, role, content, created_at)
- `ai_anomaly_alerts` (id, company_id, anomaly_type, severity, description, evidence, status, created_at)
- `ai_proposed_actions` (id, company_id, conversation_id, action_type, description, parameters JSONB, status TEXT CHECK (status IN ('pending', 'approved', 'rejected', 'executed')), approval_id, created_at)
- `ai_audit_logs` (id, company_id, user_id, action, query, response_summary, created_at)

**New Services:**
- `src/server/services/aiProviderService.ts` — provider abstraction, live model listing, API key management
- `src/server/services/aiService.ts` — RAG pipeline (tenant-scoped retrieval, source citations), prompt injection guardrails
- `src/server/services/aiAnomalyService.ts` — anomaly detection engine (rule-based + statistical)
- `src/server/services/aiActionService.ts` — action proposal + maker-checker approval integration
- `src/server/services/aiAuditService.ts` — AI query/action audit logging

**New Routes:**
- `src/server/routes/aiRoutes.ts` — `/ai/config` (GET/POST), `/ai/models` (live from provider), `/ai/conversations` (GET/POST), `/ai/chat` (POST), `/ai/anomalies` (GET), `/ai/actions` (GET/POST)

**UI Changes:**
- `src/components/views/AiAgentView.tsx` — extend with:
  - Chat UI with conversation history
  - Live model selector (populated from provider)
  - Anomaly alerts dashboard
  - Proposed actions with approve/reject
  - Source citations display
  - Token/cost usage display

### 2.4 Implementation Tasks

- [x] Create migration 0034
- [x] Create all AI tables
- [x] Build `aiProviderService.ts` (OpenRouter, Gemini, OpenAI, etc.)
- [x] Add live model listing
- [x] Build `aiService.ts` with RAG + guardrails
- [x] Build `aiAnomalyService.ts`
- [x] Build `aiActionService.ts` with maker-checker integration
- [x] Build `aiAuditService.ts`
- [x] Create `aiRoutes.ts`
- [ ] Extend `AiAgentView.tsx`
- [ ] Add tests

---

## Phase 3: Security — 2FA & Session Hardening (Partial → Complete) — Migration 0035

### 3.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Tenant isolation (RLS on every table) | PASS | `FORCE ROW LEVEL SECURITY` on all tenant tables |
| Authentication (secure login, session management) | PASS | `authRoutes.ts` — HttpOnly cookies, password hashing, login attempts |
| Role-based access control (granular permissions) | PASS | `permissions.ts` — role-based permission matrix |
| Maker-checker approvals (sensitive ops require approval) | PASS | `approvalService.ts` — full approval workflow |
| Audit logs (immutable, hash-chained) | PASS | `audit.ts` — SHA256 hash chaining |
| Two-factor authentication (TOTP, backup codes, recovery) | FAIL | No TOTP, no 2FA enrolment, no backup codes |
| Session security (CSRF, secure cookies, session rotation) | PARTIAL | Session management exists, but no CSRF tokens |
| Rate limiting (OTP brute force, login attempts) | PARTIAL | Login attempts tracked, but no OTP rate limiting |

**Verdict: Partial — 1/8 principles FAIL**

### 3.2 Gaps

- **G1**: No TOTP secret storage (encrypted)
- **G2**: No 2FA enrolment/verify endpoints
- **G3**: No backup codes (hashed, single-use)
- **G4**: No CSRF protection
- **G5**: No OTP rate limiting
- **G6**: No session rotation after login
- **G7**: No recovery procedures

### 3.3 Design

**New Tables (migration 0035):**
- `user_two_factor_secrets` (id, user_id, secret_encrypted TEXT, created_at)
- `user_backup_codes` (id, user_id, code_hash TEXT, used_at TIMESTAMPTZ, created_at)

**New APIs:**
- `POST /auth/2fa/enroll` — generate TOTP secret, return QR code data URL
- `POST /auth/2fa/verify` — verify TOTP code during login
- `POST /auth/2fa/backup-codes` — generate backup codes (hashed)
- `POST /auth/2fa/disable` — disable 2FA (requires password + reauthentication)
- `GET /auth/2fa/status` — check if 2FA is enabled for current user

**Middleware Changes:**
- `authMiddleware.ts`:
  - Add `requiresTwoFactor` check after password verification
  - Add `requiresReauthentication` for 2FA disable
  - Add CSRF token validation for cookie-authenticated requests
  - Add session rotation after login

**UI Changes:**
- `src/components/auth/TwoFactorSetup.tsx` — enrolment UI with QR code
- Login flow — 2FA step after password (if enabled)
- 2FA disable confirmation with password re-entry

### 3.4 Implementation Tasks

- [x] Create migration 0035
- [x] Create 2FA tables
- [x] Implement TOTP generation and verification (using Node.js crypto)
- [x] Add 2FA enrolment/verify/backup/disable endpoints
- [ ] Add `requiresTwoFactor` middleware check
- [ ] Add CSRF protection middleware
- [ ] Add OTP rate limiting
- [ ] Add session rotation after login
- [ ] Build 2FA enrolment UI
- [ ] Add 2FA step to login flow
- [ ] Add tests

---

## Phase 4: Customers — Branches & Contacts (Partial → Complete) — Migration 0036

### 4.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Customer identity (business name, registration number, type) | PASS | `customers` table with `customer_type`, `tax_id`, `registration_number` |
| Contact management (multiple contacts per customer) | FAIL | Only `name`/`email`/`phone` on customer — no contact-person table |
| Address management (billing + delivery, multiple addresses) | PARTIAL | `billing_address`, `shipping_address` single address each |
| Branch hierarchy (parent-child, multi-branch) | FAIL | Only `parent_customer_id` — no branches table |
| Statement generation (per-customer statements) | PASS | `salesService.ts` — `generateCustomerStatement` |
| Balance tracking (real-time balance) | PASS | `customers.balance` + wallet service |
| Credit limit enforcement (hard/soft limits) | PASS | `credit_limit` + credit profile endpoint |

**Verdict: Partial — 2/7 principles FAIL**

### 4.2 Gaps

- **G1**: No `customer_contacts` table (contact person, role, phone, email)
- **G2**: No `customer_branches` table (branch name, address, phone, is_billing_default)
- **G3**: No multi-address support (only single billing/shipping)

### 4.3 Design

**New Tables (migration 0036):**
- `customer_contacts` (id, company_id, customer_id, contact_name, role, email, phone, is_primary BOOLEAN, created_at, updated_at)
- `customer_branches` (id, company_id, customer_id, branch_name, address, phone, is_billing_default BOOLEAN, is_shipping_default BOOLEAN, delivery_instructions TEXT, created_at, updated_at)

**Service Changes:**
- New `customerService.ts` — CRUD for contacts and branches
- `salesService.ts` — extend customer queries to include contacts and branches

**UI Changes:**
- `src/components/customers/CustomerContactsTab.tsx` — contacts management
- `src/components/customers/CustomerBranchesTab.tsx` — branches management
- Extend customer detail view with contacts/branches tabs

### 4.4 Implementation Tasks

- [x] Create migration 0036
- [x] Create customer contacts/branches tables
- [x] Build customer contact/branch CRUD services + routes
- [ ] Build CustomerContactsTab UI
- [ ] Build CustomerBranchesTab UI
- [ ] Extend customer detail view with contacts/branches tabs
- [ ] Add tests

---

## Phase 5: Payroll — Advances, Deductions, Bank Files (Partial → Complete) — Migration 0037

### 5.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Employee master data (personal info, bank details, pay info) | PASS | `employees` + `employee_bank_accounts` (0006) |
| Salary computation (base pay + allowances + overtime + deductions) | PARTIAL | `pay_runs` exists, `payrollService.ts` handles basic computation |
| Salary advances (advance + repayment schedule) | FAIL | No advances table |
| Configurable deductions (statutory rules, tax, pension, loans) | FAIL | Only `benefit_codes` — no deduction rule engine |
| Allowance management (housing, transport, medical) | PARTIAL | `w4_allowances` field exists, no allowance master |
| Payroll journal integration (GL posting) | PASS | `payrollService.ts` — `postPayrollJournal` |
| Bank file generation (payment file for payroll) | FAIL | No bank file generation |
| Payroll audit trail (every payroll action logged) | PASS | Audit logging exists |

**Verdict: Partial — 3/8 principles FAIL**

### 5.2 Gaps

- **G1**: No `salary_advances` table (advance + repayment schedule)
- **G2**: No `payroll_deduction_rules` table (configurable deduction engine with statutory rules)
- **G3**: No `employee_allowances` master
- **G4**: No bank payment file generation

### 5.3 Design

**New Tables (migration 0037):**
- `salary_advances` (id, company_id, employee_id, amount NUMERIC(12,2), repayment_schedule JSONB, status TEXT CHECK (status IN ('active', 'repaid', 'cancelled')), created_at)
- `payroll_deduction_rules` (id, company_id, deduction_type TEXT, name TEXT, calculation_method TEXT CHECK (calculation_method IN ('fixed', 'percentage', 'tiered', 'statutory')), formula TEXT, applicable_to TEXT, is_tax_deductible BOOLEAN, effective_from DATE, effective_to DATE, created_at)
- `employee_allowances` (id, company_id, employee_id, allowance_type TEXT, amount NUMERIC(12,2), effective_from DATE, effective_to DATE, created_at)

**Service Changes:**
- `payrollService.ts` — integrate advances repayment, deduction rules engine, allowances
- New `payrollAdvancesService.ts` — advance CRUD + repayment tracking
- New `payrollDeductionService.ts` — deduction rule evaluation (supports Malawi PAYE, pension, etc.)
- New `payrollBankFileService.ts` — bank payment file generation (CSV format for banks)

**UI Changes:**
- `src/components/payroll/SalaryAdvanceModal.tsx` — create/manage advances
- `src/components/payroll/DeductionRulesView.tsx` — manage deduction rules
- `src/components/payroll/AllowanceManagement.tsx` — manage allowances
- `src/components/payroll/BankFileExport.tsx` — export bank payment file

### 5.4 Implementation Tasks

- [x] Create migration 0037
- [x] Create salary advances/deduction rules/allowances tables
- [ ] Build advance CRUD + repayment tracking
- [ ] Build deduction rule engine (with Malawi PAYE support)
- [ ] Build allowance management
- [ ] Integrate advances + deductions into payroll computation
- [ ] Add bank file generation (CSV for banks)
- [ ] Add tests

---

## Phase 6: Delivery — Vehicles, Drivers, Costs (Partial → Complete) — Migration 0038

### 6.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Delivery note creation (dispatch record) | PASS | `delivery_notes` + `createDeliveryNote` |
| Multiple deliveries per order (split delivery) | PASS | `delivery_note_lines` supports multi-line |
| Proof of delivery (signature, photo, OTP) | PASS | `deliverExamPaper` captures recipient, driver, vehicle, notes |
| Driver management (driver master, availability) | FAIL | Only `driverName` free-text — no driver master |
| Vehicle management (vehicle master, capacity, maintenance) | FAIL | Only `vehicleReg` free-text — no vehicle master |
| Delivery cost tracking (cost per delivery, route optimization) | FAIL | No delivery cost field |
| Delivery scheduling (route planning, time windows) | FAIL | No scheduling |
| Delivery audit trail (who delivered what, when) | PASS | Audit logging exists |

**Verdict: Partial — 3/8 principles FAIL**

### 6.2 Gaps

- **G1**: No `vehicles` master table
- **G2**: No `drivers` master table
- **G3**: No delivery cost tracking
- **G4**: No delivery scheduling

### 6.3 Design

**New Tables (migration 0038):**
- `vehicles` (id, company_id, registration TEXT UNIQUE, make TEXT, model TEXT, capacity_kg NUMERIC(10,2), capacity_volume NUMERIC(10,2), status TEXT CHECK (status IN ('active', 'maintenance', 'retired')), created_at, updated_at)
- `drivers` (id, company_id, employee_id INTEGER REFERENCES employees(company_id, id), name TEXT, phone TEXT, license_number TEXT UNIQUE, license_expiry DATE, status TEXT CHECK (status IN ('active', 'inactive')), created_at, updated_at)
- `delivery_schedules` (id, company_id, delivery_note_id INTEGER, scheduled_date DATE, time_window TEXT, assigned_driver_id INTEGER, assigned_vehicle_id INTEGER, status TEXT CHECK (status IN ('scheduled', 'in_transit', 'delivered', 'failed')), created_at)
- `delivery_notes.delivery_cost` NUMERIC(12,2) DEFAULT 0

**Service Changes:**
- New `deliveryService.ts` — vehicle/driver CRUD, scheduling, cost calculation
- `printingRoutes.ts` — extend delivery endpoints with vehicle/driver selection

**UI Changes:**
- `src/components/delivery/VehicleManagement.tsx`
- `src/components/delivery/DriverManagement.tsx`
- `src/components/delivery/DeliveryScheduling.tsx`

### 6.4 Implementation Tasks

- [x] Create migration 0038
- [x] Create vehicles/drivers/schedules tables
- [ ] Build vehicle/driver CRUD
- [ ] Add delivery cost tracking to delivery notes
- [ ] Build delivery scheduling UI
- [ ] Extend delivery note creation with vehicle/driver selection
- [ ] Add tests

---

## Phase 7: Customer Portal — DEFERRED

Per user decision: Customer portal is deferred. No changes.

---

## Phase 8: Documents — QR Verification (Partial → Complete) — Migration 0040

### 8.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Document integrity (tamper-proof) | PASS | SHA256 hash on every attachment (0006) |
| Professional PDF rendering (branded, consistent) | PARTIAL | Contract rendering exists, general PDF not comprehensive |
| Receipt/voucher generation (all document types) | PASS | All document kinds covered in `documentsRoutes.ts` |
| QR verification (scan to verify authenticity) | FAIL | No QR generation or verification |
| Document versioning (history of changes) | PARTIAL | Contracts have versioning, others don't |
| Document distribution (email, download) | PASS | Download + email reminders exist |

**Verdict: Partial — 1/6 principles FAIL**

### 8.2 Gaps

- **G1**: No QR code generation
- **G2**: No QR verification endpoint
- **G3**: No cryptographic token for QR (unpredictable, tamper-proof)

### 8.3 Design

**New Tables (migration 0040):**
- `document_qr_codes` (id, company_id, document_kind TEXT, document_id INTEGER, qr_token_hash TEXT UNIQUE, qr_token_salt TEXT, created_at, revoked_at TIMESTAMPTZ)

**Service Changes:**
- New `documentQrService.ts`:
  - `generateQrToken(tx, companyId, documentKind, documentId)` — generates cryptographically unpredictable token
  - `verifyQrToken(tx, companyId, qrToken)` — verifies token, returns document metadata (no confidential info)
  - `revokeQrToken(tx, companyId, qrToken)` — revokes a QR code

**New Routes:**
- `POST /documents/:kind/:id/qr` — generate QR code (returns QR image + token)
- `GET /documents/verify/:token` — verify document authenticity (returns minimal metadata)
- `POST /documents/:kind/:id/qr/revoke` — revoke QR code

**UI Changes:**
- Add QR code display to document preview
- Add QR verification scanner UI (optional, for public verification page)

### 8.4 Implementation Tasks

- [x] Create migration 0040
- [x] Create document_qr_codes table
- [ ] Build QR generation service (using `qrcode` library)
- [ ] Build QR verification endpoint
- [ ] Add QR code to document preview
- [ ] Add tests

---

## Phase 9: Communications — Consent & Twilio Gateway (Partial → Complete) — Migration 0041

### 9.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Email delivery (outbound email) | PASS | `nodemailer` + `processQueuedEmailsForCompany` |
| Reminders (automated invoice reminders) | PASS | `dispatchInvoiceReminder` |
| Marketing campaigns (templates, automation) | PASS | `marketing_templates`, `automation_rules`, `campaigns` |
| Message history (audit of all communications) | PASS | `marketing_messages` + `listCommunicationsAndReminders` |
| Consent management (opt-in/opt-out, GDPR) | FAIL | No consent tables |
| SMS/WhatsApp gateway (Twilio integration) | FAIL | Templates exist but no provider adapter |
| Inbound message handling (replies, opt-outs) | FAIL | No inbound handling |

**Verdict: Partial — 2/7 principles FAIL**

### 9.2 Gaps

- **G1**: No `communication_consents` table
- **G2**: No Twilio SMS/WhatsApp gateway integration
- **G3**: No inbound message handling
- **G4**: No webhook signature validation

### 9.3 Design

**New Tables (migration 0041):**
- `communication_consents` (id, company_id, customer_id, channel TEXT CHECK (channel IN ('email', 'sms', 'whatsapp')), consent_type TEXT CHECK (consent_type IN ('marketing', 'transactional', 'both')), status TEXT CHECK (status IN ('granted', 'withdrawn')), source TEXT, created_at, updated_at)
- `communication_preferences` (id, company_id, customer_id, channel TEXT, preference JSONB, updated_at)
- `communication_suppressions` (id, company_id, channel TEXT, recipient TEXT, reason TEXT, created_at)

**New Services:**
- `src/server/services/communicationConsentService.ts` — consent CRUD, suppression list management
- `src/server/services/twilioService.ts` — Twilio SMS/WhatsApp integration (using `twilio` npm package)
- `src/server/services/inboundMessageService.ts` — inbound message handling (Twilio webhooks)
- `src/server/services/twilioWebhookService.ts` — Twilio webhook signature validation

**New Routes:**
- `GET/POST /communications/consents` — consent management
- `POST /communications/webhooks/twilio` — Twilio inbound webhook (SMS/WhatsApp)
- `POST /communications/webhooks/twilio/status` — Twilio delivery status webhook
- `GET /communications/inbox` — inbound messages inbox

**UI Changes:**
- `src/components/communications/ConsentManagement.tsx`
- `src/components/communications/InboxView.tsx`

### 9.4 Implementation Tasks

- [x] Create migration 0041
- [x] Create consent/preference/suppression tables
- [ ] Build consent CRUD
- [ ] Build Twilio SMS gateway adapter
- [ ] Build Twilio WhatsApp gateway adapter
- [ ] Build Twilio webhook signature validation
- [ ] Build inbound message handling
- [ ] Build consent management UI
- [ ] Build inbound inbox UI
- [ ] Add tests

---

## Phase 10: BI — Sales Trends & KPI Scorecard (Partial → Complete) — Migration 0042

### 10.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Financial statements (P&L, BS, CF, TB) | PASS | `financialReports.ts` — all statements |
| Job profitability (per-job cost analysis) | PASS | `getPrintingJobProfitability` |
| Wastage tracking (material wastage reports) | PASS | `getPrintingSpoilageReport` |
| WIP aging (work-in-progress aging) | PASS | `getWipAgingReport` |
| Budget vs actual (variance analysis) | PASS | `financialManagementRoutes.ts` |
| Sales trends (time-series revenue analysis) | FAIL | No sales-trends endpoint |
| KPI scorecard (performance targets) | FAIL | Budget-vs-actual only, no KPI dashboard |

**Verdict: Partial — 2/7 principles FAIL**

### 10.2 Gaps

- **G1**: No sales-trends time-series report
- **G2**: No KPI scorecard dashboard

### 10.3 Design

**New Services:**
- `src/server/services/biSalesTrendsService.ts`:
  - `getSalesTrends(tx, companyId, period, groupBy)` — daily/weekly/monthly/quarterly/yearly revenue, cost, margin
  - `getSalesByProduct(tx, companyId, startDate, endDate)` — sales by product
  - `getSalesByCategory(tx, companyId, startDate, endDate)` — sales by category
  - `getSalesByCustomer(tx, companyId, startDate, endDate)` — sales by customer
  - `getCashVsCreditSales(tx, companyId, startDate, endDate)` — cash vs credit breakdown
  - `getOutstandingReceivables(tx, companyId)` — outstanding receivables aging
  - `getCustomerPaymentPerformance(tx, companyId)` — payment performance metrics

- `src/server/services/biKpiService.ts`:
  - `getKpiScorecard(tx, companyId)` — KPI targets vs actuals
  - `getInventoryTurnover(tx, companyId)` — inventory turnover ratio
  - `getStockValuation(tx, companyId)` — stock valuation
  - `getPosCashierPerformance(tx, companyId)` — POS cashier performance
  - `getPrintingJobEfficiency(tx, companyId)` — printing job efficiency
  - `getPayrollCostAnalysis(tx, companyId)` — payroll cost analysis

**New Routes:**
- `GET /bi/sales-trends?period=daily|weekly|monthly|quarterly|yearly&groupBy=product|category|customer`
- `GET /bi/kpi-scorecard`
- `GET /bi/inventory-turnover`
- `GET /bi/stock-valuation`
- `GET /bi/pos-cashier-performance`
- `GET /bi/printing-job-efficiency`
- `GET /bi/payroll-cost-analysis`

**UI Changes:**
- `src/components/bi/SalesTrendsView.tsx` — charts for sales trends (using Recharts or similar)
- `src/components/bi/KpiScorecardView.tsx` — KPI dashboard
- `src/components/bi/DrillDownModal.tsx` — drill-down from KPI to underlying transactions

### 10.4 Implementation Tasks

- [x] Create migration 0042 (if needed, otherwise no new tables)
- [ ] Build sales-trends service
- [ ] Build KPI scorecard service
- [ ] Build SalesTrendsView with charts
- [ ] Build KpiScorecardView
- [ ] Add to dashboard navigation
- [ ] Add tests

---

## Phase 11: System Admin — Restore, Monitoring, Local Billing (Partial → Complete) — Migration 0043

### 11.1 Audit Against ERP Principles

| Principle | Status | Evidence |
|-----------|--------|----------|
| Database backup (automated, scheduled) | PASS | `backupService.ts` — `createDatabaseBackup`, `listBackups` |
| Database restoration (point-in-time recovery) | FAIL | No restore endpoint |
| Health monitoring (uptime, performance metrics) | FAIL | No health-check endpoint |
| Integration framework (webhooks, API integrations) | FAIL | No integration registry |
| Migration management (schema versioning) | PASS | `migrator.ts` + migration routes |
| Release controls (version management, rollback) | FAIL | No release/version management |
| Subscription framework (local billing, plan tiers) | FAIL | No subscription tables |

**Verdict: Partial — 4/7 principles FAIL**

### 11.2 Gaps

- **G1**: No restore endpoint (operator procedure, not HTTP)
- **G2**: No health-check/metrics endpoint
- **G3**: No integration framework
- **G4**: No release controls
- **G5**: No local subscription framework (manual invoicing, plan tiers)

### 11.3 Design

**New Tables (migration 0043):**
- `integrations` (id, company_id, name TEXT, type TEXT, config JSONB, status TEXT CHECK (status IN ('active', 'inactive')), created_at, updated_at)
- `integration_webhooks` (id, integration_id INTEGER, url TEXT, secret TEXT, events JSONB, created_at)
- `subscription_plans` (id, name TEXT, price NUMERIC(12,2), features JSONB, max_users INTEGER, created_at)
- `subscriptions` (id, company_id INTEGER, plan_id INTEGER, status TEXT CHECK (status IN ('active', 'suspended', 'cancelled')), started_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, created_at)
- `release_versions` (id, version TEXT UNIQUE, notes TEXT, released_at TIMESTAMPTZ, is_current BOOLEAN)

**New Services:**
- `src/server/services/integrationService.ts` — integration registry
- `src/server/services/subscriptionService.ts` — local billing (manual invoicing, plan tiers)
- `src/server/services/releaseService.ts` — release version management

**New Routes:**
- `GET /admin/health` — health check + metrics (uptime, database connectivity, sync queue health, realtime connectivity, storage health)
- `POST /admin/restore` — restore from backup (operator procedure, requires confirmation, audited)
- `GET/POST /admin/integrations` — integration management
- `GET/POST /admin/subscriptions` — subscription management (manual invoicing)
- `GET /admin/releases` — release versions
- `GET /admin/metrics` — system metrics (performance, errors)

**UI Changes:**
- `src/components/admin/HealthDashboard.tsx` — system health monitoring
- `src/components/admin/IntegrationManager.tsx`
- `src/components/admin/SubscriptionManager.tsx`
- `src/components/admin/ReleaseManager.tsx`

### 11.4 Implementation Tasks

- [x] Create migration 0043
- [x] Create integration/subscription/release tables
- [ ] Build health-check/metrics endpoint
- [ ] Build restore endpoint (operator procedure)
- [ ] Build integration registry service + routes
- [ ] Build subscription management service + routes (local billing)
- [ ] Build release management service + routes
- [ ] Build HealthDashboard UI
- [ ] Build IntegrationManager UI
- [ ] Build SubscriptionManager UI
- [ ] Build ReleaseManager UI
- [ ] Add tests

---

## Quality Gates

Every phase must pass:

1. **Code review** — TypeScript build passes, no type errors
2. **Unit tests** — New services have unit tests
3. **Integration tests** — New routes have integration tests
4. **Regression tests** — Existing tests pass (100% pass rate)
5. **Database migration** — Up/down migrations work, no data loss
6. **Financial reconciliation** — If applicable, verify GL balance
7. **Security checks** — No exposed credentials, no SQL injection, no XSS
8. **Performance** — No regression from baseline

## Release Gate Process

Each phase must pass:
1. Gate 1: Discovery (done)
2. Gate 2: Design (done)
3. Gate 3: Implementation (code + tests)
4. Gate 4: Verification (all tests pass)
5. Gate 5: Data verification (migration applied, data intact)
6. Gate 6: Deployment (backup, monitoring, recovery)
7. Gate 7: Closure (acceptance report)

## Migration Strategy

- All migrations must be reversible (down.sql provided)
- All new tables must have `company_id` and RLS with `app_current_company_id()`
- All new columns must have defaults or be nullable
- No data loss during migration
- Test migrations on copy of production database before applying

## Testing Strategy

- Unit tests for all new services
- Integration tests for all new routes
- E2E tests for critical workflows (POS checkout, shift close, split payment, 2FA login, QR verification, Twilio webhook)
- Regression tests for existing functionality
- Performance tests for new features
- Security tests for auth, authorization, input validation