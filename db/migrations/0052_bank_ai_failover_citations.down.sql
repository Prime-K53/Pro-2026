-- Rollback Migration 0052.

ALTER TABLE ai_messages DROP COLUMN IF EXISTS citations;
ALTER TABLE ai_config
  DROP COLUMN IF EXISTS fallback_api_key_encrypted,
  DROP COLUMN IF EXISTS fallback_model,
  DROP COLUMN IF EXISTS fallback_provider;
ALTER TABLE employees
  DROP COLUMN IF EXISTS bank_account_number,
  DROP COLUMN IF EXISTS bank_account_name,
  DROP COLUMN IF EXISTS bank_name;