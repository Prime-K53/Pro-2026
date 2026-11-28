-- 0086_ai_attempt_period
--
-- D-05/R2 Correction A: persist the reservation's immutable UTC accounting
-- period on each attempt so settlement/release/recovery never recompute it.
-- Additive; backfills existing rows from reserved_at; then NOT NULL.

BEGIN;

ALTER TABLE ai_usage_attempts ADD COLUMN period TEXT;

UPDATE ai_usage_attempts
   SET period = to_char(reserved_at AT TIME ZONE 'UTC', 'YYYY-MM')
 WHERE period IS NULL;

ALTER TABLE ai_usage_attempts ALTER COLUMN period SET NOT NULL;

CREATE INDEX ai_usage_attempts_period_idx ON ai_usage_attempts (company_id, period);

COMMIT;