-- Rollback Migration 0034: AI Assistant.

DROP TABLE IF EXISTS ai_audit_logs;
DROP TABLE IF EXISTS ai_proposed_actions;
DROP TABLE IF EXISTS ai_anomaly_alerts;
DROP TABLE IF EXISTS ai_messages;
DROP TABLE IF EXISTS ai_conversations;
DROP TABLE IF EXISTS ai_config;