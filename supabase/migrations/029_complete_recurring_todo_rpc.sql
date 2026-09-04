-- 029_complete_recurring_todo_rpc.sql
--
-- Atomic SECURITY DEFINER RPC for completing a recurring to-do.
--
-- Design decisions
-- ----------------
-- • SECURITY DEFINER so the function can write rows for p_actor_id without
--   exposing a service-role key to the client.  Matches the existing pattern
--   used for other privileged RPCs in this codebase.
--
-- • SELECT … FOR UPDATE acquires a row-level lock before any reads, preventing
--   double-completion from concurrent requests (e.g. double-tap, two tabs).
--
-- • Ownership is checked inside the lock — after the lock is acquired so the
--   check operates on the committed row, not a snapshot.
--
-- • Idempotency: if the row is already completed AND a child already exists
--   (todos_one_child_per_parent enforces at-most-one) we return the child id
--   rather than raising an error.  The client can treat this as success.
--
-- • Catch-up loop: "next" is defined as STRICTLY AFTER Copenhagen today.
--   We advance the anchor date forward one period at a time until we land
--   on a date that is strictly in the future.  This prevents a recurring
--   to-do that was missed for several days from spawning with today's date
--   (which would immediately show as "due today" and still feel overdue).
--
-- • Non-recurring todos: completing a non-recurring todo via this function is
--   an error — callers should use the plain UPDATE path.  We RAISE EXCEPTION
--   so the bug surfaces loudly rather than silently doing nothing.
--
-- • search_path = '' (empty) throughout to prevent search-path injection.
--   All schema-qualified names use pg_catalog or public explicitly.
--
-- • REVOKE EXECUTE from anon + authenticated — this function is called
--   exclusively via createServiceClient() (service-role key) from the
--   Next.js server.  Client roles must not call it directly.

CREATE OR REPLACE FUNCTION public.complete_recurring_todo(
  p_todo_id  uuid,
  p_actor_id uuid
)
RETURNS uuid          -- returns the new child todo's id; NULL if idempotent no-op
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_todo          public.todos%ROWTYPE;
  v_existing_child uuid;
  v_cph_today     date;
  v_next_date     date;
  v_new_id        uuid;
BEGIN
  -- -------------------------------------------------------------------------
  -- 1. Lock the row for the duration of this transaction.
  --    NOWAIT would surface contention quickly; we accept brief serialisation.
  -- -------------------------------------------------------------------------
  SELECT * INTO v_todo
  FROM public.todos
  WHERE id = p_todo_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'todo not found: %', p_todo_id;
  END IF;

  -- -------------------------------------------------------------------------
  -- 2. Ownership check.
  -- -------------------------------------------------------------------------
  IF v_todo.user_id <> p_actor_id THEN
    RAISE EXCEPTION 'permission denied: todo % does not belong to %', p_todo_id, p_actor_id;
  END IF;

  -- -------------------------------------------------------------------------
  -- 3. Must be a recurring todo.
  -- -------------------------------------------------------------------------
  IF v_todo.recurrence_rule IS NULL THEN
    RAISE EXCEPTION 'todo % is not recurring; use the plain complete action instead', p_todo_id;
  END IF;

  -- -------------------------------------------------------------------------
  -- 4. Idempotency: already completed + child exists → return child id.
  -- -------------------------------------------------------------------------
  IF v_todo.completed_at IS NOT NULL THEN
    SELECT id INTO v_existing_child
    FROM public.todos
    WHERE parent_todo_id = p_todo_id
    LIMIT 1;

    RETURN v_existing_child; -- may be NULL if no child (edge case: manually completed without RPC)
  END IF;

  -- -------------------------------------------------------------------------
  -- 5. Mark this occurrence as completed.
  -- -------------------------------------------------------------------------
  UPDATE public.todos
  SET completed_at = now(),
      updated_at   = now()
  WHERE id = p_todo_id;

  -- -------------------------------------------------------------------------
  -- 6. Compute Copenhagen "today" for the catch-up loop.
  --    We compare strictly: next_date > cph_today.
  -- -------------------------------------------------------------------------
  v_cph_today := (now() AT TIME ZONE 'Europe/Copenhagen')::date;

  -- Start advancing from the current occurrence's scheduled_for anchor.
  -- If scheduled_for is somehow NULL (shouldn't happen given constraint), fall
  -- back to the completion date in Copenhagen timezone.
  v_next_date := public.compute_next_todo_occurrence(
    v_todo.recurrence_rule,
    v_todo.recurrence_day,
    COALESCE(v_todo.scheduled_for, v_cph_today)
  );

  -- -------------------------------------------------------------------------
  -- 7. Catch-up loop: advance until strictly after today.
  --    ">" not ">=" — same-day recurrence must land tomorrow-or-later.
  -- -------------------------------------------------------------------------
  WHILE v_next_date <= v_cph_today LOOP
    v_next_date := public.compute_next_todo_occurrence(
      v_todo.recurrence_rule,
      v_todo.recurrence_day,
      v_next_date
    );
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 8. Insert the next occurrence.
  --    Copies: title, priority, notes, recurrence_rule, recurrence_day.
  --    Sets:   scheduled_for = v_next_date, parent_todo_id = current id.
  --    Does NOT copy: completed_at, cancelled_at, parent_todo_id of ancestor.
  -- -------------------------------------------------------------------------
  v_new_id := gen_random_uuid();

  INSERT INTO public.todos (
    id,
    user_id,
    title,
    priority,
    notes,
    recurrence_rule,
    recurrence_day,
    scheduled_for,
    parent_todo_id,
    created_at,
    updated_at
  ) VALUES (
    v_new_id,
    v_todo.user_id,
    v_todo.title,
    v_todo.priority,
    v_todo.notes,
    v_todo.recurrence_rule,
    v_todo.recurrence_day,
    v_next_date,
    p_todo_id,
    now(),
    now()
  );

  RETURN v_new_id;
END;
$$;

-- Revoke execute from client roles — service-role only via createServiceClient().
REVOKE EXECUTE ON FUNCTION public.complete_recurring_todo(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_recurring_todo(uuid, uuid) FROM authenticated;
