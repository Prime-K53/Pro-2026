-- POS refunds: each refund is linked to an original completed order.
-- Refunds reverse GL + inventory, require pos:write, and reject double refunds.

CREATE TABLE IF NOT EXISTS pos_refunds (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  pos_order_id BIGINT NOT NULL,
  shift_id BIGINT,
  refunded_by BIGINT REFERENCES users(id),
  amount NUMERIC(19, 4) NOT NULL CHECK (amount > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'reversed')),
  reversed_at TIMESTAMPTZ,
  reversed_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pos_refunds_company UNIQUE (company_id, id),
  CONSTRAINT fk_pos_refunds_order FOREIGN KEY (company_id, pos_order_id)
    REFERENCES pos_orders (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_pos_refunds_shift FOREIGN KEY (company_id, shift_id)
    REFERENCES pos_shifts (company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pos_refunds_company ON pos_refunds (company_id);
CREATE INDEX IF NOT EXISTS idx_pos_refunds_order ON pos_refunds (company_id, pos_order_id);
CREATE INDEX IF NOT EXISTS idx_pos_refunds_shift ON pos_refunds (company_id, shift_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_refunds_one_active_per_order
  ON pos_refunds (company_id, pos_order_id) WHERE status = 'completed';

ALTER TABLE pos_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_refunds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_pos_refunds_isolation ON pos_refunds;
CREATE POLICY p_pos_refunds_isolation ON pos_refunds
  USING (company_id = app_current_company_id())
  WITH CHECK (company_id = app_current_company_id());

-- Add refund amount tracking to pos_orders for quick lookup.
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(19, 4) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0);