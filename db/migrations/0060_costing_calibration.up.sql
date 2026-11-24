-- Migration 0060: Persist costing calibration inputs.
--
-- The paper and toner costing engines (src/shared/paperCalc.ts, tonerCalc.ts)
-- already support calibrated caliper, sheets-per-pack and cartridge toner mass,
-- but the columns did not exist, so "auto" costing silently fell back to
-- rated-yield / estimated values. These columns let the calibration be stored on
-- the specification records and read back, so auto costing uses measured actuals.

ALTER TABLE paper_specifications
  ADD COLUMN IF NOT EXISTS measured_caliper_mm NUMERIC(9, 3) CHECK (measured_caliper_mm IS NULL OR measured_caliper_mm > 0),
  ADD COLUMN IF NOT EXISTS sheets_per_pack NUMERIC(12, 2) CHECK (sheets_per_pack IS NULL OR sheets_per_pack > 0);

ALTER TABLE material_specifications
  ADD COLUMN IF NOT EXISTS cartridge_toner_mass_grams NUMERIC(12, 4)
    CHECK (cartridge_toner_mass_grams IS NULL OR cartridge_toner_mass_grams > 0);