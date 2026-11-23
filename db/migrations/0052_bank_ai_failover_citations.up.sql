-- Prime ERP — V2: bank details, AI failover and citations.

-- WS-4 R6: employee bank details for bank-file generation.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT;

-- WS-2 A4: optional provider failover.
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS fallback_provider TEXT,
  ADD COLUMN IF NOT EXISTS fallback_model TEXT,
  ADD COLUMN IF NOT EXISTS fallback_api_key_encrypted TEXT;

-- WS-2 A7: structured source citations for grounded answers.
ALTER TABLE ai_messages
  ADD COLUMN IF NOT EXISTS citations JSONB;