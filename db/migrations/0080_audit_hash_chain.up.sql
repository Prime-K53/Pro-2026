-- Tamper-evidence: chain each audit row to the previous one via prev_hash.
-- The row hash becomes sha256(prev_hash || payload), so altering/deleting any
-- historical row breaks the chain and is detectable.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64);