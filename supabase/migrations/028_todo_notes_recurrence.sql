-- 028_todo_notes_recurrence.sql
--
-- Adds notes, recurrence fields, and a pure date-helper function to todos.
--
-- Design decisions
-- ----------------
-- • Notes (optional, plain text) stored directly on the todo row.  The existing
--   owner UPDATE policy covers note edits; management SELECT policy covers reads.
--   No new RLS needed.
--
-- • Recurrence is stored on each occurrence row rather than a parent table.
--   One active occurrence at a time — completing spawns the next (migration 029).
--   The rule travels with the todo, making the occurrence self-describing.
--
-- • scheduled_for (date, nullable) anchors the occurrence to a calendar date.
--   NULL for non-recurring todos.  Deliberate: due-dates for ordinary todos are
--   a separate future feature and must not be conflated with recurrence anchoring.
--
-- • recurrence_rule encodes the cadence as a text enum.  Specific weekdays use
--   3-letter codes (mon–sun) so the rule is human-readable without a join.
--
-- • recurrence_day (1-31) stores the user-intended day for monthly rules.
--   The actual scheduled_for may be clamped to the month's last day
--   (e.g. day=31 in February → Feb 28/29) but the intent is preserved.
--
-- • parent_todo_id links each occurrence back to the one that spawned it.
--   The UNIQUE partial index todos_one_child_per_parent (where IS NOT NULL)
--   is a DB-level invariant ensuring at most one next occurrence per parent —
--   defence-in-depth against any future duplicate-generation bugs.
--
-- • compute_next_todo_occurrence is an IMMUTABLE helper that encodes the
--   anchor-based schedule arithmetic.  Declared at migration level so it can be
--   called from the RPC in migration 029 without search-path tricks.
--   It is NOT callable by anon/authenticated — no EXECUTE grant is added.
--   (Supabase does not auto-grant EXECUTE on non-security-definer functions
--   declared without an explicit GRANT.)

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------

ALTER TABLE todos
  ADD COLUMN notes           text,
  ADD COLUMN scheduled_for   date,
  ADD COLUMN recurrence_rule text,
  ADD COLUMN recurrence_day  smallint,
  ADD COLUMN parent_todo_id  uuid REFERENCES todos(id);

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

-- Valid recurrence rule values (NULL = not recurring)
ALTER TABLE todos ADD CONSTRAINT todos_recurrence_rule_valid CHECK (
  recurrence_rule IS NULL OR recurrence_rule IN (
    'daily', 'weekdays', 'weekly',
    'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
    'monthly'
  )
);

-- recurrence_day must be in 1-31 range when present
ALTER TABLE todos ADD CONSTRAINT todos_recurrence_day_range CHECK (
  recurrence_day IS NULL OR recurrence_day BETWEEN 1 AND 31
);

-- monthly rule requires a specific day of month
ALTER TABLE todos ADD CONSTRAINT todos_recurrence_day_required CHECK (
  recurrence_rule IS DISTINCT FROM 'monthly' OR recurrence_day IS NOT NULL
);

