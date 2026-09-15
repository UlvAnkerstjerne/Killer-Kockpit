-- Killer Kockpit — Atomic upgrade_recurring_todo RPC
--
-- Atomically marks a to-do as upgraded to a task AND, if the to-do is
-- recurring, spawns the next occurrence so future recurrences continue.
--
-- Called by upgradeTodoToTask server action instead of a bare UPDATE.
-- Handles both recurring and non-recurring to-dos uniformly.
--
-- Parameters:
--   p_todo_id  — the to-do being upgraded
--   p_task_id  — the newly created task UUID
--   p_actor_id — the authenticated user (must match todos.user_id)
--
-- Returns:
--   UUID of the new occurrence row (recurring), or NULL (non-recurring).

CREATE OR REPLACE FUNCTION public.upgrade_recurring_todo(
  p_todo_id  uuid,
  p_task_id  uuid,
  p_actor_id uuid
)
RETURNS uuid          -- new occurrence id; NULL if non-recurring
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_todo       public.todos%ROWTYPE;
  v_cph_today  date;
  v_next_date  date;
  v_new_id     uuid;
BEGIN
  -- -------------------------------------------------------------------------
  -- 1. Lock the row for the duration of this transaction.
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
  -- 3. Idempotency: already upgraded → return NULL.
  -- -------------------------------------------------------------------------
  IF v_todo.upgraded_to_task_id IS NOT NULL THEN
    RETURN NULL;
  END IF;

  -- -------------------------------------------------------------------------
  -- 4. Mark current occurrence as upgraded.
  -- -------------------------------------------------------------------------
  UPDATE public.todos
  SET upgraded_to_task_id = p_task_id,
      upgraded_at         = now(),
      updated_at          = now()
  WHERE id = p_todo_id;

  -- -------------------------------------------------------------------------
  -- 5. Non-recurring: done.
  -- -------------------------------------------------------------------------
  IF v_todo.recurrence_rule IS NULL THEN
    RETURN NULL;
  END IF;

  -- -------------------------------------------------------------------------
  -- 6. Recurring: compute next scheduled_for and spawn next occurrence.
  --    Same logic as complete_recurring_todo (catch-up loop included).
  -- -------------------------------------------------------------------------
  v_cph_today := (now() AT TIME ZONE 'Europe/Copenhagen')::date;

  v_next_date := public.compute_next_todo_occurrence(
    v_todo.recurrence_rule,
    v_todo.recurrence_day,
    COALESCE(v_todo.scheduled_for, v_cph_today)
  );

  -- Catch-up loop: advance until strictly after today.
  WHILE v_next_date <= v_cph_today LOOP
    v_next_date := public.compute_next_todo_occurrence(
      v_todo.recurrence_rule,
      v_todo.recurrence_day,
      v_next_date
    );
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 7. Insert next occurrence.
  --    Copies: title, priority, notes, recurrence_rule, recurrence_day.
  --    Does NOT copy: completed_at, cancelled_at, upgraded_to_task_id.
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
REVOKE EXECUTE ON FUNCTION public.upgrade_recurring_todo(uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.upgrade_recurring_todo(uuid, uuid, uuid) FROM authenticated;
