-- Rollback 0002: Drop Double-Entry General Ledger, Fiscal Periods & Chart of Accounts

DROP TRIGGER IF EXISTS trg_prevent_posted_line_mutation ON journal_lines;
DROP TRIGGER IF EXISTS trg_prevent_posted_txn_mutation ON journal_transactions;
DROP TRIGGER IF EXISTS trg_enforce_balanced_journal_line ON journal_lines;
DROP TRIGGER IF EXISTS trg_enforce_balanced_journal_txn ON journal_transactions;
DROP FUNCTION IF EXISTS prevent_posted_journal_mutation() CASCADE;
DROP FUNCTION IF EXISTS enforce_balanced_journal() CASCADE;

DROP TABLE IF EXISTS journal_lines CASCADE;
DROP TABLE IF EXISTS journal_transactions CASCADE;
DROP TABLE IF EXISTS fiscal_periods CASCADE;
DROP TABLE IF EXISTS accounts CASCADE;
