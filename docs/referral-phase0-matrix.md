# Referral Management — Phase 0 Verified Capability Matrix

Status legend: **Verified** / **Defective** / **Incomplete** / **Missing** / **Duplicated** / **Finance decision needed**

This matrix is a source-of-truth audit of the existing referral + customer-wallet surface.
It is read-only; nothing was changed in the repo to build it.

## 1. Source of truth

- Migration `db/migrations/0019_smart_operations_and_pos.up.sql` is the referral migration.
- There is no separate `referral` migration.
- Referral code lives in:
  - `src/server/services/smartOpsService.ts`
  - `src/server/routes/smartOpsRoutes.ts`
  - `src/services/smartOpsApi.ts`
  - `src/components/views/smart-ops/ReferralsTab.tsx`
- Wallet surface lives in `src/server/routes/walletRoutes.ts` + `src/server/services/customerWalletService.ts`.
- Wallet schema lives in `db/migrations/0020_customer_wallet.up.sql`.

## 2. What currently exists in code

### 2.1 Referral domain model

| Area | File / table | Verdict |
|---|---|---|
| Referral programs (rates, accounts, active/paused, dates) | `referral_programs` | **Verified** |
| Referral campaigns (channel, tracking code, target, budget) | `referral_campaigns` | **Verified** |
| Advocate referral codes (code, clicks, conversions, revenue, reward_balance) | `referral_codes` | **Verified** |
| Referral events / rewards ledger (qualifying, discount, reward, accrual/payout JEs, CM, bank txn) | `referral_events` | **Verified** |
| POS orders store referral_code_id + referral_discount | `pos_orders` | **Verified** |
| Journal source type for referral postings | `journal_transactions.source_type IN (… 'referral_reward' …)` | **Verified** |
| RLS on every new referral table | each table has `app_rls_allowed(company_id)` policy | **Verified** |
| Starter program defaults (5% commission / 5% referee / K100 min spend) | `POST /api/smart-ops/initialize-accounts` | **Verified** |

The migration is a legit second migration, not a missing Phase 0 artifact. The referral schema is real.

### 2.2 Referral service API surface

| Capability | Function | Verdict |
|---|---|---|
| List full referral workspace + analytics | `listReferralWorkspace()` | **Verified** |
| Create referral program | `createReferralProgram()` | **Verified** |
| Toggle program active/paused | `toggleReferralProgram()` | **Verified** |
| Create campaign | `createReferralCampaign()` | **Verified** |
| Issue advocate code | `createReferralCode()` | **Verified** |
| Credit a click | `recordReferralClick()` | **Verified** |
| Manual conversion (no order) with GL accrual | `recordManualReferralConversion()` | **Verified** |
| Bank / customer-credit payout of accrued reward | `payoutReferralReward()` | **Verified** |
| POS preview includes referral discount + referrer reward | `previewPosOrder()` → `referralApplied` | **Verified** |
| POS checkout applies referral discount and accrues event | `checkoutPosOrder()` | **Verified** |
| POS void reverses unpaid referral accrual + voids event + reverses counters | `voidPosOrder()` | **Verified** |
| Referral URLs: buildWhatsAppUrl / interpolateTemplate | utility helpers | **Verified** |

### 2.3 Referral route surface

| Endpoint | Permission | Verdict |
|---|---|---|
| `GET /api/smart-ops/referrals` | `smart_ops:read` | **Verified** |
| `POST /api/smart-ops/referrals/programs` | `smart_ops:write` | **Verified** |
| `PATCH /api/smart-ops/referrals/programs/:id` | `smart_ops:write` | **Verified** |
| `POST /api/smart-ops/referrals/campaigns` | `smart_ops:write` | **Verified** |
| `POST /api/smart-ops/referrals/codes` | `smart_ops:write` | **Verified** |
| `POST /api/smart-ops/referrals/codes/:id/click` | `smart_ops:write` | **Verified** |
| `POST /api/smart-ops/referrals/events` | `smart_ops:write` | **Verified** |
| `POST /api/smart-ops/referrals/events/:id/payout` | `smart_ops:write` | **Verified** |

### 2.4 Frontend referral workspace

`ReferralsTab.tsx` is a real ERP workspace with three sub-tabs:
- Conversions & reward settlement
- Advocate codes & campaigns
- Programs & GL rules

It posts to the same referral endpoints above. **Verified**, not missing.

## 3. What the spec is asking for vs what exists

