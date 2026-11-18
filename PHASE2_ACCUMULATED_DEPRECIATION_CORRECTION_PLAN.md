# PHASE2_ACCUMULATED_DEPRECIATION_CORRECTION_PLAN.md

## 1. Existing account model
Supported account types: Bank, AccountsReceivable, OtherCurrentAsset, Inventory, FixedAsset, AccountsPayable, CreditCard, OtherCurrentLiability, PayrollLiability, LongTermLiability, Equity, Income, CostOfGoodsSold, Expense, OtherExpense. No ContraAsset type exists. Normal balance is derived from account type via `normalBalanceFor()` and stored in `accounts.normal_balance`. Calculations use account type (DEBIT_NORMAL_TYPES), not the stored normal_balance column.

## 2. Current Account 1590 record
Seeded as FixedAsset, detail_type fixed_asset, normal_balance debit, is_system true, is_control false, balance 0. Opening amount -24000 posted via postOpeningBalances into account 1590 (credit side, yielding -24000 natural debit-normal balance).

## 3. Current opening-balance representation
Opening balances stored as journal entries (opening_balance source type) with per-account amounts; negative amounts posted to the credit side. 1590 receives -24000, posted as credit 24000, yielding natural balance -24000 (contra).

## 4. Current normal-balance calculation
`normalBalanceFor(type)` returns debit for FixedAsset. Stored normal_balance = debit. Natural delta = dr - cr (debit normal) = -24000.

## 5. Current Trial Balance treatment
FixedAsset is a balance-sheet type; net = dr - cr; 1590 shows as credit 24000. TB balanced.

## 6. Current Balance Sheet treatment
fixedAssetsSec includes all FixedAsset accounts including 1590; 1590 line = -24000, total = gross - 24000 = net. Accounting equation holds.

## 7. Identified defect
Account 1590 normal_balance stored as 'debit' but contra-asset should be 'credit'. No general contra mechanism existed.

## 8. Proposed correction
Add general `is_contra` boolean column to accounts. Flip normal_balance for contra accounts. Seed/migrate 1590 as is_contra=true, normal_balance=credit. Keep arithmetic type-based (FixedAsset debit-normal) so netting remains correct and no report changes needed. Update `normalBalanceFor` to accept isContra.

## 9. Expected effect on balances
No change to numeric balances. 1590 normal_balance display changes from debit to credit. TB/BS totals unchanged.

## 10. Database migration
Migration 0016 adds is_contra column and updates 1590 rows.

## 11. Historical journal preservation
No journal entries modified. Opening balance -24000 preserved.

## 12. Regression tests
Accounting 10/10, commercial 8/8, db 8/8, typecheck, build.

## 13. Rollback
Migration 0016 down removes is_contra and reverts 1590 normal_balance to debit.
