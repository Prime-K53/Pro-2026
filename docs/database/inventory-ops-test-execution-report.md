# Advanced Inventory Operations — Test Execution Report

Generated: 2026-11-27T16:52:40.805Z

**Result:** 9/9 passed (1035ms)

| Suite | Test | Result | Duration | Details |
| --- | --- | --- | --- | --- |
| 1. Read Models | Every inventory read endpoint returns server-sourced data for a stocked item | PASS | 362ms | loaded RM-A4-80G (raw_material) on hand 120.0000, avg cost 145.0000; 8 read endpoints OK |
| 2. Stock Damage | Damage decrements on_hand by exactly the posted quantity and balances the GL | PASS | 105ms | RM-A4-80G 2.5000 written off at 362.5000; on hand 120.000000 -> 117.5000; JE-00007 balanced |
| 3. Stock Damage Guard | Damage larger than on_hand is rejected and leaves stock untouched | PASS | 20ms | rejected with NEGATIVE_STOCK |
| 4. Stock Transfer | Transfer moves location balances, leaves on_hand unchanged and posts no journal | PASS | 45ms | TRF-00001: Main -> Warehouse B, 1.2500 moved, on_hand unchanged at 1.2500, balances 2 rows summing to on_hand |
| 5. Stock Count | A draft count leaves stock untouched; posting applies the variance and balances the GL | PASS | 92ms | SC-00001: variance -725.0000, on hand 117.5000 -> 112.5000, re-post rejected |
| 6. Deactivation Guard | Deactivating an item with stock or history is refused and changes nothing | PASS | 27ms | rejected with ITEM_HAS_STOCK |
| 7. Item Master Edit | Renaming an item and editing costs leaves on_hand and avg_cost untouched, and rejects duplicate SKUs | PASS | 120ms | renamed RM-A4-80G-R-R; name, SKU and costs updated with on_hand 1125000 and avg_cost unchanged; duplicate SKU and blank name rejected |
| 8. RBAC Enforcement | Roles without the granular inventory permissions are refused on the write endpoints | PASS | 189ms | accountant refused damage/transfer/count (403) but may read (200); production may read (200) |
| 9. Ledger Invariant | Every journal entry in the company remains balanced after all operations | PASS | 75ms | all journals balanced, no negative stock, 0 floating-point columns |