-- any recurring todo must have a scheduled_for anchor
ALTER TABLE todos ADD CONSTRAINT todos_scheduled_for_required CHECK (
  recurrence_rule IS NULL OR scheduled_for IS NOT NULL
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Defence-in-depth: each parent occurrence may spawn at most one child.
-- NULL parent_todo_id is excluded so non-recurring / first-occurrence rows
-- can coexist freely (NULL != NULL in SQL uniqueness semantics).
CREATE UNIQUE INDEX todos_one_child_per_parent
  ON todos (parent_todo_id)
  WHERE parent_todo_id IS NOT NULL;

-- Efficient query of "open recurring todos due on or before a given date"
-- (used by Today page to exclude future occurrences).
CREATE INDEX todos_user_recurring_open
  ON todos (user_id, scheduled_for ASC)
  WHERE recurrence_rule IS NOT NULL
    AND completed_at IS NULL
    AND cancelled_at IS NULL;

-- ---------------------------------------------------------------------------
-- Pure date-arithmetic helper
-- ---------------------------------------------------------------------------
-- Returns the next scheduled date after p_from according to the rule.
-- Always returns a date STRICTLY AFTER p_from.
-- Monthly: clamps to the last day of the target month to handle 29/30/31.
-- All arithmetic is pure / deterministic — no timezone side effects.
-- Called by complete_recurring_todo (migration 029) and by SQL tests.

CREATE OR REPLACE FUNCTION compute_next_todo_occurrence(
  p_rule text,
  p_day  smallint,   -- only meaningful for rule = 'monthly'
  p_from date
) RETURNS date
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE p_rule
    -- -----------------------------------------------------------------
    -- Daily: always one calendar day forward
    -- -----------------------------------------------------------------
    WHEN 'daily' THEN p_from + 1

    -- -----------------------------------------------------------------
    -- Weekdays (Mon-Fri): skip the weekend
    -- ISODOW: Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6, Sun=7
    -- -----------------------------------------------------------------
    WHEN 'weekdays' THEN
      CASE EXTRACT(ISODOW FROM p_from)::int
        WHEN 5 THEN p_from + 3   -- Friday   → next Monday
        WHEN 6 THEN p_from + 2   -- Saturday → next Monday
        WHEN 7 THEN p_from + 1   -- Sunday   → next Monday
        ELSE       p_from + 1    -- Mon-Thu  → next day
      END

    -- -----------------------------------------------------------------
    -- Weekly: exactly 7 days, same day of week
    -- -----------------------------------------------------------------
    WHEN 'weekly' THEN p_from + 7

    -- -----------------------------------------------------------------
    -- Specific weekday: next occurrence of that weekday, strictly after
    -- p_from (minimum 1 day, maximum 7 days away).
    -- Formula: ((target_isodow - current_isodow + 6) % 7) + 1
    --   gives values 1-7, always strictly positive.
    -- -----------------------------------------------------------------
    WHEN 'mon' THEN p_from + ((1 - EXTRACT(ISODOW FROM p_from)::int + 6 + 7) % 7 + 1)
    WHEN 'tue' THEN p_from + ((2 - EXTRACT(ISODOW FROM p_from)::int + 6 + 7) % 7 + 1)
    WHEN 'wed' THEN p_from + ((3 - EXTRACT(ISODOW FROM p_from)::int + 6 + 7) % 7 + 1)
    WHEN 'thu' THEN p_from + ((4 - EXTRACT(ISODOW FROM p_from)::int + 6 + 7) % 7 + 1)
    WHEN 'fri' THEN p_from + ((5 - EXTRACT(ISODOW FROM p_from)::int + 6 + 7) % 7 + 1)
    WHEN 'sat' THEN p_from + ((6 - EXTRACT(ISODOW FROM p_from)::int + 6 + 7) % 7 + 1)
    WHEN 'sun' THEN p_from + ((7 - EXTRACT(ISODOW FROM p_from)::int + 6 + 7) % 7 + 1)

    -- -----------------------------------------------------------------
    -- Monthly: same day-of-month next month, clamped to month length.
    -- date_trunc('month', p_from) + '1 month' = first day of next month.
    -- EXTRACT(DAY FROM last_day_of_next_month) = day count of next month.
    -- We then add (clamped_day - 1) days from the first.
    -- -----------------------------------------------------------------
    WHEN 'monthly' THEN
      (pg_catalog.date_trunc('month', p_from) + INTERVAL '1 month')::date
      + (
          LEAST(
            p_day::int,
            EXTRACT(DAY FROM
              (pg_catalog.date_trunc('month', p_from) + INTERVAL '2 months - 1 day')
            )::int
          ) - 1
        )

    ELSE NULL
  END
$$;

-- Revoke execute from anon and authenticated — this function is an internal
-- implementation detail, called only from the service-role RPC in migration 029.
REVOKE EXECUTE ON FUNCTION compute_next_todo_occurrence(text, smallint, date) FROM anon;
REVOKE EXECUTE ON FUNCTION compute_next_todo_occurrence(text, smallint, date) FROM authenticated;
