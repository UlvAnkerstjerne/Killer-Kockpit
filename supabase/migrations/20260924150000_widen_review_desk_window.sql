-- Widen the Review Desk queue to include ALL unanswered reviews, not just
-- those from the last 7 days. The existing_reply_text IS NULL filter and
-- pagination (LIMIT 26) already bound the result set safely.
-- Also sort newest-first so the most recent unanswered reviews appear first.
CREATE OR REPLACE FUNCTION public.get_gbp_review_desk(
  p_user_id uuid, p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_state gbp_review_session_state;
  v_rows jsonb;
BEGIN
  INSERT INTO gbp_review_session_state (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v_state FROM gbp_review_session_state WHERE user_id = p_user_id;
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.review_created_at DESC, q.id), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT r.id, l.store_short_name, r.reviewer_name, r.star_rating, r.review_text, r.review_created_at,
      rr.id AS reply_id, rr.draft_text, rr.approved_text, coalesce(rr.status, 'new') AS status,
      rr.publish_error, rr.publish_started_at,
      (v_state.last_completed_at IS NULL OR r.review_created_at > v_state.last_completed_at
        OR r.created_at > v_state.last_completed_at) AS new_since_session
    FROM gbp_reviews r JOIN gbp_locations l ON l.id = r.location_id
    LEFT JOIN gbp_review_replies rr ON rr.review_id = r.id
    WHERE r.existing_reply_text IS NULL
      AND coalesce(rr.status, 'new') NOT IN ('published', 'externally_published')
      AND l.active AND l.location_id IS NOT NULL
      AND (p_after_created_at IS NULL OR (r.review_created_at, r.id) < (p_after_created_at, p_after_id))
    ORDER BY r.review_created_at DESC, r.id LIMIT 26
  ) q;
  RETURN jsonb_build_object('session', to_jsonb(v_state), 'reviews', v_rows);
END;
$$;
