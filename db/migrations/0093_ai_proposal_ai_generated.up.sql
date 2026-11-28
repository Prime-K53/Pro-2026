-- Migration 0093: mark AI-generated proposed actions (AI is the maker; a human approves).
ALTER TABLE ai_proposed_actions ADD COLUMN IF NOT EXISTS created_by_ai BOOLEAN NOT NULL DEFAULT FALSE;