| Spec capability | Exists in code now | Verdict |
|---|---|---|
| 5% referee discount | Yes, in starter defaults + configurable per program | **Verified** |
| 3% advocate wallet bonus | Not as a separate wallet path; existing path posts to `6450/2150` GL or credit memo/bank payout | **Missing / finance decision** |
| Paid + delivered qualification for reward | Not enforced; current accrual happens on order completion or manual entry alone | **Incomplete** |
| Deterministic idempotency on referral mutations | Partial | **Defective** |
| First-valid attribution rule | Not implemented | **Missing** |
| Self-referral prevention | Not implemented | **Missing** |
| New-customer eligibility rule | Not implemented | **Missing** |
| Manual conversion validation | Partial | **Defective** |
| Duplicate conversion prevention (one paid-and-delivered order → one event) | Not implemented | **Missing** |
| Click-counter correction (conversion ≥ click) | Exists in `accrueReferralEventAndJournal` | **Defective** |
| Secure referral tokens | Not applicable to current plain-text code model | **Missing / design decision** |

## 4. Verified good parts (do not rewrite these)

- Schema integrity: `referral_events` has FKs to `referral_codes`, `referral_programs`, optional `referral_campaigns`, optional `customers`, optional `pos_orders`, optional `invoices`, optional `accounts`, optional `credit_memos`, optional accrual/payout/bank txns.
- Accrual journal posts Dr `6450` / Cr `2150` using `sourceType: 'referral_reward'` and an idempotency key.
- Payout to customer credit posts Dr `2150` / Cr `1100` and creates a credit memo + JE.
- Payout to bank/cash posts Dr `2150` / Cr bank account + bank transaction + JE.
- POS void reverses unpaid accrual JE and voids associated referral event + reverses counters.
- POS referral discount posts to `4100` contra-revenue, same as promo discount.
- Wallet system is a real, separate subledger with deposits, allocations, invoice payments, refunds, status, reconciliation, and DB-level idempotency on wallet transactions.

## 5. Defect register (must fix before Phase 1 is trustworthy)

### D-1 — Referral accrual idempotency is non-deterministic
File: `smartOpsService.ts: accrueReferralEventAndJournal()`

Current idempotency key:
```
`ref-accrual-${companyId}-${params.posOrderId ?? 'manual'}-${Date.now()}-${Math.random()}`
```
Problem:
- It includes `Date.now()` and `Math.random()`, so the same logical accrual can produce many keys.
- This means replay safety depends on caller retry discipline, not on deterministic keys.
- For POS orders this is somewhat mitigated downstream by `saveRouteIdempotency` on `pos_checkout`, but the accrual JE itself is still non-deterministic and the manual conversion path has no route-level replay guard at all.

Verdict: **Defective**. Fix to deterministic keying (for example `ref-accrual-${companyId}-${referralCodeId}-${orderOrManualKey}-${customerOrRefereeKey}`) and add route-level idempotency to manual conversion.

### D-2 — Manual referral conversion has no order-based duplicate guard
Files:
- `smartOpsService.ts: recordManualReferralConversion()`
- `smartOpsRoutes.ts: POST /api/smart-ops/referrals/events`

Problem:
- The endpoint accepts `referralCodeId + qualifyingAmount + optional refereeCustomerId`.
- There is no enforcement that a given paid-and-delivered order can only create one referral event.
- There is no check that the same referral code cannot be used to accrue multiple conversions for the same underlying transaction.
- Status defaults to `approved`.

This is the core duplicate-conversion gap the spec calls out.

Verdict: **Defective / Missing**. Validation + one-event-per-qualifying-order rule needed.

### D-3 — Click counter correction logic is wrong for analytics
File: `smartOpsService.ts: accrueReferralEventAndJournal()`

Current update:
```
clicks_count = GREATEST(clicks_count, conversions_count + 1)
```
Problem:
- This patches clicks upward only when conversions exceed clicks.
- It does not model the real relationship the spec wants, where a click is a separate tracked event and the conversion rate is derived from actual click records.
- If clicks were ever correct and later corrected, this logic can silently inflate clicks to match conversions instead of preserving the true click count.

Verdict: **Defective**. Click/conversion counting needs a real model; patch logic is a workaround.

### D-4 — No self-referral prevention
Files:
- `smartOpsService.ts: evaluateReferralForOrder()`
- `smartOpsService.ts: recordManualReferralConversion()`

Problem:
- Nothing prevents the advocate/customer using their own referral code from being the referee.
- For POS, the order's `customerId` is not compared against `referral_codes.referrer_customer_id`.
- For manual conversions, no similar guard exists.

Verdict: **Missing**.

### D-5 — No new-customer / first-paid-and-delivered eligibility rule
Files:
- `smartOpsService.ts: evaluateReferralForOrder()`
- `posService.ts: checkoutPosOrder()`

Problem:
- The spec wants the 5% referee discount and any reward attribution gated on a paid-and-delivered qualification and, for referee discounts, on the referee being a new customer for the program.
- Current code only checks code/program active, date window, and min spend.
- There is no existing-customer detection and no “first qualifying order only” rule.

Verdict: **Missing**.

