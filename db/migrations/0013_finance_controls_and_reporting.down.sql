-- Rollback Migration 0013: Finance Controls, Period Close Checklist & Operational Reporting

DROP POLICY IF EXISTS p_report_schedule_runs_isolation ON report_schedule_runs;
DROP TABLE IF EXISTS report_schedule_runs;

DROP POLICY IF EXISTS p_report_schedules_isolation ON report_schedules;
DROP TRIGGER IF EXISTS trg_report_schedules_updated_at ON report_schedules;
DROP TABLE IF EXISTS report_schedules;

DROP POLICY IF EXISTS p_period_close_tasks_isolation ON fiscal_period_close_tasks;
DROP TRIGGER IF EXISTS trg_period_close_tasks_updated_at ON fiscal_period_close_tasks;
DROP TABLE IF EXISTS fiscal_period_close_tasks;

DROP POLICY IF EXISTS p_approval_requests_isolation ON approval_requests;
DROP TRIGGER IF EXISTS trg_approval_requests_updated_at ON approval_requests;
DROP TABLE IF EXISTS approval_requests;

DROP POLICY IF EXISTS p_approval_policies_isolation ON approval_policies;
DROP TRIGGER IF EXISTS trg_approval_policies_updated_at ON approval_policies;
DROP TABLE IF EXISTS approval_policies;