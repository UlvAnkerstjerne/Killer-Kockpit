-- 069_complete_recurring_todo_with_context.sql
--
-- Extends complete_recurring_todo to accept completion context and
-- completed_by_user_id as parameters, written atomically inside the
-- same transaction as the completion itself.
--
-- Previously these fields were written in a separate follow-up UPDATE
-- from the server action after the RPC returned. Moving them inside the
-- RPC means completion + context either both succeed or both fail.
--
-- The old 2-parameter overload is dropped so callers cannot accidentally
-- use it and leave the context fields unpopulated.

-- Drop the old 2-arg overload before redefining the function.
DROP FUNCTION IF EXISTS public.complete_recurring_todo(uuid, uuid);

CREATE OR REPLACE FUNCTION public.complete_recurring_todo(
  p_todo_id              uuid,
  p_actor_id             uuid,
  p_completion_context   text,
  p_completed_by_user_id uuid
)
RETURNS uuid          -- returns the new child todo's id; NULL if idempotent no-op
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_todo           public.todos%ROWTYPE;
  v_existing_child uuid;
  v_cph_today      date;
  v_next_date      date;
  v_new_id         uuid;
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

    RETURN v_existing_child; -- may be NULL if no child (edge case)
  END IF;

  -- -------------------------------------------------------------------------
  -- 5. Mark this occurrence as completed — context written here atomically.
  -- -------------------------------------------------------------------------
  UPDATE public.todos
  SET completed_at         = now(),
      updated_at           = now(),
      completion_context   = p_completion_context,
      completed_by_user_id = p_completed_by_user_id
  WHERE id = p_todo_id;

  -- -------------------------------------------------------------------------
  -- 6. Compute Copenhagen "today" for the catch-up loop.
  -- -------------------------------------------------------------------------
  v_cph_today := (now() AT TIME ZONE 'Europe/Copenhagen')::date;

  v_next_date := public.compute_next_todo_occurrence(
    v_todo.recurrence_rule,
    v_todo.recurrence_day,
    COALESCE(v_todo.scheduled_for, v_cph_today)
  );

  -- -------------------------------------------------------------------------
  -- 7. Catch-up loop: advance until strictly after today.
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
  --    Does NOT copy: completed_at, cancelled_at, completion_context.
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
REVOKE EXECUTE ON FUNCTION public.complete_recurring_todo(uuid, uuid, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_recurring_todo(uuid, uuid, text, uuid) FROM authenticated;
