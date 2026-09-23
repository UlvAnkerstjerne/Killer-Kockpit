-- Per-user activation is immutable. The watermark records completed sessions;
-- unresolved reviews within the activation era always remain in the queue.
CREATE TABLE public.gbp_review_session_state (
  user_id uuid PRIMARY KEY REFERENCES public.app_users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_completed_at IS NULL OR last_completed_at >= started_at)
);
ALTER TABLE public.gbp_review_session_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gbp_review_session_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gbp_review_session_state TO service_role;

-- A claim spans the Google write. Do not automatically replay an uncertain write.
-- A subsequent sync reconciles it against Google's actual reply first.
ALTER TABLE public.gbp_review_replies ADD COLUMN publish_attempt_id uuid;
ALTER TABLE public.gbp_review_replies ADD COLUMN publish_started_at timestamptz;
ALTER TABLE public.gbp_review_replies ADD CONSTRAINT gbp_publish_claim_pair
  CHECK ((publish_attempt_id IS NULL) = (publish_started_at IS NULL));
CREATE INDEX gbp_review_replies_pending_publish_idx ON public.gbp_review_replies(publish_started_at)
  WHERE publish_attempt_id IS NOT NULL;
CREATE INDEX gbp_reviews_desk_queue_idx ON public.gbp_reviews(review_created_at, id)
  WHERE existing_reply_text IS NULL;

