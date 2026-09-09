-- 045_people_foundation_v2.sql
--
-- People Foundation V2: canonical birthday + start-date fields on employees,
-- plus provider-agnostic external identity mapping table.
--
-- birthday_month / birthday_day
--   Recurring birthday — no year stored (privacy + simplicity).
--   Valid pair or both NULL. Feb 29 allowed (birthday is a recurring event).
--   Impossible dates (Apr 31, Feb 30, etc.) rejected by CHECK constraint.
--
-- started_on
--   Canonical Killer Kebab employment start date. Kockpit-owned.
--   Not synced from Planday or any external system.
--
-- employee_external_identities
--   Maps external workforce-system identities to ONE canonical employee.
--   Uniqueness: (provider, external_scope, external_id) and
--               (employee_id, provider, external_scope).
--   RLS enabled — no broad client policies; service_role only.

-- ─── Employees: new columns ───────────────────────────────────────────────────

ALTER TABLE employees
  ADD COLUMN birthday_month smallint,
  ADD COLUMN birthday_day   smallint,
  ADD COLUMN started_on     date;

-- Birthday pair constraint:
--   Both NULL (no birthday recorded) OR both valid (month 1-12, day in range).
--   Feb 29 is explicitly allowed so people born on a leap day can record it.
ALTER TABLE employees
  ADD CONSTRAINT chk_birthday_pair CHECK (
    (birthday_month IS NULL AND birthday_day IS NULL)
    OR (
      birthday_month IS NOT NULL
      AND birthday_day   IS NOT NULL
      AND birthday_month BETWEEN 1 AND 12
      AND birthday_day BETWEEN 1 AND (
        CASE birthday_month
          WHEN 1  THEN 31
          WHEN 2  THEN 29  -- allow Feb 29 (leap-day birthdays)
          WHEN 3  THEN 31
          WHEN 4  THEN 30
          WHEN 5  THEN 31
          WHEN 6  THEN 30
          WHEN 7  THEN 31
          WHEN 8  THEN 31
          WHEN 9  THEN 30
          WHEN 10 THEN 31
          WHEN 11 THEN 30
          WHEN 12 THEN 31
        END
      )
    )
  );

-- ─── External identity mapping ────────────────────────────────────────────────

CREATE TABLE employee_external_identities (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- provider: lowercase name of the external system, e.g. 'planday', 'dully'
  provider       text        NOT NULL CHECK (provider = lower(provider) AND provider <> ''),
  -- external_scope: scopes the ID within the provider (portal ID, company ID, etc.)
  external_scope text        NOT NULL CHECK (external_scope <> ''),
  -- external_id: the employee's ID in the external system within that scope
  external_id    text        NOT NULL CHECK (external_id <> ''),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- One external identity can belong to only one canonical employee
  UNIQUE (provider, external_scope, external_id),
  -- One canonical employee has at most one identity per provider+scope
  UNIQUE (employee_id, provider, external_scope)
);

ALTER TABLE employee_external_identities ENABLE ROW LEVEL SECURITY;

-- No broad client SELECT/INSERT/UPDATE/DELETE policies.
-- All access is via service_role (createServiceClient) in server actions.
-- Future sync jobs will use service_role exclusively.
