-- Killer Kockpit — explicit canonical location → Killer Kalculator store mapping
--
-- Killer Kalculator is the source of truth for Revenue, Salary %, Kombo % and
-- Lemonade units. It identifies stores by slug. This column is the single,
-- persistent mapping used by the Store Manager Dashboard; no name matching
-- happens at request time.
--
-- NULL = location not supported by Kalculator (Airport, Parken): the SMD shows
-- sales KPIs as unavailable.
--
-- Additive only. Existing RLS on locations is unchanged (SUPER_ADMIN/UM read;
-- the SMD reads it with the service client only after the location has been
-- authorised against the user's active assignments).

ALTER TABLE locations
  ADD COLUMN kalculator_store_slug text UNIQUE
    CHECK (kalculator_store_slug IN (
      'indre-by', 'vesterbro', 'christianshavn',
      'fisketorvet', 'frederiksberg', 'norrebro'
    ));

-- Exact canonical names verified against production rows on 2026-10-07.
-- Borgergade is the Indre By store (OnlinePOS "Indre By", Planday dept 149668).
UPDATE locations SET kalculator_store_slug = 'indre-by'       WHERE name = 'Killer Kebab Borgergade';
UPDATE locations SET kalculator_store_slug = 'vesterbro'      WHERE name = 'Killer Kebab Vesterbro';
UPDATE locations SET kalculator_store_slug = 'christianshavn' WHERE name = 'Killer Kebab Christianshavn';
UPDATE locations SET kalculator_store_slug = 'fisketorvet'    WHERE name = 'Killer Kebab Fisketorvet';
UPDATE locations SET kalculator_store_slug = 'frederiksberg'  WHERE name = 'Killer Kebab Frederiksberg';
UPDATE locations SET kalculator_store_slug = 'norrebro'       WHERE name = 'Killer Kebab Nørrebro';
