-- Prime ERP — V2 WS-2: AI usage budgets.
--
-- Per-company monthly token and cost ceilings. Enforcement happens before any
-- provider call; exceeding a ceiling fails closed with a 429.

CREATE TABLE IF NOT EXISTS ai_budgets (
  company_id           BIGINT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  monthly_token_limit  BIGINT NOT NULL DEFAULT 1000000 CHECK (monthly_token_limit >= 0),
  monthly_cost_limit   NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (monthly_cost_limit >= 0),
  cost_per_1k_tokens   NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (cost_per_1k_tokens >= 0),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY p_ai_budgets_isolation ON ai_budgets
  USING (company_id = app_current_company_id());