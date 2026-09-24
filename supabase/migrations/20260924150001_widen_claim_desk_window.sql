-- Widen the desk-only session check to allow publishing replies to any
-- unanswered review, not just those from the last 7 days.
CREATE OR REPLACE FUNCTION public.claim_gbp_reply_publish(
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
  IF p_desk_only AND NOT EXISTS (SELECT 1 FROM gbp_review_session_state s WHERE s.user_id = p_actor_id) THEN
    RAISE EXCEPTION 'Review is outside this Review Desk session';
  END IF;
  IF v_reply.status NOT IN ('awaiting_review','approved','rejected','publish_failed') THEN RAISE EXCEPTION 'Reply is not ready for approval'; END IF;
  IF p_approved_text IS NULL OR length(btrim(p_approved_text)) = 0 OR char_length(btrim(p_approved_text)) > 4096 THEN
    RAISE EXCEPTION 'Reply must contain 1 to 4096 characters';
  END IF;
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
