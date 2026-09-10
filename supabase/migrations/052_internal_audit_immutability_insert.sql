-- 052_internal_audit_immutability_insert.sql
--
-- Fix: audit_section_comments and audit_top_actions immutability guards
-- only fired on UPDATE/DELETE, not INSERT. A new row could be inserted
-- into a submitted submission without being blocked.
--
-- Fix: update guard functions to use COALESCE(NEW, OLD).submission_id so
-- the same function handles INSERT (OLD is NULL) and UPDATE/DELETE.
-- Then re-create triggers to include INSERT.

CREATE OR REPLACE FUNCTION _audit_section_comments_guard_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_submission_id uuid;
  v_status        audit_submission_status;
BEGIN
  v_submission_id := COALESCE(NEW.submission_id, OLD.submission_id);
  SELECT status INTO v_status FROM audit_submissions WHERE id = v_submission_id;
  IF v_status = 'submitted' THEN
    RAISE EXCEPTION 'audit_section_comments: submitted audit records are immutable (submission id: %)', v_submission_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION _audit_top_actions_guard_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_submission_id uuid;
  v_status        audit_submission_status;
BEGIN
  v_submission_id := COALESCE(NEW.submission_id, OLD.submission_id);
  SELECT status INTO v_status FROM audit_submissions WHERE id = v_submission_id;
  IF v_status = 'submitted' THEN
    RAISE EXCEPTION 'audit_top_actions: submitted audit records are immutable (submission id: %)', v_submission_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Re-create triggers to include INSERT
DROP TRIGGER IF EXISTS audit_section_comments_guard_immutable ON audit_section_comments;
CREATE TRIGGER audit_section_comments_guard_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON audit_section_comments
  FOR EACH ROW EXECUTE FUNCTION _audit_section_comments_guard_immutable();

DROP TRIGGER IF EXISTS audit_top_actions_guard_immutable ON audit_top_actions;
CREATE TRIGGER audit_top_actions_guard_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON audit_top_actions
  FOR EACH ROW EXECUTE FUNCTION _audit_top_actions_guard_immutable();
