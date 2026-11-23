-- Prime ERP — V2 WS-4 R3: salary advance repayment tracking.
--
-- Tracks how much of each advance has been repaid so payroll runs can apply
-- the next installment and stop once the advance is settled.

ALTER TABLE salary_advances
  ADD COLUMN IF NOT EXISTS repaid_amount NUMERIC(12,2) NOT NULL DEFAULT 0;