CREATE FUNCTION public.get_gbp_review_desk(
  p_user_id uuid, p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_state gbp_review_session_state;
  v_rows jsonb;
BEGIN
  INSERT INTO gbp_review_session_state (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v_state FROM gbp_review_session_state WHERE user_id = p_user_id;
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.review_created_at, q.id), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT r.id, l.store_short_name, r.reviewer_name, r.star_rating, r.review_text, r.review_created_at,
      rr.id AS reply_id, rr.draft_text, rr.approved_text, coalesce(rr.status, 'new') AS status,
      rr.publish_error, rr.publish_started_at,
      (v_state.last_completed_at IS NULL OR r.review_created_at > v_state.last_completed_at
        OR r.created_at > v_state.last_completed_at) AS new_since_session
    FROM gbp_reviews r JOIN gbp_locations l ON l.id = r.location_id
    LEFT JOIN gbp_review_replies rr ON rr.review_id = r.id
    WHERE r.review_created_at >= v_state.started_at - interval '7 days'
      AND r.existing_reply_text IS NULL
      AND coalesce(rr.status, 'new') NOT IN ('published', 'externally_published')
      AND l.active AND l.location_id IS NOT NULL
      AND (p_after_created_at IS NULL OR (r.review_created_at, r.id) > (p_after_created_at, p_after_id))
    ORDER BY r.review_created_at, r.id LIMIT 26
  ) q;
  RETURN jsonb_build_object('session', to_jsonb(v_state), 'reviews', v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.get_gbp_review_desk(uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_gbp_review_desk(uuid, timestamptz, uuid) TO service_role;

-- One audited local approval/claim per reply before the external write. The
-- server supplies the authenticated actor; no identity is accepted from the UI.
CREATE FUNCTION public.claim_gbp_reply_publish(
  p_reply_id uuid, p_actor_id uuid, p_approved_text text, p_desk_only boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_reply gbp_review_replies;
  v_review gbp_reviews;
  v_location gbp_locations;
  v_attempt uuid := gen_random_uuid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_users u WHERE u.id = p_actor_id AND u.active AND
    (u.role = 'SUPER_ADMIN' OR (u.marketing_access AND EXISTS (
      SELECT 1 FROM user_marketing_permissions mp WHERE mp.user_id = u.id AND mp.permission = 'reviews_approve'))))
  THEN RAISE EXCEPTION 'reviews_approve permission required'; END IF;
  SELECT * INTO v_reply FROM gbp_review_replies WHERE id = p_reply_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reply not found'; END IF;
  SELECT * INTO STRICT v_review FROM gbp_reviews WHERE id = v_reply.review_id FOR UPDATE;
  SELECT * INTO STRICT v_location FROM gbp_locations WHERE id = v_review.location_id;
  IF v_review.existing_reply_text IS NOT NULL OR v_reply.status IN ('published','externally_published') THEN
    RETURN jsonb_build_object('status','already_published');
  END IF;
  IF v_reply.publish_attempt_id IS NOT NULL THEN RAISE EXCEPTION 'Publication pending confirmation; sync before retrying'; END IF;
  IF NOT v_location.active OR v_location.location_id IS NULL THEN RAISE EXCEPTION 'Location is not active and mapped'; END IF;
  IF v_review.google_review_id NOT LIKE 'accounts/' || v_location.google_account_id || '/locations/' || v_location.google_location_id || '/reviews/%'
    OR v_review.google_review_id !~ '^accounts/[0-9]+/locations/[0-9]+/reviews/[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'Invalid Google review identity'; END IF;
  IF p_desk_only AND NOT EXISTS (SELECT 1 FROM gbp_review_session_state s WHERE s.user_id = p_actor_id
    AND v_review.review_created_at >= s.started_at - interval '7 days') THEN
    RAISE EXCEPTION 'Review is outside this Review Desk session';
  END IF;
  IF v_reply.status NOT IN ('awaiting_review','approved','rejected','publish_failed') THEN RAISE EXCEPTION 'Reply is not ready for approval'; END IF;
  IF p_approved_text IS NULL OR length(btrim(p_approved_text)) = 0 OR char_length(btrim(p_approved_text)) > 4096 THEN
    RAISE EXCEPTION 'Reply must contain 1 to 4096 characters';
  END IF;
  -- Individual publishing must use the text already approved, unchanged.
  IF NOT p_desk_only AND (v_reply.status <> 'approved' OR p_approved_text IS DISTINCT FROM v_reply.approved_text) THEN
    RAISE EXCEPTION 'Can only publish the approved reply text';
  END IF;
  UPDATE gbp_review_replies SET status = 'approved', approved_text = btrim(p_approved_text),
    approved_by_user_id = CASE WHEN p_desk_only THEN p_actor_id ELSE approved_by_user_id END,
    approved_at = CASE WHEN p_desk_only THEN now() ELSE approved_at END,
    rejection_note = NULL, rejected_by_user_id = NULL, rejected_at = NULL, publish_error = NULL,
    publish_attempt_id = v_attempt, publish_started_at = now() WHERE id = p_reply_id;
  IF p_desk_only THEN
    INSERT INTO audit_events (actor_user_id,actor_type,action,entity_type,entity_id,after_json)
    VALUES (p_actor_id,'human','marketing.gbp_reply.approved','gbp_review_reply',p_reply_id,
      jsonb_build_object('approved_text',btrim(p_approved_text),'source','review_desk','attempt_id',v_attempt));
  END IF;
  RETURN jsonb_build_object('status','claimed','attempt_id',v_attempt,'review_id',v_review.id,
    'google_review_id',v_review.google_review_id,'approved_text',btrim(p_approved_text));
END;
$$;
REVOKE ALL ON FUNCTION public.claim_gbp_reply_publish(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_gbp_reply_publish(uuid, uuid, text, boolean) TO service_role;

-- Local completion is atomic and idempotent. No transaction spans Google writes.
CREATE FUNCTION public.finish_gbp_reply_publish(
  p_reply_id uuid, p_attempt_id uuid, p_actor_id uuid, p_error text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_reply gbp_review_replies;
  v_location uuid;
BEGIN
  SELECT r.location_id INTO STRICT v_location FROM gbp_reviews r
    JOIN gbp_review_replies rr ON rr.review_id = r.id WHERE rr.id = p_reply_id;
  -- Lock in the same order as snapshot capture.
  PERFORM 1 FROM gbp_locations WHERE id = v_location FOR UPDATE;
  SELECT * INTO STRICT v_reply FROM gbp_review_replies WHERE id = p_reply_id FOR UPDATE;
  IF v_reply.status IN ('published','externally_published') AND v_reply.publish_attempt_id IS NULL THEN RETURN; END IF;
  IF v_reply.publish_attempt_id IS DISTINCT FROM p_attempt_id THEN RAISE EXCEPTION 'Publication claim changed; reconcile with Google'; END IF;
  IF p_error IS NULL THEN
    UPDATE gbp_reviews SET existing_reply_text = v_reply.approved_text, existing_reply_updated_at = now() WHERE id = v_reply.review_id;
    UPDATE gbp_review_replies SET status = 'published', published_at = now(), publish_error = NULL,
      publish_attempt_id = NULL, publish_started_at = NULL WHERE id = p_reply_id;
    UPDATE gbp_review_health_daily SET unanswered_count = (
      SELECT count(*) FROM gbp_reviews r WHERE r.location_id = v_location
        AND nullif(btrim(r.existing_reply_text),'') IS NULL
        AND NOT EXISTS (SELECT 1 FROM gbp_review_replies rr WHERE rr.review_id = r.id AND rr.status IN ('published','externally_published'))
    ) WHERE location_id = v_location AND snapshot_date = (now() AT TIME ZONE 'Europe/Copenhagen')::date;
  ELSE
    UPDATE gbp_review_replies SET status = 'publish_failed', publish_error = left(p_error,1000),
      publish_attempt_id = NULL, publish_started_at = NULL WHERE id = p_reply_id;
  END IF;
  INSERT INTO audit_events (actor_user_id,actor_type,action,entity_type,entity_id,after_json)
  VALUES (p_actor_id,'human',CASE WHEN p_error IS NULL THEN 'marketing.gbp_reply.published' ELSE 'marketing.gbp_reply.publish_failed' END,
    'gbp_review_reply',p_reply_id,jsonb_build_object('attempt_id',p_attempt_id,'error',left(p_error,1000)));
END;
$$;
REVOKE ALL ON FUNCTION public.finish_gbp_reply_publish(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_gbp_reply_publish(uuid, uuid, uuid, text) TO service_role;
