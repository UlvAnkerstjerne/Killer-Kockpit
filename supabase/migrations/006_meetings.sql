-- Killer Kockpit — Milestone 3: Meetings & Approved Minutes
--
-- Schema changes:
--   1. Extend meetings: owner_user_id, project_id, context, working_notes, status CHECK
--   2. Fix meeting_attendees: surrogate PK, nullable user_id, external-attendee check
--   3. Add meeting_id FK to tasks and waiting_ons
--   4. New meeting_outcomes table
--
-- RLS:
--   Replace "SUPER_ADMIN only" on meetings, meeting_attendees, agenda_items,
--   meeting_minutes with proper role-based policies.
--   meeting_outcomes gets its own read-all / write-blocked policy.
--
-- Stored procedures (SECURITY DEFINER, restricted to service_role):
--   Meeting lifecycle:  create_meeting_and_audit
--                       update_meeting_and_audit
--                       open_meeting_and_audit
--                       close_meeting_and_audit
--                       cancel_meeting_and_audit
--                       publish_meeting_and_audit  (atomic: creates all entities + audits)
--   Agenda:             create_agenda_item_and_audit
--                       update_agenda_item_and_audit
--                       reorder_agenda_items
--   Outcomes:           create_meeting_outcome_and_audit
--                       update_meeting_outcome_and_audit
--                       remove_meeting_outcome_and_audit
--   Attendees:          add_meeting_attendee
--                       remove_meeting_attendee

-- ---------------------------------------------------------------------------
-- 1. Extend meetings
-- ---------------------------------------------------------------------------

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS owner_user_id  uuid REFERENCES app_users(id),
  ADD COLUMN IF NOT EXISTS project_id     uuid REFERENCES projects(id),
  ADD COLUMN IF NOT EXISTS context        text,
  ADD COLUMN IF NOT EXISTS working_notes  text;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('scheduled', 'open', 'draft', 'published', 'cancelled'));

-- ---------------------------------------------------------------------------
-- 2. Fix meeting_attendees: surrogate PK + nullable user_id
-- ---------------------------------------------------------------------------

-- Add surrogate id column (populated for existing rows)
ALTER TABLE meeting_attendees ADD COLUMN id uuid;
UPDATE meeting_attendees SET id = gen_random_uuid();
ALTER TABLE meeting_attendees ALTER COLUMN id SET NOT NULL;
ALTER TABLE meeting_attendees ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Replace composite PK with surrogate PK
ALTER TABLE meeting_attendees DROP CONSTRAINT meeting_attendees_pkey;
ALTER TABLE meeting_attendees ADD PRIMARY KEY (id);

-- Allow external attendees (user_id = NULL, external_name required)
ALTER TABLE meeting_attendees ALTER COLUMN user_id DROP NOT NULL;

-- Partial unique index: one row per internal user per meeting
CREATE UNIQUE INDEX IF NOT EXISTS meeting_attendees_internal_uniq
  ON meeting_attendees(meeting_id, user_id)
  WHERE user_id IS NOT NULL;

