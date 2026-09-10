-- 053_seed_operational_audit_v1.sql
--
-- Seeds the Master Operational Audit template (v1) as a draft.
-- audit_key: operational_audit  |  version: 1  |  status: draft
--
-- 98 checkpoints, 43 Core Standards, 15 Red Flags.
-- All Red Flags are also Core Standards.
-- Section counts: 5,12,7,6,8,8,12,12,11,8,9
--
-- Do NOT publish here — publish via publish_audit_template() when ready.

DO $$
DECLARE
  v_template_id uuid := gen_random_uuid();
BEGIN

  INSERT INTO audit_templates (id, audit_key, version, title, status)
  VALUES (v_template_id, 'operational_audit', 1, 'Master Operational Audit', 'draft');

  -- ── SECTION 1: Outside & First Impression (5) ──────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 101, 'Outside & First Impression',
     'The outside display and signage follow the Killer Kebab standard.',
     true, true, false, true, false),
    (v_template_id, 102, 'Outside & First Impression',
     'The entrance is clean and presentable.',
     true, true, false, false, false),
    (v_template_id, 103, 'Outside & First Impression',
     'Windows and glass are clean.',
     true, true, false, false, false),
    (v_template_id, 104, 'Outside & First Impression',
     'Outdoor furniture is clean and organised.',
     true, true, false, false, false),
    (v_template_id, 105, 'Outside & First Impression',
     'The outside area is free from waste, clutter and unnecessary items.',
     true, true, false, false, false);

  -- ── SECTION 2: Guest Area (12) ─────────────────────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 201, 'Guest Area',
     'Tables and chairs are clean.',
     true, true, false, false, false),
    (v_template_id, 202, 'Guest Area',
     'The floor is clean.',
     true, true, false, true, false),
    (v_template_id, 203, 'Guest Area',
     'Corners, edges, walls and visible surfaces are clean.',
     true, true, false, false, false),
    (v_template_id, 204, 'Guest Area',
     'The trash station is clean and the bins are not overflowing.',
     true, true, false, false, false),
    (v_template_id, 205, 'Guest Area',
     'The guest area is organised and free from clutter.',
     true, true, false, false, false),
    (v_template_id, 206, 'Guest Area',
     'The lighting is working correctly.',
     true, true, false, false, false),
    (v_template_id, 207, 'Guest Area',
     'The music follows the Killer Kebab standard.',
     true, true, false, true, false),
    (v_template_id, 208, 'Guest Area',
     'Contents of customer-facing refrigerated units are faced forward and presented neatly.',
     true, true, false, false, false),
    (v_template_id, 209, 'Guest Area',
     'Tables and chairs are positioned correctly and kept orderly.',
     true, true, false, false, false),
    (v_template_id, 210, 'Guest Area',
     'All guest-area lamps are working correctly.',
     true, true, false, false, false),
    (v_template_id, 211, 'Guest Area',
     'The bartop is clean and presentable.',
     true, true, false, false, false),
    (v_template_id, 212, 'Guest Area',
     'The bartop is free from unnecessary clutter.',
     true, true, false, false, false);

  -- ── SECTION 3: Bar / Roll Station (7) ──────────────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 301, 'Bar / Roll Station',
     'The rolling station is clean, with two cloths available.',
     true, true, false, true, false),
    (v_template_id, 302, 'Bar / Roll Station',
     'The floor is clean, including underneath counters and equipment.',
     true, true, false, true, false),
    (v_template_id, 303, 'Bar / Roll Station',
     'Refrigerated units are clean inside and outside.',
     true, true, false, false, false),
    (v_template_id, 304, 'Bar / Roll Station',
     'Equipment, handles and contact surfaces are clean.',
     true, true, false, false, false),
    (v_template_id, 305, 'Bar / Roll Station',
     'The bar area is free from unnecessary items and clutter.',
     true, true, false, false, false),
    (v_template_id, 306, 'Bar / Roll Station',
     'A wet cloth is available at the meat station.',
     true, true, false, false, false),
    (v_template_id, 307, 'Bar / Roll Station',
     'The meat station is clean and presentable.',
     true, true, false, true, false);

  -- ── SECTION 4: Kitchen / Prep Area (6) ─────────────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 401, 'Kitchen / Prep Area',
     'Prep tables and work surfaces are clean.',
     true, true, false, false, false),
    (v_template_id, 402, 'Kitchen / Prep Area',
     'The floor is thoroughly clean, including underneath tables and equipment.',
     true, true, false, true, false),
    (v_template_id, 403, 'Kitchen / Prep Area',
     'Corners, edges, walls and visible surfaces are clean.',
     true, true, false, false, false),
    (v_template_id, 404, 'Kitchen / Prep Area',
     'Refrigerated units are clean inside and outside.',
     true, true, false, true, false),
    (v_template_id, 405, 'Kitchen / Prep Area',
     'Equipment, handles and contact surfaces are clean.',
     true, true, false, false, false),
    (v_template_id, 406, 'Kitchen / Prep Area',
     'The kitchen/prep area is free from unnecessary items and clutter.',
     true, true, false, false, false);

  -- ── SECTION 5: Back Area / Passage / Storage (8) ───────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 501, 'Back Area / Passage / Storage',
     'Floors are clean, including underneath stored items.',
     true, true, false, true, false),
    (v_template_id, 502, 'Back Area / Passage / Storage',
     'Shelves are clean and organised.',
     true, true, false, false, false),
    (v_template_id, 503, 'Back Area / Passage / Storage',
     'Products and other items are stored correctly.',
     true, true, false, true, false),
    (v_template_id, 504, 'Back Area / Passage / Storage',
     'The back area is free from unnecessary clutter.',
     true, true, false, false, false),
    (v_template_id, 505, 'Back Area / Passage / Storage',
     'Passageways are clear and accessible.',
     true, true, false, true, true),
    (v_template_id, 506, 'Back Area / Passage / Storage',
     'Walls, corners and visible surfaces are clean.',
     true, true, false, false, false),
    (v_template_id, 507, 'Back Area / Passage / Storage',
     'Waste is handled correctly.',
     true, true, false, false, false),
    (v_template_id, 508, 'Back Area / Passage / Storage',
     'If flies are present, appropriate fly traps are in place.',
     true, true, false, true, false);

  -- ── SECTION 6: Food Safety & Hygiene (8) ───────────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 601, 'Food Safety & Hygiene',
     'FIFO and dating are followed correctly.',
     true, true, false, true, true),
    (v_template_id, 602, 'Food Safety & Hygiene',
     'Refrigeration temperatures are within the required standard.',
     true, true, false, true, true),
    (v_template_id, 603, 'Food Safety & Hygiene',
     'Food is protected from contamination.',
     true, true, false, true, true),
    (v_template_id, 604, 'Food Safety & Hygiene',
     'There is no visible risk of cross-contamination.',
     true, true, false, true, true),
    (v_template_id, 605, 'Food Safety & Hygiene',
     'The handwashing station is accessible and clean.',
     true, true, false, true, true),
    (v_template_id, 606, 'Food Safety & Hygiene',
     'Soap and paper are available at the handwashing station.',
     true, true, false, true, true),
    (v_template_id, 607, 'Food Safety & Hygiene',
     'Cleaning chemicals are stored correctly.',
     true, true, false, false, false),
    (v_template_id, 608, 'Food Safety & Hygiene',
     'Cloths and cleaning equipment are handled correctly.',
     true, true, false, false, false);

  -- ── SECTION 7: Prep / Operations (12) ──────────────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 701, 'Prep / Operations',
     'Meat is weighed according to standard.',
     true, true, false, true, false),
    (v_template_id, 702, 'Prep / Operations',
     'Meat holding temperature is correct.',
     true, true, false, true, true),
    (v_template_id, 703, 'Prep / Operations',
     'Lids are used correctly.',
     true, true, false, true, false),
    (v_template_id, 704, 'Prep / Operations',
     'The blade is properly sharp, and the meat is cut straight with no mushrooming.',
     true, true, false, true, false),
    (v_template_id, 705, 'Prep / Operations',
     'Bread is baked fresh to order.',
     true, true, false, true, false),
    (v_template_id, 706, 'Prep / Operations',
     'Correct portions are used.',
     true, true, false, true, false),
    (v_template_id, 707, 'Prep / Operations',
     'The correct product build is followed.',
     true, true, false, false, false),
    (v_template_id, 708, 'Prep / Operations',
     'The workstation is ready for service.',
     true, true, false, false, false),
    (v_template_id, 709, 'Prep / Operations',
     'Mint is present in the yoghurt.',
     true, true, false, false, false),
    (v_template_id, 710, 'Prep / Operations',
     'The mint is fresh, not oxidised, and covered with a wet napkin.',
     true, true, false, false, false),
    (v_template_id, 711, 'Prep / Operations',
     'The meat tray is scraped and clean.',
     true, true, false, true, false),
    (v_template_id, 712, 'Prep / Operations',
     'Working thermometers are present.',
     true, true, false, true, true);

  -- ── SECTION 8: Restroom (12) ────────────────────────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 801, 'Restroom',
     'There is no visible limescale or chalk buildup in the toilet bowl.',
     true, true, false, false, false),
    (v_template_id, 802, 'Restroom',
     'Toilet bowl freshener is present.',
     true, true, false, false, false),
    (v_template_id, 803, 'Restroom',
     'Toilet cleaner is available.',
     true, true, false, false, false),
    (v_template_id, 804, 'Restroom',
     'The toilet brush is presentable.',
     true, true, false, false, false),
    (v_template_id, 805, 'Restroom',
     'The sink and mirror are clean.',
     true, true, false, false, false),
    (v_template_id, 806, 'Restroom',
     'The floor is clean, including corners and details.',
     true, true, false, true, false),
    (v_template_id, 807, 'Restroom',
     'Soap is available.',
     true, true, false, true, true),
    (v_template_id, 808, 'Restroom',
     'Toilet paper is available.',
     true, true, false, true, false),
    (v_template_id, 809, 'Restroom',
     'The waste bin is clean and not overflowing.',
     true, true, false, false, false),
    (v_template_id, 810, 'Restroom',
     'The restroom is free from unnecessary storage and other items.',
     true, true, false, false, false),
    (v_template_id, 811, 'Restroom',
     'The restroom check has been completed and updated.',
     true, true, false, true, true),
    (v_template_id, 812, 'Restroom',
     'There is no unpleasant smell.',
     true, true, false, false, false);

  -- ── SECTION 9: Maintenance & Facilities (11) ────────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 901, 'Maintenance & Facilities',
     'Refrigerators and freezers are functioning correctly.',
     true, true, false, true, true),
    (v_template_id, 902, 'Maintenance & Facilities',
     'Refrigerator and freezer seals are intact and sealing properly.',
     true, true, false, true, true),
    (v_template_id, 903, 'Maintenance & Facilities',
     'Doors and handles are in good condition.',
     true, true, false, false, false),
    (v_template_id, 904, 'Maintenance & Facilities',
     'Lights are working correctly.',
     true, true, false, false, false),
    (v_template_id, 905, 'Maintenance & Facilities',
     'Screens are working correctly.',
     true, true, false, false, false),
    (v_template_id, 906, 'Maintenance & Facilities',
     'Operational equipment is functioning correctly.',
     true, true, false, true, false),
    (v_template_id, 907, 'Maintenance & Facilities',
     'Furniture is in good condition.',
     true, true, false, false, false),
    (v_template_id, 908, 'Maintenance & Facilities',
     'Sinks and taps are functioning correctly.',
     true, true, false, false, false),
    (v_template_id, 909, 'Maintenance & Facilities',
     'There are no visible leaks.',
     true, true, false, true, true),
    (v_template_id, 910, 'Maintenance & Facilities',
     'There is no visible damage requiring repair.',
     true, true, false, false, false),
    (v_template_id, 911, 'Maintenance & Facilities',
     'Previously reported facility issues are being followed up.',
     true, true, false, false, false);

  -- ── SECTION 10: Service / Staff (8) ─────────────────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 1001, 'Service / Staff',
     'The Hi/Bye routine is followed religiously by all staff.',
     true, true, false, true, false),
    (v_template_id, 1002, 'Service / Staff',
     'All staff wear the correct uniform.',
     true, true, false, true, false),
    (v_template_id, 1003, 'Service / Staff',
     'Staff appearance meets the required standard.',
     true, true, false, false, false),
    (v_template_id, 1004, 'Service / Staff',
     'Staff make eye contact when taking orders.',
     true, true, false, true, false),
    (v_template_id, 1005, 'Service / Staff',
     'Staff are polite, welcoming and forthcoming throughout the guest interaction.',
     true, true, false, false, false),
    (v_template_id, 1006, 'Service / Staff',
     'Staff demonstrate urgency during service.',
     true, true, false, true, false),
    (v_template_id, 1007, 'Service / Staff',
     'Staff know their stations and responsibilities.',
     true, true, false, false, false),
    (v_template_id, 1008, 'Service / Staff',
     'Team communication is professional.',
     true, true, false, false, false);

  -- ── SECTION 11: Operational Compliance (9) ──────────────────────────────

  INSERT INTO audit_checkpoints
    (template_id, sort_order, section, title, required, allow_na, failure_requires_comment, is_core_standard, is_red_flag)
  VALUES
    (v_template_id, 1101, 'Operational Compliance',
     'Opening and closing checklists are completed and up to date.',
     true, true, false, true, false),
    (v_template_id, 1102, 'Operational Compliance',
     'Cleaning checklists are completed and up to date.',
     true, true, false, false, false),
    (v_template_id, 1103, 'Operational Compliance',
     'Required temperature checks are completed and up to date.',
     true, true, false, true, true),
    (v_template_id, 1104, 'Operational Compliance',
     'Staff clock in and out correctly.',
     true, true, false, false, false),
    (v_template_id, 1105, 'Operational Compliance',
     'Cash-handling routines are followed correctly.',
     true, true, false, true, false),
    (v_template_id, 1106, 'Operational Compliance',
     'Call made to store: phone is present, turned on, and sound is enabled.',
     true, true, false, true, false),
    (v_template_id, 1107, 'Operational Compliance',
     'Required operational information is visible and up to date.',
     true, true, false, false, false),
    (v_template_id, 1108, 'Operational Compliance',
     'The manager on duty is actively managing the shift and has clear control of the operation.',
     true, true, false, true, false),
    (v_template_id, 1109, 'Operational Compliance',
     'Required actions from the previous audit have been completed or are on track against their deadlines.',
     true, true, false, false, false);

END;
$$;
