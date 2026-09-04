-- 030_fix_compute_next_occurrence_strict.sql
--
-- Bug fix: compute_next_todo_occurrence was declared STRICT, which causes it
-- to return NULL whenever any argument is NULL — including p_day, which is
-- intentionally NULL for all non-monthly rules (daily, weekdays, weekly,
-- specific weekdays). This made complete_recurring_todo always fail for
-- non-monthly recurring todos with a constraint violation on scheduled_for.
--
-- Fix: recreate without STRICT (CALLED ON NULL INPUT is the default).
-- The function body already handles NULL p_day correctly via the CASE
-- branches that simply ignore p_day for non-monthly rules.

CREATE OR REPLACE FUNCTION public.compute_next_todo_occurrence(
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

-- Re-apply revokes (CREATE OR REPLACE preserves existing grants,
-- but be explicit to guard against any role reset).
REVOKE EXECUTE ON FUNCTION public.compute_next_todo_occurrence(text, smallint, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.compute_next_todo_occurrence(text, smallint, date) FROM authenticated;