-- At least one of user_id or external_name must be set
ALTER TABLE meeting_attendees
  ADD CONSTRAINT meeting_attendees_attendee_check
  CHECK (user_id IS NOT NULL OR external_name IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. Add meeting_id to tasks and waiting_ons
-- ---------------------------------------------------------------------------

ALTER TABLE tasks       ADD COLUMN IF NOT EXISTS meeting_id uuid REFERENCES meetings(id);
ALTER TABLE waiting_ons ADD COLUMN IF NOT EXISTS meeting_id uuid REFERENCES meetings(id);

-- ---------------------------------------------------------------------------
-- 4. meeting_outcomes
-- ---------------------------------------------------------------------------

CREATE TABLE meeting_outcomes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid        NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind                text        NOT NULL CHECK (kind IN ('task', 'waiting_on', 'decision')),
  title               text        NOT NULL,
  payload_json        jsonb       NOT NULL DEFAULT '{}',
  status              text        NOT NULL DEFAULT 'proposed'
                                  CHECK (status IN ('proposed', 'published', 'removed')),
  proposed_by_user_id uuid        REFERENCES app_users(id),
  published_entity_id uuid,
  sort_order          integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meeting_outcomes_meeting_idx ON meeting_outcomes(meeting_id, sort_order);

CREATE TRIGGER meeting_outcomes_updated_at
  BEFORE UPDATE ON meeting_outcomes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- RLS — meetings
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "meetings: SUPER_ADMIN only" ON meetings;

-- Management sees all meetings
CREATE POLICY "meetings: management can read all"
  ON meetings FOR SELECT TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- MEMBER sees meetings they own or attend
CREATE POLICY "meetings: member can read attended"
  ON meetings FOR SELECT TO authenticated
  USING (
    get_my_role() = 'MEMBER'
    AND (
      owner_user_id = get_my_app_user_id()
      OR id IN (
        SELECT meeting_id FROM meeting_attendees
        WHERE user_id = get_my_app_user_id()
      )
    )
  );

-- No direct writes — all mutations go through service_role RPCs
CREATE POLICY "meetings: no direct insert"
  ON meetings FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY "meetings: no direct update"
  ON meetings FOR UPDATE TO authenticated USING (false);

-- ---------------------------------------------------------------------------
-- RLS — meeting_attendees
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "meeting_attendees: SUPER_ADMIN only" ON meeting_attendees;

-- All authenticated can read attendee lists
CREATE POLICY "meeting_attendees: authenticated can read"
  ON meeting_attendees FOR SELECT TO authenticated
  USING (get_my_app_user_id() IS NOT NULL);

CREATE POLICY "meeting_attendees: no direct insert"
  ON meeting_attendees FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY "meeting_attendees: no direct delete"
  ON meeting_attendees FOR DELETE TO authenticated USING (false);

-- ---------------------------------------------------------------------------
-- RLS — agenda_items
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "agenda_items: SUPER_ADMIN only" ON agenda_items;

CREATE POLICY "agenda_items: authenticated can read"
  ON agenda_items FOR SELECT TO authenticated
  USING (get_my_app_user_id() IS NOT NULL);

CREATE POLICY "agenda_items: no direct insert"
  ON agenda_items FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY "agenda_items: no direct update"
  ON agenda_items FOR UPDATE TO authenticated USING (false);

CREATE POLICY "agenda_items: no direct delete"
  ON agenda_items FOR DELETE TO authenticated USING (false);

-- ---------------------------------------------------------------------------
-- RLS — meeting_minutes
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "meeting_minutes: SUPER_ADMIN only" ON meeting_minutes;

CREATE POLICY "meeting_minutes: management can read"
  ON meeting_minutes FOR SELECT TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

CREATE POLICY "meeting_minutes: no direct insert"
  ON meeting_minutes FOR INSERT TO authenticated WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- RLS — meeting_outcomes
-- ---------------------------------------------------------------------------

ALTER TABLE meeting_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "meeting_outcomes: authenticated can read"
  ON meeting_outcomes FOR SELECT TO authenticated
  USING (get_my_app_user_id() IS NOT NULL);

CREATE POLICY "meeting_outcomes: no direct insert"
  ON meeting_outcomes FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY "meeting_outcomes: no direct update"
  ON meeting_outcomes FOR UPDATE TO authenticated USING (false);

CREATE POLICY "meeting_outcomes: no direct delete"
  ON meeting_outcomes FOR DELETE TO authenticated USING (false);

-- ---------------------------------------------------------------------------
-- create_meeting_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_meeting_and_audit(
  p_title              text,
  p_owner_user_id      uuid,
  p_project_id         uuid,
  p_scheduled_start    timestamptz,
  p_scheduled_end      timestamptz,
  p_context            text,
  p_created_by_user_id uuid,
  p_actor_user_id      uuid
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO meetings (
    title, owner_user_id, project_id, scheduled_start, scheduled_end,
    context, created_by_user_id, status
  ) VALUES (
    p_title, p_owner_user_id, p_project_id, p_scheduled_start, p_scheduled_end,
    p_context, p_created_by_user_id, 'scheduled'
  )
  RETURNING id INTO v_id;

  -- Auto-add the creator as an attendee
  INSERT INTO meeting_attendees (meeting_id, user_id)
  VALUES (v_id, p_created_by_user_id)
  ON CONFLICT DO NOTHING;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.created', 'meeting', v_id,
    jsonb_build_object('title', p_title, 'status', 'scheduled')
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_meeting_and_audit(text, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_meeting_and_audit(text, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- update_meeting_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_meeting_and_audit(
  p_meeting_id    uuid,
  p_actor_user_id uuid,
  p_patch         jsonb,
  p_before        jsonb
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_field text;
BEGIN
  UPDATE meetings SET
    title           = CASE WHEN p_patch ? 'title'            THEN  p_patch->>'title'                             ELSE title            END,
    context         = CASE WHEN p_patch ? 'context'          THEN  p_patch->>'context'                           ELSE context          END,
    working_notes   = CASE WHEN p_patch ? 'working_notes'    THEN  p_patch->>'working_notes'                     ELSE working_notes    END,
    owner_user_id   = CASE WHEN p_patch ? 'owner_user_id'    THEN (p_patch->>'owner_user_id')::uuid               ELSE owner_user_id    END,
    project_id      = CASE WHEN p_patch ? 'project_id'       THEN (p_patch->>'project_id')::uuid                 ELSE project_id       END,
    scheduled_start = CASE WHEN p_patch ? 'scheduled_start'  THEN (p_patch->>'scheduled_start')::timestamptz     ELSE scheduled_start  END,
    scheduled_end   = CASE WHEN p_patch ? 'scheduled_end'    THEN (p_patch->>'scheduled_end')::timestamptz       ELSE scheduled_end    END
  WHERE id = p_meeting_id;

  FOR v_field IN SELECT jsonb_object_keys(p_patch)
  LOOP
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      p_actor_user_id, 'human',
      'meeting.' || v_field || '.changed',
      'meeting', p_meeting_id,
      jsonb_build_object(v_field, p_before->v_field),
      jsonb_build_object(v_field, p_patch->v_field)
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION update_meeting_and_audit(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_meeting_and_audit(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- open_meeting_and_audit  (scheduled → open)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION open_meeting_and_audit(
  p_meeting_id    uuid,
  p_actor_user_id uuid,
  p_actual_start  timestamptz
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meetings
  SET status = 'open', actual_start = COALESCE(p_actual_start, now())
  WHERE id = p_meeting_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.opened', 'meeting', p_meeting_id,
    jsonb_build_object('status', 'scheduled'),
    jsonb_build_object('status', 'open')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION open_meeting_and_audit(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION open_meeting_and_audit(uuid, uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- close_meeting_and_audit  (open → draft)
-- Working notes are locked (no further edits) once closed to draft.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION close_meeting_and_audit(
  p_meeting_id    uuid,
  p_actor_user_id uuid,
  p_actual_end    timestamptz
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meetings
  SET status = 'draft', actual_end = COALESCE(p_actual_end, now())
  WHERE id = p_meeting_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.closed_to_draft', 'meeting', p_meeting_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'draft')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION close_meeting_and_audit(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION close_meeting_and_audit(uuid, uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- cancel_meeting_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cancel_meeting_and_audit(
  p_meeting_id    uuid,
  p_actor_user_id uuid,
  p_before_status text
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meetings SET status = 'cancelled' WHERE id = p_meeting_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.cancelled', 'meeting', p_meeting_id,
    jsonb_build_object('status', p_before_status),
    jsonb_build_object('status', 'cancelled')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION cancel_meeting_and_audit(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION cancel_meeting_and_audit(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- publish_meeting_and_audit
--
-- Atomically:
--   1. Verifies meeting is in 'draft' status
--   2. For each 'proposed' outcome: creates the real entity (task/waiting_on/decision)
--      with meeting_id set for provenance, marks outcome as 'published'
--   3. Sets meeting status = 'published', minutes_status = 'published'
--   4. Inserts audit events for the meeting + all created entities
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION publish_meeting_and_audit(
  p_meeting_id    uuid,
  p_actor_user_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_outcome       RECORD;
  v_entity_id     uuid;
  v_entity_count  integer := 0;
BEGIN
  -- Lock and verify status
  PERFORM 1 FROM meetings WHERE id = p_meeting_id AND status = 'draft' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meeting % is not in draft status', p_meeting_id;
  END IF;

  -- Process proposed outcomes in order
  FOR v_outcome IN
    SELECT * FROM meeting_outcomes
    WHERE meeting_id = p_meeting_id AND status = 'proposed'
    ORDER BY sort_order, created_at
  LOOP
    v_entity_id := NULL;

    IF v_outcome.kind = 'task' THEN
      INSERT INTO tasks (
        title, owner_user_id, project_id, priority,
        due_at, description, meeting_id, created_by_user_id, status
      ) VALUES (
        v_outcome.title,
        (v_outcome.payload_json->>'owner_user_id')::uuid,
        (v_outcome.payload_json->>'project_id')::uuid,
        COALESCE((v_outcome.payload_json->>'priority')::smallint, 2),
        (v_outcome.payload_json->>'due_at')::timestamptz,
        v_outcome.payload_json->>'description',
        p_meeting_id,
        p_actor_user_id,
        'open'
      ) RETURNING id INTO v_entity_id;

      INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
      VALUES (p_actor_user_id, 'human', 'task.created', 'task', v_entity_id,
        jsonb_build_object('title', v_outcome.title, 'status', 'open',
                           'via_meeting', p_meeting_id));

    ELSIF v_outcome.kind = 'waiting_on' THEN
      INSERT INTO waiting_ons (
        title, owner_user_id, waiting_for_user_id, waiting_for_name,
        project_id, due_at, notes, meeting_id, status
      ) VALUES (
        v_outcome.title,
        (v_outcome.payload_json->>'owner_user_id')::uuid,
        (v_outcome.payload_json->>'waiting_for_user_id')::uuid,
        v_outcome.payload_json->>'waiting_for_name',
        (v_outcome.payload_json->>'project_id')::uuid,
        (v_outcome.payload_json->>'due_at')::timestamptz,
        v_outcome.payload_json->>'notes',
        p_meeting_id,
        'open'
      ) RETURNING id INTO v_entity_id;

      INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
      VALUES (p_actor_user_id, 'human', 'waiting_on.created', 'waiting_on', v_entity_id,
        jsonb_build_object('title', v_outcome.title, 'status', 'open',
                           'via_meeting', p_meeting_id));

    ELSIF v_outcome.kind = 'decision' THEN
      INSERT INTO decisions (
        title, decision_text, rationale, owner_user_id,
        project_id, decided_at, meeting_id, status
      ) VALUES (
        v_outcome.title,
        COALESCE(v_outcome.payload_json->>'decision_text', ''),
        v_outcome.payload_json->>'rationale',
        (v_outcome.payload_json->>'owner_user_id')::uuid,
        (v_outcome.payload_json->>'project_id')::uuid,
        COALESCE((v_outcome.payload_json->>'decided_at')::timestamptz, now()),
        p_meeting_id,
        COALESCE(
          (v_outcome.payload_json->>'status')::decision_status,
          'approved'
        )
      ) RETURNING id INTO v_entity_id;

      INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
      VALUES (p_actor_user_id, 'human', 'decision.created', 'decision', v_entity_id,
        jsonb_build_object('title', v_outcome.title, 'via_meeting', p_meeting_id));
    END IF;

    -- Mark outcome as published
    UPDATE meeting_outcomes
    SET status = 'published', published_entity_id = v_entity_id
    WHERE id = v_outcome.id;

    v_entity_count := v_entity_count + 1;
  END LOOP;

  -- Mark meeting as published
  UPDATE meetings
  SET status = 'published', minutes_status = 'published'
  WHERE id = p_meeting_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.published', 'meeting', p_meeting_id,
    jsonb_build_object('status', 'published', 'entities_created', v_entity_count)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION publish_meeting_and_audit(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION publish_meeting_and_audit(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- create_agenda_item_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_agenda_item_and_audit(
  p_meeting_id          uuid,
  p_title               text,
  p_description         text,
  p_sort_order          integer,
  p_related_entity_type text,
  p_related_entity_id   uuid,
  p_actor_user_id       uuid
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO agenda_items (
    meeting_id, title, description, sort_order,
    related_entity_type, related_entity_id, status
  ) VALUES (
    p_meeting_id, p_title, p_description,
    COALESCE(p_sort_order, 0),
    p_related_entity_type, p_related_entity_id, 'open'
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'agenda_item.created', 'agenda_item', v_id,
    jsonb_build_object('title', p_title, 'meeting_id', p_meeting_id)
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_agenda_item_and_audit(uuid, text, text, integer, text, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_agenda_item_and_audit(uuid, text, text, integer, text, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- update_agenda_item_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_agenda_item_and_audit(
  p_agenda_item_id uuid,
  p_actor_user_id  uuid,
  p_patch          jsonb,
  p_before         jsonb
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_field text;
BEGIN
  UPDATE agenda_items SET
    title       = CASE WHEN p_patch ? 'title'       THEN p_patch->>'title'       ELSE title       END,
    description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
    status      = CASE WHEN p_patch ? 'status'      THEN p_patch->>'status'      ELSE status      END,
    sort_order  = CASE WHEN p_patch ? 'sort_order'  THEN (p_patch->>'sort_order')::integer ELSE sort_order END
  WHERE id = p_agenda_item_id;

  FOR v_field IN SELECT jsonb_object_keys(p_patch)
  LOOP
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      p_actor_user_id, 'human',
      'agenda_item.' || v_field || '.changed',
      'agenda_item', p_agenda_item_id,
      jsonb_build_object(v_field, p_before->v_field),
      jsonb_build_object(v_field, p_patch->v_field)
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION update_agenda_item_and_audit(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_agenda_item_and_audit(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- reorder_agenda_items
-- p_order: [{id: uuid, sort_order: int}, ...]
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reorder_agenda_items(
  p_meeting_id    uuid,
  p_order         jsonb,
  p_actor_user_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_item jsonb;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_order)
  LOOP
    UPDATE agenda_items
    SET sort_order = (v_item->>'sort_order')::integer
    WHERE id = (v_item->>'id')::uuid
      AND meeting_id = p_meeting_id;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION reorder_agenda_items(uuid, jsonb, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reorder_agenda_items(uuid, jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- create_meeting_outcome_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_meeting_outcome_and_audit(
  p_meeting_id         uuid,
  p_kind               text,
  p_title              text,
  p_payload_json       jsonb,
  p_sort_order         integer,
  p_proposed_by_user_id uuid,
  p_actor_user_id      uuid
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO meeting_outcomes (
    meeting_id, kind, title, payload_json, sort_order,
    proposed_by_user_id, status
  ) VALUES (
    p_meeting_id, p_kind, p_title,
    COALESCE(p_payload_json, '{}'),
    COALESCE(p_sort_order, 0),
    p_proposed_by_user_id, 'proposed'
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting_outcome.created', 'meeting_outcome', v_id,
    jsonb_build_object('kind', p_kind, 'title', p_title, 'meeting_id', p_meeting_id)
  );

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION create_meeting_outcome_and_audit(uuid, text, text, jsonb, integer, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION create_meeting_outcome_and_audit(uuid, text, text, jsonb, integer, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- update_meeting_outcome_and_audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_meeting_outcome_and_audit(
  p_outcome_id    uuid,
  p_actor_user_id uuid,
  p_patch         jsonb,
  p_before        jsonb
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_field text;
BEGIN
  UPDATE meeting_outcomes SET
    title        = CASE WHEN p_patch ? 'title'        THEN p_patch->>'title'                    ELSE title        END,
    payload_json = CASE WHEN p_patch ? 'payload_json' THEN (p_patch->>'payload_json')::jsonb     ELSE payload_json END,
    sort_order   = CASE WHEN p_patch ? 'sort_order'   THEN (p_patch->>'sort_order')::integer     ELSE sort_order   END
  WHERE id = p_outcome_id;

  FOR v_field IN SELECT jsonb_object_keys(p_patch)
  LOOP
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      p_actor_user_id, 'human',
      'meeting_outcome.' || v_field || '.changed',
      'meeting_outcome', p_outcome_id,
      jsonb_build_object(v_field, p_before->v_field),
      jsonb_build_object(v_field, p_patch->v_field)
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION update_meeting_outcome_and_audit(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION update_meeting_outcome_and_audit(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- remove_meeting_outcome_and_audit  (sets status = 'removed', never hard-deletes)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION remove_meeting_outcome_and_audit(
  p_outcome_id    uuid,
  p_actor_user_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meeting_outcomes SET status = 'removed' WHERE id = p_outcome_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting_outcome.removed', 'meeting_outcome', p_outcome_id,
    jsonb_build_object('status', 'removed')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION remove_meeting_outcome_and_audit(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION remove_meeting_outcome_and_audit(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- add_meeting_attendee
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION add_meeting_attendee(
  p_meeting_id    uuid,
  p_user_id       uuid,
  p_external_name  text,
  p_external_email text,
  p_actor_user_id uuid
)
RETURNS uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO meeting_attendees (meeting_id, user_id, external_name, external_email)
  VALUES (p_meeting_id, p_user_id, p_external_name, p_external_email)
  ON CONFLICT ON CONSTRAINT meeting_attendees_internal_uniq DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
    VALUES (
      p_actor_user_id, 'human', 'meeting.attendee_added', 'meeting', p_meeting_id,
      jsonb_build_object(
        'user_id', p_user_id,
        'external_name', p_external_name
      )
    );
  END IF;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION add_meeting_attendee(uuid, uuid, text, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION add_meeting_attendee(uuid, uuid, text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- remove_meeting_attendee
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION remove_meeting_attendee(
  p_attendee_id   uuid,
  p_meeting_id    uuid,
  p_actor_user_id uuid
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM meeting_attendees WHERE id = p_attendee_id AND meeting_id = p_meeting_id;

  INSERT INTO audit_events (actor_user_id, actor_type, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id, 'human', 'meeting.attendee_removed', 'meeting', p_meeting_id,
    jsonb_build_object('attendee_id', p_attendee_id)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION remove_meeting_attendee(uuid, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION remove_meeting_attendee(uuid, uuid, uuid) TO service_role;