### D-6 — Paid-and-delivered qualification is not enforced for reward payout
Files:
- `smartOpsService.ts: payoutReferralReward()`
- `referral_events.status` semantics

Problem:
- Event statuses include `pending`, `approved`, `credited`, `paid`, `voided`.
- Accrual defaults to `approved` for both POS and manual.
- There is no enforced distinction between:
  - click tracked,
  - discount applied,
  - order completed/paid,
  - reward eligible.
- Payout currently blocks only on already-settled or voided.

Verdict: **Incomplete**. The payable state must be gated on paid + delivered, not merely on existence of an event.

### D-7 — Payout path is not wallet-based for advocate store credit
Files:
- `smartOpsService.ts: payoutReferralReward()` settlementType `customer_credit`
- `walletRoutes.ts`
- `customerWalletService.ts`

Current customer-credit path:
- Creates a credit memo against `ar1100` and posts Dr `2150` / Cr `1100`.

Spec asks for:
- Advocate reward paid into the customer's wallet as a credit balance, so it can later be spent like other wallet funds.

Current wallet system is real, but the referral payout path does not use it.

Verdict: **Missing / finance decision**. Two sub-decisions:
1. Does the 3% advocate reward go into the existing `customer_wallet` subledger, or stay as credit memos?
2. If wallet, what is the wallet credit transaction type and liability mapping? Wallet currently expects its own liability account (`2310` by default), not `2150`.

This is the key integration point the spec asks for and the one earlier audit notes flagged as “wallet not verified.” The wallet code is verified as real; what is missing is the referral→wallet credit path and agreement on the account mapping.

### D-8 — No separate customer wallet credit for referee discount
Files:
- `posService.ts: computePosPricing()` and `checkoutPosOrder()`

Current behavior:
- Referee discount is a POS contra-revenue discount processed through `4100`.
- There is no wallet credit created for the referee's 5% discount.

If the spec wants the 5% referee discount to land in a customer wallet usable on later orders, that path does not exist.

Verdict: **Missing / finance decision** — same wallet question as D-7.

### D-9 — “Secure referral tokens” not implemented
Files: referral code model generally

Current model:
- Codes are plain business codes like `REF-XXXX-123`, stored in `referral_codes.code`.
- There is no separate secure token, no obscured sharing token, no token issuance/expiry model.

Spec mentions “secure tokens” as a Phase 1 item.

Verdict: **Missing / design decision**. Depends on whether “secure token” means obscured share links, one-time tokens, per-referee claim tokens, or something else.

## 6. What does not exist and is not currently in scope

- No referral reconciliation report or payable ledger view separate from the workspace analytics.
- No referral-specific permission beyond `smart_ops:read` / `smart_ops:write`.
- No referral webhook or external sharing tracking beyond click counter.
- No stored referral click events table; clicks are incremented on `referral_codes` only.
- No referral “claim” flow for the referee to bind a referral to themselves before ordering.

## 7. Phase 0 conclusion

Verified:
- Referral schema, service, routes, and ERP workspace all exist.
- Migration is real and is a second migration, not missing.
- Wallet system exists and is real; it just is not wired into referral rewards yet.

The earlier audit statements that labeled wallet/referral as “UNVERIFIED / missing” are inaccurate at the repository level: the referral feature and the wallet feature both exist. What is missing is end-to-end spec behavior on top of them.

Defective / missing items that block Phase 1 trustworthiness:
- D-1 non-deterministic accrual idempotency
- D-2 no duplicate conversion guard on manual + POS referral attribution
- D-3 click-counter correction logic
- D-4 no self-referral prevention
- D-5 no new-customer / first-paid-and-delivered eligibility
- D-6 no paid-and-delivered gating for payable status
- D-7 reward does not credit the customer wallet
- D-8 referee discount does not credit a wallet either
- D-9 no secure token model

Finance decisions needed before coding Phase 1:
1. Should the 3% advocate reward credit the customer wallet, or remain as credit memos / bank payouts?
2. Should the 5% referee discount also become wallet credit, or stay as a POS contra-revenue discount?
3. If wallet credits are used, should the referral liability stay on `2150`, move to the wallet liability account, or use both with a transfer?
4. What does “paid and delivered” mean operationally here: POS completed order, invoiced paid order, or both?
5. What does “secure token” mean in this business context?

## 8. Recommended next move

Do not start Phase 1 coding yet. First:
1. Confirm the wallet reward path decision with finance / product (D-7, D-8, the account mapping).
2. Confirm “paid and delivered” definition (D-6).
3. Confirm “secure token” meaning (D-9).
4. Once those are settled, Phase 1 core-integrity work becomes well scoped:
   - deterministic idempotency for referral accrual and manual conversion
   - first-valid attribution + one-event-per-qualifying-order
   - self-referral prevention
   - new-customer eligibility
   - paid-and-delivered gating
   - click/conversion counting model
   - secure token design if required
