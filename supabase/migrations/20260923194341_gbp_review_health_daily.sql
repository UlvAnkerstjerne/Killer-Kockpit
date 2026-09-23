-- Review health is captured only after a successful review sync. No live Google
-- calls or review-history transfers are needed to display the six store cards.
CREATE TABLE public.gbp_review_health_daily (
  location_id uuid NOT NULL REFERENCES public.gbp_locations(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  captured_at timestamptz NOT NULL,
  average_rating numeric CHECK (average_rating BETWEEN 1 AND 5),
  total_review_count bigint CHECK (total_review_count >= 0),
  new_reviews_7d bigint NOT NULL CHECK (new_reviews_7d >= 0),
  unanswered_count bigint NOT NULL CHECK (unanswered_count >= 0),
  PRIMARY KEY (location_id, snapshot_date)
);
COMMENT ON COLUMN public.gbp_review_health_daily.average_rating IS
  'Unrounded Google averageRating; null if unavailable. Not a locally computed average.';
COMMENT ON COLUMN public.gbp_review_health_daily.new_reviews_7d IS
  'Reviews received today and the previous six calendar days in Europe/Copenhagen, through captured_at.';
ALTER TABLE public.gbp_review_health_daily ENABLE ROW LEVEL SECURITY;
-- Matches existing GBP tables: authenticated server actions authorize readers;
-- no client-facing policies or direct browser access.
REVOKE ALL ON public.gbp_review_health_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gbp_review_health_daily TO service_role;

CREATE FUNCTION public.capture_gbp_review_health(
  p_location_id uuid, p_average_rating numeric, p_total_review_count bigint,
  p_captured_at timestamptz DEFAULT now()
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_day date := (p_captured_at AT TIME ZONE 'Europe/Copenhagen')::date;
  v_recent bigint;
  v_unanswered bigint;
BEGIN
  -- Shared with confirmed publication, so today's count cannot race a reply.
  PERFORM 1 FROM gbp_locations WHERE id = p_location_id FOR UPDATE;
  SELECT count(*) FILTER (WHERE r.review_created_at >=
      ((v_day - 6)::timestamp AT TIME ZONE 'Europe/Copenhagen')
      AND r.review_created_at <= p_captured_at),
    count(*) FILTER (WHERE nullif(btrim(r.existing_reply_text), '') IS NULL
      AND NOT EXISTS (SELECT 1 FROM gbp_review_replies rr
        WHERE rr.review_id = r.id AND rr.status IN ('published', 'externally_published')))
  INTO v_recent, v_unanswered
  FROM gbp_reviews r WHERE r.location_id = p_location_id;

  INSERT INTO gbp_review_health_daily AS previous
    (location_id, snapshot_date, captured_at, average_rating, total_review_count, new_reviews_7d, unanswered_count)
  VALUES (p_location_id, v_day, p_captured_at, p_average_rating, p_total_review_count, v_recent, v_unanswered)
  ON CONFLICT (location_id, snapshot_date) DO UPDATE SET
    captured_at = excluded.captured_at,
    average_rating = coalesce(excluded.average_rating, previous.average_rating),
    total_review_count = coalesce(excluded.total_review_count, previous.total_review_count),
    new_reviews_7d = excluded.new_reviews_7d,
    unanswered_count = excluded.unanswered_count
  WHERE excluded.captured_at >= previous.captured_at;
END;
$$;
REVOKE ALL ON FUNCTION public.capture_gbp_review_health(uuid, numeric, bigint, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_gbp_review_health(uuid, numeric, bigint, timestamptz) TO service_role;
