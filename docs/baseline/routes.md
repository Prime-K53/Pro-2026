# Baseline Inventory

Generated: 2026-11-22T10:36:30.541Z

- Commit: `6cc098a36b8f34fc20fcaa2b0d129e295ca9414c` (main)
- Node: v24.22.1
- Route files: 27
- Routes: 387
- Migrations: 41

## Authorization snapshot (per route file)

| File | Routes | requireAuth refs | requirePermission refs | Permissions |
|------|--------|------------------|------------------------|-------------|
| accountingRoutes.ts | 27 | 2 | 27 | accounts:read, accounts:rebuild, accounts:write, journals:read, journals:write, periods:close, periods:read, periods:reopen, reports:export, reports:read |
| adminRoutes.ts | 6 | 2 | 0 | — |
| aiRoutes.ts | 13 | 2 | 0 | — |
| approvalRoutes.ts | 7 | 2 | 7 | approvals:configure, approvals:decide, approvals:read |
| authRoutes.ts | 8 | 4 | 0 | — |
| backupRoutes.ts | 2 | 2 | 2 | reports:read |
| bankingRoutes.ts | 19 | 2 | 19 | banking:read, banking:reconcile, banking:write |
| biRoutes.ts | 4 | 2 | 0 | — |
| communicationsRoutes.ts | 5 | 2 | 0 | — |
| companyRoutes.ts | 4 | 5 | 2 | companies:create, companies:settings:write |
| customerRoutes.ts | 8 | 2 | 0 | — |
| deliveryRoutes.ts | 6 | 2 | 0 | — |
| documentQrRoutes.ts | 4 | 3 | 0 | — |
| documentsRoutes.ts | 7 | 2 | 7 | attachments:read, attachments:write, invoices:write |
| financialManagementRoutes.ts | 13 | 2 | 13 | accounts:read, accounts:write, budgets:read, budgets:write, reports:read, tax:read, tax:write |
| migrationRoutes.ts | 11 | 2 | 11 | accounts:rebuild, audit:read, companies:settings:write |
| payrollRoutes.ts | 7 | 2 | 0 | — |
| printingRoutes.ts | 57 | 2 | 56 | approvals:decide, exams:approve, exams:cancel, exams:create, exams:deliver, exams:edit, exams:produce, exams:view, invoices:write, printing:contracts:manage, printing:read, printing:write, reports:read |
| protectedRoutes.ts | 25 | 2 | 25 | attachments:read, attachments:write, employees:read, employees:write, inventory:count, inventory:damage, inventory:deactivate, inventory:read, inventory:transfer, inventory:write, payroll:read, payroll:write, reports:export, reports:read |
| purchasingRoutes.ts | 30 | 2 | 30 | bills:read, bills:write, reports:read, statements:send, vendors:read, vendors:write |
| reportSchedulingRoutes.ts | 7 | 2 | 7 | reports:read, reports:schedule |
| reportsRoutes.ts | 7 | 2 | 7 | reports:read |
| salesRoutes.ts | 38 | 2 | 38 | customers:read, customers:write, estimates:read, estimates:write, fx:revalue, invoices:read, invoices:write, payments:allocate, reports:read, statements:send |
| smartOpsRoutes.ts | 50 | 2 | 50 | pos:read, pos:write, referral:activate_campaigns, referral:approve_rewards, referral:configure_financials, referral:credit_rewards, referral:decide_fraud, referral:investigate_fraud, referral:read, referral:reverse_rewards, referral:review_disputes, smart_ops:read, smart_ops:write |
| twoFactorRoutes.ts | 5 | 2 | 0 | — |
| userRoutes.ts | 8 | 8 | 6 | audit:read, users:invite, users:list, users:manage |
| walletRoutes.ts | 9 | 2 | 9 | wallet:allocate, wallet:apply, wallet:configure, wallet:deposit, wallet:read, wallet:reconcile, wallet:refund, wallet:transactions:read |

## Routes

