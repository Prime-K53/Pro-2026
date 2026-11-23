-- Rollback Migration 0041: Communications — Consent & Suppression.

DROP TABLE IF EXISTS communication_suppressions;
DROP TABLE IF EXISTS communication_preferences;
DROP TABLE IF EXISTS communication_consents;