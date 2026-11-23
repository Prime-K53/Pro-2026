-- Rollback Migration 0043: System Admin — Integrations, Subscriptions, Releases.

DROP TABLE IF EXISTS release_versions;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS subscription_plans;
DROP TABLE IF EXISTS integrations;