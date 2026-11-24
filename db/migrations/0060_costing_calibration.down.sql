-- Down migration for 0060: drop the costing calibration columns.

ALTER TABLE paper_specifications
  DROP COLUMN IF EXISTS measured_caliper_mm,
  DROP COLUMN IF EXISTS sheets_per_pack;

ALTER TABLE material_specifications
  DROP COLUMN IF EXISTS cartridge_toner_mass_grams;