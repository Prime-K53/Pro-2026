-- Rollback Migration 0038: Delivery — Vehicles, Drivers, Scheduling.

ALTER TABLE delivery_notes DROP COLUMN IF EXISTS delivery_cost;
DROP TABLE IF EXISTS delivery_schedules;
DROP TABLE IF EXISTS drivers;
DROP TABLE IF EXISTS vehicles;