| Method | Path | File |
|--------|------|------|
| GET | `/accounts` | accountingRoutes.ts |
| POST | `/accounts` | accountingRoutes.ts |
| PATCH | `/accounts/:id` | accountingRoutes.ts |
| POST | `/accounts/rebuild-balances` | accountingRoutes.ts |
| GET | `/journals` | accountingRoutes.ts |
| POST | `/journals` | accountingRoutes.ts |
| GET | `/journals/:id` | accountingRoutes.ts |
| POST | `/journals/:id/reverse` | accountingRoutes.ts |
| POST | `/opening-balances` | accountingRoutes.ts |
| GET | `/opening-balances/status` | accountingRoutes.ts |
| GET | `/periods` | accountingRoutes.ts |
| POST | `/periods` | accountingRoutes.ts |
| GET | `/periods/:id/checklist` | accountingRoutes.ts |
| POST | `/periods/:id/checklist/:taskKey/complete` | accountingRoutes.ts |
| POST | `/periods/:id/close` | accountingRoutes.ts |
| POST | `/periods/:id/reopen` | accountingRoutes.ts |
| POST | `/periods/:id/soft-close` | accountingRoutes.ts |
| PUT | `/periods/checklist-policy` | accountingRoutes.ts |
| GET | `/reports/balance-sheet` | accountingRoutes.ts |
| GET | `/reports/balance-sheet/csv` | accountingRoutes.ts |
| GET | `/reports/cash-flow` | accountingRoutes.ts |
| GET | `/reports/cash-flow/csv` | accountingRoutes.ts |
| GET | `/reports/general-ledger` | accountingRoutes.ts |
| GET | `/reports/profit-and-loss` | accountingRoutes.ts |
| GET | `/reports/profit-and-loss/csv` | accountingRoutes.ts |
| GET | `/reports/trial-balance` | accountingRoutes.ts |
| GET | `/reports/trial-balance/csv` | accountingRoutes.ts |
| GET | `/admin/health` | adminRoutes.ts |
| GET | `/admin/integrations` | adminRoutes.ts |
| POST | `/admin/integrations` | adminRoutes.ts |
| GET | `/admin/metrics` | adminRoutes.ts |
| GET | `/admin/releases` | adminRoutes.ts |
| GET | `/admin/subscriptions` | adminRoutes.ts |
| GET | `/ai/actions` | aiRoutes.ts |
| POST | `/ai/actions` | aiRoutes.ts |
| PATCH | `/ai/actions/:id` | aiRoutes.ts |
| GET | `/ai/anomalies` | aiRoutes.ts |
| POST | `/ai/anomalies/detect` | aiRoutes.ts |
| GET | `/ai/audit` | aiRoutes.ts |
| POST | `/ai/chat` | aiRoutes.ts |
| GET | `/ai/config` | aiRoutes.ts |
| POST | `/ai/config` | aiRoutes.ts |
| GET | `/ai/conversations` | aiRoutes.ts |
| POST | `/ai/conversations` | aiRoutes.ts |
| GET | `/ai/conversations/:id/messages` | aiRoutes.ts |
| POST | `/ai/models` | aiRoutes.ts |
| GET | `/approvals` | approvalRoutes.ts |
| GET | `/approvals/:id` | approvalRoutes.ts |
| POST | `/approvals/:id/approve` | approvalRoutes.ts |
| POST | `/approvals/:id/cancel` | approvalRoutes.ts |
| POST | `/approvals/:id/reject` | approvalRoutes.ts |
| GET | `/approvals/policies` | approvalRoutes.ts |
| PUT | `/approvals/policies` | approvalRoutes.ts |
| POST | `/login` | authRoutes.ts |
| POST | `/logout` | authRoutes.ts |
| POST | `/password-recovery` | authRoutes.ts |
| POST | `/password-reset` | authRoutes.ts |
| POST | `/register` | authRoutes.ts |
| GET | `/status` | authRoutes.ts |
| POST | `/supabase-session` | authRoutes.ts |
| POST | `/switch-company` | authRoutes.ts |
| POST | `/backup` | backupRoutes.ts |
| GET | `/backups` | backupRoutes.ts |
| GET | `/banking/accounts` | bankingRoutes.ts |
| POST | `/banking/accounts` | bankingRoutes.ts |
| POST | `/banking/checks/print` | bankingRoutes.ts |
| POST | `/banking/deposits` | bankingRoutes.ts |
| POST | `/banking/expenses` | bankingRoutes.ts |
| POST | `/banking/imports` | bankingRoutes.ts |
| GET | `/banking/reconciliations` | bankingRoutes.ts |
| POST | `/banking/reconciliations/:id/reverse` | bankingRoutes.ts |
| POST | `/banking/reconciliations/complete` | bankingRoutes.ts |
| POST | `/banking/reconciliations/preview` | bankingRoutes.ts |
| GET | `/banking/rules` | bankingRoutes.ts |
| POST | `/banking/rules` | bankingRoutes.ts |
| DELETE | `/banking/rules/:id` | bankingRoutes.ts |
| GET | `/banking/transactions` | bankingRoutes.ts |
| POST | `/banking/transactions/:id/categorize` | bankingRoutes.ts |
| PATCH | `/banking/transactions/:id/cleared` | bankingRoutes.ts |
| POST | `/banking/transactions/:id/dismiss-duplicate` | bankingRoutes.ts |
| POST | `/banking/transactions/:id/void` | bankingRoutes.ts |
| POST | `/banking/transfers` | bankingRoutes.ts |
| GET | `/bi/inventory-turnover` | biRoutes.ts |
| GET | `/bi/kpi-scorecard` | biRoutes.ts |
| GET | `/bi/pos-cashier-performance` | biRoutes.ts |
| GET | `/bi/sales-trends` | biRoutes.ts |
| GET | `/communications/consents` | communicationsRoutes.ts |
| POST | `/communications/consents` | communicationsRoutes.ts |
| GET | `/communications/suppressions` | communicationsRoutes.ts |
| POST | `/communications/suppressions` | communicationsRoutes.ts |
| POST | `/communications/webhooks/twilio` | communicationsRoutes.ts |
| GET | `/` | companyRoutes.ts |
| POST | `/` | companyRoutes.ts |
| GET | `/current` | companyRoutes.ts |
| PATCH | `/current` | companyRoutes.ts |
| GET | `/customers/:id/branches` | customerRoutes.ts |
| POST | `/customers/:id/branches` | customerRoutes.ts |
| PATCH | `/customers/:id/branches/:branchId` | customerRoutes.ts |
| DELETE | `/customers/:id/branches/:branchId` | customerRoutes.ts |
| GET | `/customers/:id/contacts` | customerRoutes.ts |
| POST | `/customers/:id/contacts` | customerRoutes.ts |
| PATCH | `/customers/:id/contacts/:contactId` | customerRoutes.ts |
| DELETE | `/customers/:id/contacts/:contactId` | customerRoutes.ts |
| GET | `/delivery/drivers` | deliveryRoutes.ts |
| POST | `/delivery/drivers` | deliveryRoutes.ts |
| GET | `/delivery/schedules` | deliveryRoutes.ts |
| POST | `/delivery/schedules` | deliveryRoutes.ts |
| GET | `/delivery/vehicles` | deliveryRoutes.ts |
| POST | `/delivery/vehicles` | deliveryRoutes.ts |
| POST | `/documents/:kind/:id/qr` | documentQrRoutes.ts |
| POST | `/documents/:kind/:id/qr/revoke` | documentQrRoutes.ts |
| GET | `/qr-verify/:token` | documentQrRoutes.ts |
| GET | `/test` | documentQrRoutes.ts |
| GET | `/attachments` | documentsRoutes.ts |
| DELETE | `/attachments/:id` | documentsRoutes.ts |
| GET | `/attachments/:id/preview` | documentsRoutes.ts |
| GET | `/documents` | documentsRoutes.ts |
| POST | `/documents/generate-invoice` | documentsRoutes.ts |
| GET | `/documents/preview/:kind/:id` | documentsRoutes.ts |
| GET | `/documents/render-model/contract/:id` | documentsRoutes.ts |
| GET | `/analytics/overview` | financialManagementRoutes.ts |
| GET | `/budgets` | financialManagementRoutes.ts |
| PUT | `/budgets` | financialManagementRoutes.ts |
| GET | `/fx/rates` | financialManagementRoutes.ts |
| PUT | `/fx/rates` | financialManagementRoutes.ts |
| GET | `/reports/budget-vs-actual` | financialManagementRoutes.ts |
| GET | `/saved-reports` | financialManagementRoutes.ts |
| POST | `/saved-reports` | financialManagementRoutes.ts |
| DELETE | `/saved-reports/:id` | financialManagementRoutes.ts |
| POST | `/saved-reports/:id/run` | financialManagementRoutes.ts |
| GET | `/tax/mappings` | financialManagementRoutes.ts |
| PUT | `/tax/mappings` | financialManagementRoutes.ts |
| GET | `/tax/summary` | financialManagementRoutes.ts |
| GET | `/migrations/slowbooks/batches` | migrationRoutes.ts |
| GET | `/migrations/slowbooks/batches/:batchId` | migrationRoutes.ts |
| GET | `/migrations/slowbooks/batches/:batchId/exceptions` | migrationRoutes.ts |
| POST | `/migrations/slowbooks/batches/:batchId/reconcile` | migrationRoutes.ts |
| GET | `/migrations/slowbooks/batches/:batchId/report` | migrationRoutes.ts |
| POST | `/migrations/slowbooks/batches/:batchId/rollback` | migrationRoutes.ts |
| POST | `/migrations/slowbooks/batches/:batchId/sign-off` | migrationRoutes.ts |
| POST | `/migrations/slowbooks/dry-run` | migrationRoutes.ts |
| POST | `/migrations/slowbooks/exceptions/:exceptionId/resolve` | migrationRoutes.ts |
| POST | `/migrations/slowbooks/execute` | migrationRoutes.ts |
| GET | `/migrations/slowbooks/source-reference/:entity/:targetId` | migrationRoutes.ts |
| GET | `/payroll/advances` | payrollRoutes.ts |
| POST | `/payroll/advances` | payrollRoutes.ts |
| GET | `/payroll/allowances` | payrollRoutes.ts |
| POST | `/payroll/allowances` | payrollRoutes.ts |
| GET | `/payroll/bank-file` | payrollRoutes.ts |
| GET | `/payroll/deduction-rules` | payrollRoutes.ts |
| POST | `/payroll/deduction-rules` | payrollRoutes.ts |
| POST | `/estimates/:id/create-job` | printingRoutes.ts |
| GET | `/inventory/valuation` | printingRoutes.ts |
| POST | `/printing/contracts` | printingRoutes.ts |
| GET | `/printing/contracts` | printingRoutes.ts |
| GET | `/printing/contracts/:id` | printingRoutes.ts |
| PATCH | `/printing/contracts/:id` | printingRoutes.ts |
| POST | `/printing/contracts/:id/acceptances` | printingRoutes.ts |
| POST | `/printing/contracts/:id/activate` | printingRoutes.ts |
| POST | `/printing/contracts/:id/activation-requests` | printingRoutes.ts |
| POST | `/printing/contracts/:id/amendments` | printingRoutes.ts |
| GET | `/printing/contracts/:id/amendments` | printingRoutes.ts |
| POST | `/printing/contracts/:id/amendments/:amendmentId/approve` | printingRoutes.ts |
| POST | `/printing/contracts/:id/amendments/:amendmentId/reject` | printingRoutes.ts |
| POST | `/printing/contracts/:id/assessment-changes` | printingRoutes.ts |
| POST | `/printing/contracts/:id/assessments` | printingRoutes.ts |
| PATCH | `/printing/contracts/:id/assessments/:assessmentNumber` | printingRoutes.ts |
| DELETE | `/printing/contracts/:id/assessments/:assessmentNumber` | printingRoutes.ts |
| POST | `/printing/contracts/:id/assessments/:assessmentNumber/complete` | printingRoutes.ts |
| POST | `/printing/contracts/:id/assessments/:assessmentNumber/invoice-link` | printingRoutes.ts |
| POST | `/printing/contracts/:id/cancel` | printingRoutes.ts |
| POST | `/printing/contracts/:id/deposit-invoice` | printingRoutes.ts |
| POST | `/printing/contracts/:id/deposits` | printingRoutes.ts |
| POST | `/printing/contracts/:id/fund` | printingRoutes.ts |
| POST | `/printing/contracts/:id/renew` | printingRoutes.ts |
| POST | `/printing/contracts/:id/resume` | printingRoutes.ts |
| POST | `/printing/contracts/:id/suspend` | printingRoutes.ts |
| GET | `/printing/contracts/:id/wallet-transactions` | printingRoutes.ts |
| POST | `/printing/deliveries` | printingRoutes.ts |
| POST | `/printing/exam-batches` | printingRoutes.ts |
| GET | `/printing/exam-batches` | printingRoutes.ts |
| POST | `/printing/exam-batches/:id/approve-spec` | printingRoutes.ts |
| GET | `/printing/exam-papers` | printingRoutes.ts |
| PATCH | `/printing/exam-papers/:id` | printingRoutes.ts |
| DELETE | `/printing/exam-papers/:id` | printingRoutes.ts |
| POST | `/printing/exam-papers/:id/cancel` | printingRoutes.ts |
| POST | `/printing/exam-papers/:id/deliver` | printingRoutes.ts |
| GET | `/printing/exam-papers/:id/events` | printingRoutes.ts |
| POST | `/printing/exam-papers/:id/reprint` | printingRoutes.ts |
| PATCH | `/printing/exam-papers/:id/status` | printingRoutes.ts |
| GET | `/printing/exam-reconciliation` | printingRoutes.ts |
| GET | `/printing/jobs` | printingRoutes.ts |
| POST | `/printing/jobs` | printingRoutes.ts |
| GET | `/printing/jobs/:id` | printingRoutes.ts |
| POST | `/printing/jobs/:id/approve-budget` | printingRoutes.ts |
| POST | `/printing/jobs/:id/cancel` | printingRoutes.ts |
| POST | `/printing/jobs/:id/finishing` | printingRoutes.ts |
| POST | `/printing/jobs/:id/invoice` | printingRoutes.ts |
| POST | `/printing/jobs/:id/materials/consume` | printingRoutes.ts |
| POST | `/printing/jobs/:id/materials/issue` | printingRoutes.ts |
| POST | `/printing/jobs/:id/materials/reserve` | printingRoutes.ts |
| POST | `/printing/jobs/:id/materials/return` | printingRoutes.ts |
| POST | `/printing/jobs/:id/operations` | printingRoutes.ts |
| GET | `/printing/jobs/:id/profitability` | printingRoutes.ts |
| POST | `/printing/jobs/:id/qc` | printingRoutes.ts |
| POST | `/printing/jobs/:id/reprint` | printingRoutes.ts |
| GET | `/printing/machines` | printingRoutes.ts |
| POST | `/printing/machines` | printingRoutes.ts |
| POST | `/attachments` | protectedRoutes.ts |
| GET | `/attachments/:id/download` | protectedRoutes.ts |
| GET | `/employees` | protectedRoutes.ts |
| POST | `/employees` | protectedRoutes.ts |
| GET | `/inventory` | protectedRoutes.ts |
| POST | `/inventory` | protectedRoutes.ts |
| PATCH | `/inventory/:id` | protectedRoutes.ts |
| GET | `/inventory/:id` | protectedRoutes.ts |
| POST | `/inventory/:id/adjust` | protectedRoutes.ts |
| GET | `/inventory/:id/bom` | protectedRoutes.ts |
| GET | `/inventory/:id/consumption` | protectedRoutes.ts |
| POST | `/inventory/:id/damage` | protectedRoutes.ts |
| POST | `/inventory/:id/deactivate` | protectedRoutes.ts |
| GET | `/inventory/:id/ledger` | protectedRoutes.ts |
| GET | `/inventory/:id/movements` | protectedRoutes.ts |
| GET | `/inventory/:id/supplier-history` | protectedRoutes.ts |
| GET | `/inventory/:id/transactions` | protectedRoutes.ts |
| GET | `/inventory/reorder-levels` | protectedRoutes.ts |
| POST | `/inventory/transfer` | protectedRoutes.ts |
| POST | `/payroll/runs` | protectedRoutes.ts |
| GET | `/payroll/runs` | protectedRoutes.ts |
| GET | `/reports/export` | protectedRoutes.ts |
| GET | `/reports/financial` | protectedRoutes.ts |
| POST | `/stock-counts` | protectedRoutes.ts |
| POST | `/stock-counts/:id/post` | protectedRoutes.ts |
| GET | `/bill-payments` | purchasingRoutes.ts |
| POST | `/bill-payments` | purchasingRoutes.ts |
| POST | `/bill-payments/:id/void` | purchasingRoutes.ts |
| GET | `/bills` | purchasingRoutes.ts |
| POST | `/bills` | purchasingRoutes.ts |
| POST | `/bills/:id/void` | purchasingRoutes.ts |
| GET | `/goods-receipts` | purchasingRoutes.ts |
| POST | `/goods-receipts` | purchasingRoutes.ts |
| GET | `/purchase-orders` | purchasingRoutes.ts |
| POST | `/purchase-orders` | purchasingRoutes.ts |
| POST | `/purchase-orders/:id/bill` | purchasingRoutes.ts |
| POST | `/purchase-orders/:id/receive` | purchasingRoutes.ts |
| GET | `/reports/ap-aging` | purchasingRoutes.ts |
| GET | `/requisitions` | purchasingRoutes.ts |
| POST | `/requisitions` | purchasingRoutes.ts |
| POST | `/requisitions/:id/approve` | purchasingRoutes.ts |
| POST | `/requisitions/:id/convert-po` | purchasingRoutes.ts |
| POST | `/requisitions/demand` | purchasingRoutes.ts |
| GET | `/vendor-credits` | purchasingRoutes.ts |
| POST | `/vendor-credits` | purchasingRoutes.ts |
| POST | `/vendor-credits/:id/apply` | purchasingRoutes.ts |
| GET | `/vendors` | purchasingRoutes.ts |
| POST | `/vendors` | purchasingRoutes.ts |
| PATCH | `/vendors/:id` | purchasingRoutes.ts |
| GET | `/vendors/:id/ap-profile` | purchasingRoutes.ts |
| POST | `/vendors/:id/opening-balance` | purchasingRoutes.ts |
| GET | `/vendors/:id/statement` | purchasingRoutes.ts |
| POST | `/vendors/:id/statement/send` | purchasingRoutes.ts |
| GET | `/vendors/:id/statements` | purchasingRoutes.ts |
| GET | `/vendors/:id/statements/:statementId` | purchasingRoutes.ts |
| GET | `/report-schedules` | reportSchedulingRoutes.ts |
| POST | `/report-schedules` | reportSchedulingRoutes.ts |
| GET | `/report-schedules/:id` | reportSchedulingRoutes.ts |
| PATCH | `/report-schedules/:id` | reportSchedulingRoutes.ts |
| DELETE | `/report-schedules/:id` | reportSchedulingRoutes.ts |
| POST | `/report-schedules/:id/run` | reportSchedulingRoutes.ts |
| POST | `/report-schedules/run-due` | reportSchedulingRoutes.ts |
| GET | `/dashboard/alerts` | reportsRoutes.ts |
| GET | `/reports/cogs-reconciliation` | reportsRoutes.ts |
| GET | `/reports/estimate-vs-actual` | reportsRoutes.ts |
| GET | `/reports/inventory-valuation` | reportsRoutes.ts |
| GET | `/reports/printing-job-profitability` | reportsRoutes.ts |
| GET | `/reports/printing-spoilage` | reportsRoutes.ts |
| GET | `/reports/wip-aging` | reportsRoutes.ts |
| GET | `/communications` | salesRoutes.ts |
| GET | `/credit-memos` | salesRoutes.ts |
| POST | `/credit-memos` | salesRoutes.ts |
| POST | `/credit-memos/:id/apply` | salesRoutes.ts |
| POST | `/credit-memos/:id/void` | salesRoutes.ts |
| GET | `/customers` | salesRoutes.ts |
| POST | `/customers` | salesRoutes.ts |
| PATCH | `/customers/:id` | salesRoutes.ts |
| GET | `/customers/:id/credit-profile` | salesRoutes.ts |
| GET | `/customers/:id/statement` | salesRoutes.ts |
| POST | `/customers/:id/statement/send` | salesRoutes.ts |
| GET | `/customers/:id/statements` | salesRoutes.ts |
| GET | `/customers/:id/unapplied-payments` | salesRoutes.ts |
| GET | `/estimates` | salesRoutes.ts |
| POST | `/estimates` | salesRoutes.ts |
| POST | `/estimates/:id/approve` | salesRoutes.ts |
| POST | `/estimates/:id/convert` | salesRoutes.ts |
| POST | `/estimates/:id/reject` | salesRoutes.ts |
| POST | `/fx-revaluation` | salesRoutes.ts |
| GET | `/fx-revaluation/preview` | salesRoutes.ts |
| GET | `/fx-revaluation/runs` | salesRoutes.ts |
| GET | `/invoices` | salesRoutes.ts |
| POST | `/invoices` | salesRoutes.ts |
| GET | `/invoices/:id` | salesRoutes.ts |
| PATCH | `/invoices/:id/notes` | salesRoutes.ts |
| POST | `/invoices/:id/remind` | salesRoutes.ts |
| POST | `/invoices/:id/void` | salesRoutes.ts |
| GET | `/payment-terms` | salesRoutes.ts |
| GET | `/payments` | salesRoutes.ts |
| POST | `/payments` | salesRoutes.ts |
| POST | `/payments/:id/allocate` | salesRoutes.ts |
| POST | `/payments/:id/void` | salesRoutes.ts |
| GET | `/recurring-invoices` | salesRoutes.ts |
| POST | `/recurring-invoices` | salesRoutes.ts |
| POST | `/recurring-invoices/run-due` | salesRoutes.ts |
| GET | `/reports/ar-aging` | salesRoutes.ts |
| GET | `/reseller-permits` | salesRoutes.ts |
| POST | `/reseller-permits` | salesRoutes.ts |
| GET | `/pos/catalog` | smartOpsRoutes.ts |
| POST | `/pos/checkout` | smartOpsRoutes.ts |
| POST | `/pos/orders/:id/suspend` | smartOpsRoutes.ts |
| POST | `/pos/orders/:id/void` | smartOpsRoutes.ts |
| POST | `/pos/preview` | smartOpsRoutes.ts |
| POST | `/pos/scan` | smartOpsRoutes.ts |
| GET | `/pos/shifts` | smartOpsRoutes.ts |
| POST | `/pos/shifts` | smartOpsRoutes.ts |
| POST | `/pos/shifts/:id/close` | smartOpsRoutes.ts |
| GET | `/pos/shifts/:id/transactions` | smartOpsRoutes.ts |
| GET | `/pos/shifts/current` | smartOpsRoutes.ts |
| GET | `/pos/suspended` | smartOpsRoutes.ts |
| POST | `/pos/suspended/:id/resume` | smartOpsRoutes.ts |
| POST | `/smart-ops/initialize-accounts` | smartOpsRoutes.ts |
| GET | `/smart-ops/marketing` | smartOpsRoutes.ts |
| POST | `/smart-ops/marketing/campaigns` | smartOpsRoutes.ts |
| POST | `/smart-ops/marketing/messages` | smartOpsRoutes.ts |
| PATCH | `/smart-ops/marketing/messages/:id` | smartOpsRoutes.ts |
| POST | `/smart-ops/marketing/rules` | smartOpsRoutes.ts |
| PATCH | `/smart-ops/marketing/rules/:id` | smartOpsRoutes.ts |
| POST | `/smart-ops/marketing/rules/:id/run` | smartOpsRoutes.ts |
| POST | `/smart-ops/marketing/templates` | smartOpsRoutes.ts |
| GET | `/smart-ops/overview` | smartOpsRoutes.ts |
| GET | `/smart-ops/price-cards` | smartOpsRoutes.ts |
| POST | `/smart-ops/price-cards/presets` | smartOpsRoutes.ts |
| GET | `/smart-ops/promotions` | smartOpsRoutes.ts |
| POST | `/smart-ops/promotions` | smartOpsRoutes.ts |
| PATCH | `/smart-ops/promotions/:id` | smartOpsRoutes.ts |
| GET | `/smart-ops/referrals` | smartOpsRoutes.ts |
| GET | `/smart-ops/referrals/attributions` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/campaigns` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/campaigns/:id/activate` | smartOpsRoutes.ts |
| GET | `/smart-ops/referrals/campaigns/:id/budget` | smartOpsRoutes.ts |
| PATCH | `/smart-ops/referrals/campaigns/:id/config` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/campaigns/:id/finance-approval` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/campaigns/:id/lifecycle` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/campaigns/:id/management-approval` | smartOpsRoutes.ts |
| GET | `/smart-ops/referrals/cases` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/cases` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/cases/:id/decision` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/cases/:id/review` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/codes` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/codes/:id/click` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/events` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/events/:id/credit` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/events/:id/payout` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/events/:id/qualify` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/events/:id/reverse` | smartOpsRoutes.ts |
| POST | `/smart-ops/referrals/programs` | smartOpsRoutes.ts |
| PATCH | `/smart-ops/referrals/programs/:id` | smartOpsRoutes.ts |
| POST | `/auth/2fa/backup-codes` | twoFactorRoutes.ts |
| POST | `/auth/2fa/disable` | twoFactorRoutes.ts |
| POST | `/auth/2fa/enroll` | twoFactorRoutes.ts |
| GET | `/auth/2fa/status` | twoFactorRoutes.ts |
| POST | `/auth/2fa/verify` | twoFactorRoutes.ts |
| GET | `/audit/logs` | userRoutes.ts |
| POST | `/invitations` | userRoutes.ts |
| POST | `/invitations/accept` | userRoutes.ts |
| GET | `/permissions/matrix` | userRoutes.ts |
| GET | `/users` | userRoutes.ts |
| POST | `/users/:userId/deactivate` | userRoutes.ts |
| PATCH | `/users/:userId/membership` | userRoutes.ts |
| DELETE | `/users/:userId/membership` | userRoutes.ts |
| GET | `/wallets` | walletRoutes.ts |
| GET | `/wallets/:id` | walletRoutes.ts |
| POST | `/wallets/:id/allocations` | walletRoutes.ts |
| POST | `/wallets/:id/deposits` | walletRoutes.ts |
| POST | `/wallets/:id/payments` | walletRoutes.ts |
| GET | `/wallets/:id/reconciliation` | walletRoutes.ts |
| POST | `/wallets/:id/refunds` | walletRoutes.ts |
| PATCH | `/wallets/:id/status` | walletRoutes.ts |
| GET | `/wallets/:id/transactions` | walletRoutes.ts |

## Migrations

| Version | Name | Down | RLS enables | Tables |
|---------|------|------|-------------|--------|
| 0001 | core_identity_and_companies | yes | 10 | companies, users, company_memberships, api_tokens, login_attempts, user_preferences, company_settings, request_keys, payment_terms, txn_classes, backups, accountants_copies, qbo_mappings |
| 0002 | accounting_coa_and_general_ledger | yes | 4 | accounts, fiscal_periods, journal_transactions, journal_lines |
| 0003 | contacts_sales_and_receivables | yes | 19 | customers, reseller_permits, invoice_messages, estimates, estimate_lines, invoices, invoice_lines, payments, payment_allocations, credit_memos, credit_memo_lines, credit_applications, invoice_reminder_rules, invoice_reminders, customer_statements, recurring_invoices, recurring_invoice_lines, memorized_transactions, memorized_transaction_lines |
| 0004 | purchases_payables_and_banking | yes | 17 | vendors, purchase_orders, purchase_order_lines, bills, bill_lines, bill_payments, bill_payment_allocations, vendor_credits, vendor_credit_lines, vendor_credit_applications, bank_accounts, reconciliations, bank_transactions, bank_check_details, bank_rules, deposit_other_lines, duplicate_dismissals |
| 0005 | inventory_materials_and_boms | yes | 7 | paper_specifications, inventory_items, material_specifications, item_variants, item_bom_components, inventory_adjustments, inventory_movements |
| 0006 | payroll_assets_budgets_docs_audit | yes | 23 | employees, employee_bank_accounts, benefit_codes, employee_benefits, pay_runs, pay_stubs, pay_stub_benefits, pto_policies, pto_accruals, onboarding_tasks, time_entries, fixed_asset_types, fixed_assets, budgets, stored_files, attachments, ocr_templates, email_templates, email_log, audit_log, document_audits, saved_reports, tax_category_mappings |
| 0007 | printing_production_exams_contracts | yes | 13 | printing_machines, printing_estimates, printing_estimate_lines, printing_contracts, contract_assessment_milestones, exam_assessment_batches, exam_papers, printing_jobs, production_operations, finishing_operations, quality_control_inspections, delivery_notes, delivery_note_lines |
| 0008 | auth_sessions_invitations_and_supabase | yes | 1 | user_invitations, auth_sessions, password_recovery_tokens |
| 0009 | accounting_foundation_enhancements | yes | 0 | — |
| 0010 | commercial_fx_and_banking_enhancements | yes | 1 | exchange_rates |
| 0011 | phase9_production_workflow_integration | yes | 5 | purchase_requisitions, purchase_requisition_lines, goods_receipts, goods_receipt_lines, job_material_requirements |
| 0012 | slowbooks_migration_and_reconciliation | yes | 5 | migration_batches, migration_company_runs, migration_checkpoints, migration_id_map, migration_exceptions, migration_reconciliation_snapshots |
| 0013 | finance_controls_and_reporting | yes | 5 | approval_policies, approval_requests, fiscal_period_close_tasks, report_schedules, report_schedule_runs |
| 0014 | dedicated_approval_and_email_status | yes | 0 | — |
| 0015 | tenant_scheduler_and_email_delivery | yes | 0 | scheduler_leases |
| 0016 | accumulated_depreciation_contra | yes | 0 | — |
| 0017 | inventory_ops_and_read_models | yes | 5 | stock_counts, stock_count_lines, stock_transfers, stock_transfer_lines, stock_damages |
| 0018 | stock_balances_by_location | yes | 1 | stock_balances |
| 0019 | smart_operations_and_pos | yes | 13 | promotions, referral_programs, referral_campaigns, referral_codes, pos_orders, pos_order_tenders, promotion_redemptions, referral_events, marketing_templates, marketing_automation_rules, marketing_campaigns, marketing_messages, price_card_presets |
| 0020 | customer_wallet | yes | 4 | printing_number_counters, customer_wallets, customer_wallet_allocations, customer_wallet_transactions |
| 0021 | printing_contract_lifecycle | yes | 1 | contract_acceptances |
| 0022 | printing_contract_amendments | yes | 1 | contract_amendments |
| 0023 | printing_contract_gap_closure | yes | 0 | — |
| 0024 | examination_production_integrity | yes | 2 | exam_paper_events, exam_paper_invoice_links |
| 0025 | customer_master_governance | yes | 0 | — |
| 0026 | examination_lifecycle_completion | yes | 0 | — |
| 0027 | customer_center_upgrade | yes | 2 | fx_revaluation_runs, fx_revaluation_lines |
| 0028 | vendor_supplier_center | yes | 1 | vendor_statements |
| 0029 | examination_d3_teacher_quantities | yes | 0 | — |
| 0030 | referral_config_and_attribution | yes | 3 | referral_attributions, referral_budget_reservations, referral_cases |
| 0031 | wallet_referral_credit_and_recovery | yes | 0 | — |
| 0032 | referral_governance | yes | 4 | discount_budgets, discount_usage, referral_reward_approvals, referral_compliance_logs |
| 0033 | pos_governance | yes | 4 | pos_shifts, pos_suspended_sales, pos_transactions, pos_shift_audit |
| 0034 | ai_assistant | yes | 6 | ai_config, ai_conversations, ai_messages, ai_anomaly_alerts, ai_proposed_actions, ai_audit_logs |
| 0035 | security_2fa | yes | 0 | user_two_factor_secrets, user_backup_codes |
| 0036 | customers_contacts_branches | yes | 2 | customer_contacts, customer_branches |
| 0037 | payroll_advances_deductions | yes | 3 | salary_advances, payroll_deduction_rules, employee_allowances |
| 0038 | delivery_vehicles_drivers | yes | 3 | vehicles, drivers, delivery_schedules |
| 0040 | documents_qr | yes | 1 | document_qr_codes |
| 0041 | communications_consent | yes | 3 | communication_consents, communication_preferences, communication_suppressions |
| 0043 | system_admin | yes | 2 | integrations, subscription_plans, subscriptions, release_versions |
