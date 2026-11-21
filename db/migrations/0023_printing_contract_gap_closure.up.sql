-- Migration 0023: Printing Contract Gap Closure
-- Closes G-07 (DB-level assessment-sum constraint), G-09/G-10 (invoice links +
-- lifecycle column parity), G-13 (numbering scope guard), and G-21 (credit
-- balance / unallocated amount).
--
-- Legacy data stance (decision D-3): the assessment-sum constraint trigger is
-- created NOT VALID and validated only after scripts/printing-contract-preflight.ts
-- reports zero unquarantined mismatches.

-- 1. Invoice links + credit-balance bookkeeping on printing_contracts
ALTER TABLE printing_contracts
  ADD COLUMN IF NOT EXISTS deposit_invoice_id BIGINT,
  ADD COLUMN IF NOT EXISTS deposit_invoice_number VARCHAR(64),
  ADD COLUMN IF NOT EXISTS unallocated_amount NUMERIC(19,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS allocated_amount NUMERIC(19,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS credit_balance BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_unallocated_amount;
ALTER TABLE printing_contracts
  ADD CONSTRAINT ck_printing_contracts_unallocated_amount
  CHECK (unallocated_amount >= 0);

ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_allocated_amount;
ALTER TABLE printing_contracts
  ADD CONSTRAINT ck_printing_contracts_allocated_amount
  CHECK (allocated_amount >= 0);

ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_credit_balance;
ALTER TABLE printing_contracts
  ADD CONSTRAINT ck_printing_contracts_credit_balance
  CHECK (credit_balance = FALSE OR status <> 'completed');

ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS fk_printing_contracts_deposit_invoice;
ALTER TABLE printing_contracts
  ADD CONSTRAINT fk_printing_contracts_deposit_invoice
  FOREIGN KEY (company_id, deposit_invoice_id)
  REFERENCES invoices (company_id, id) ON DELETE RESTRICT;

-- 2. Milestone invoice number (links already exist via linked_invoice_id in 0007)
ALTER TABLE contract_assessment_milestones
  ADD COLUMN IF NOT EXISTS linked_invoice_number VARCHAR(64);

-- 3. Numbering counters: contract/exam_paper scopes are already allowed by
--    0020; restate the CHECK so the constraint is explicit and idempotent.
ALTER TABLE printing_number_counters
  DROP CONSTRAINT IF EXISTS printing_number_counters_scope_check;
ALTER TABLE printing_number_counters
  ADD CONSTRAINT printing_number_counters_scope_check
  CHECK (scope IN ('contract','exam_paper','wallet_txn'));

ALTER TABLE printing_number_counters
  DROP CONSTRAINT IF EXISTS uq_printing_number_counters_company_scope;
ALTER TABLE printing_number_counters
  ADD CONSTRAINT uq_printing_number_counters_company_scope
  UNIQUE (company_id, scope);

-- 4. Assessment-sum invariant (G-07).
--    The trigger rejects any schedule whose agreed amounts exceed the prepaid
--    total. It is a DEFERRABLE INITIALLY DEFERRED constraint trigger so that a
--    multi-row insert (e.g. contract creation) is validated once at commit.
--
--    Two separate functions are required because the two tables expose the
--    contract key under different column names (contract_id on milestones,
--    id on printing_contracts).

CREATE OR REPLACE FUNCTION assert_contract_assessment_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_contract_id BIGINT;
  v_company_id  BIGINT;
  v_allocated   NUMERIC(19,4);
  v_prepaid     NUMERIC(19,4);
BEGIN
  v_contract_id := COALESCE(NEW.contract_id, OLD.contract_id);
  v_company_id  := COALESCE(NEW.company_id, OLD.company_id);

  SELECT total_prepaid_amount::NUMERIC(19,4)
    INTO v_prepaid
    FROM printing_contracts
   WHERE company_id = v_company_id AND id = v_contract_id;

  IF v_prepaid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(agreed_amount), 0)::NUMERIC(19,4)
    INTO v_allocated
    FROM contract_assessment_milestones
   WHERE company_id = v_company_id AND contract_id = v_contract_id;

  IF v_allocated > v_prepaid THEN
    RAISE EXCEPTION 'ASSESSMENT_SUM_MISMATCH'
      USING ERRCODE = '23514',
            MESSAGE = format(
              'Assessment allocation %s exceeds the prepaid amount %s for contract %s',
              v_allocated, v_prepaid, v_contract_id
            );
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION assert_contract_total_prepaid()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_contract_id BIGINT;
  v_company_id  BIGINT;
  v_allocated   NUMERIC(19,4);
BEGIN
  v_contract_id := COALESCE(NEW.id, OLD.id);
  v_company_id  := COALESCE(NEW.company_id, OLD.company_id);

  SELECT COALESCE(SUM(agreed_amount), 0)::NUMERIC(19,4)
    INTO v_allocated
    FROM contract_assessment_milestones
   WHERE company_id = v_company_id AND contract_id = v_contract_id;

  IF v_allocated > NEW.total_prepaid_amount::NUMERIC(19,4) THEN
    RAISE EXCEPTION 'ASSESSMENT_SUM_MISMATCH'
      USING ERRCODE = '23514',
            MESSAGE = format(
              'Prepaid amount %s is below the assessment allocation %s for contract %s',
              NEW.total_prepaid_amount, v_allocated, v_contract_id
            );
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_contract_assessment_sum ON contract_assessment_milestones;
CREATE CONSTRAINT TRIGGER trg_validate_contract_assessment_sum
  AFTER INSERT OR UPDATE OF agreed_amount, contract_id OR DELETE
  ON contract_assessment_milestones
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_contract_assessment_allocation();

DROP TRIGGER IF EXISTS trg_validate_contract_total_prepaid ON printing_contracts;
CREATE CONSTRAINT TRIGGER trg_validate_contract_total_prepaid
  AFTER UPDATE OF total_prepaid_amount
  ON printing_contracts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_contract_total_prepaid();

-- 5. Indexes
CREATE INDEX IF NOT EXISTS ix_contract_milestones_company_status
  ON contract_assessment_milestones (company_id, status);
CREATE INDEX IF NOT EXISTS ix_contract_milestones_contract_number
  ON contract_assessment_milestones (company_id, contract_id, assessment_number);

-- 6. Backfill counters from existing contract numbers (guarded against
--    non-numeric suffixes so legacy CTR-YYYY-NN forms do not break the cast).
INSERT INTO printing_number_counters (company_id, scope, year, last_value)
SELECT c.company_id,
       'contract'::VARCHAR(32),
       EXTRACT(YEAR FROM c.start_date)::SMALLINT,
       COALESCE(MAX(NULLIF(regexp_replace(c.contract_number, '^CTR-[0-9]{4}-', ''), '')::INTEGER), 0)
  FROM printing_contracts c
 WHERE c.contract_number ~ '^CTR-[0-9]{4}-[0-9]+$'
 GROUP BY c.company_id, EXTRACT(YEAR FROM c.start_date)
ON CONFLICT (company_id, scope, year) DO NOTHING;

INSERT INTO printing_number_counters (company_id, scope, year, last_value)
SELECT p.company_id,
       'exam_paper'::VARCHAR(32),
       EXTRACT(YEAR FROM CURRENT_DATE)::SMALLINT,
       COALESCE(MAX(NULLIF(regexp_replace(p.job_number, '^EXM-[0-9]{4}-', ''), '')::INTEGER), 0)
  FROM exam_papers p
 WHERE p.job_number ~ '^EXM-[0-9]{4}-[0-9]+$'
 GROUP BY p.company_id
ON CONFLICT (company_id, scope, year) DO NOTHING;

-- 7. Backfill unallocated_amount and credit_balance
UPDATE printing_contracts c
   SET unallocated_amount = GREATEST(
         c.total_prepaid_amount - COALESCE(s.allocated, 0), 0
       )
  FROM (
    SELECT contract_id, company_id, SUM(agreed_amount)::NUMERIC(19,4) AS allocated
      FROM contract_assessment_milestones
     GROUP BY contract_id, company_id
  ) s
 WHERE s.company_id = c.company_id
   AND s.contract_id = c.id
   AND c.unallocated_amount = 0.0000;

UPDATE printing_contracts
   SET credit_balance = TRUE
 WHERE status = 'active'
   AND completed_assessments >= total_assessments
   AND remaining_balance > 0;

-- 8. Backfill allocated_amount from wallet allocations
UPDATE printing_contracts c
   SET allocated_amount = COALESCE(a.total, 0)
  FROM (
    SELECT contract_id, SUM(amount - released_amount - forfeited_amount)::NUMERIC(19,4) AS total
      FROM customer_wallet_allocations
     WHERE company_id IS NOT NULL
     GROUP BY contract_id
  ) a
 WHERE a.contract_id = c.id;

-- 9. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pms_app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pms_app_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pms_app_role;