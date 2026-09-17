-- Reuse institutional GBP entities; canonical locations remain authoritative.
ALTER TABLE public.gbp_locations
  ADD COLUMN resource_name text,
  ADD COLUMN profile_title text,
  ADD COLUMN store_code text,
  ADD COLUMN primary_category jsonb,
  ADD COLUMN additional_categories jsonb,
  ADD COLUMN website_uri text,
  ADD COLUMN phone_numbers jsonb,
  ADD COLUMN storefront_address jsonb,
  ADD COLUMN regular_hours jsonb,
  ADD COLUMN special_hours jsonb,
  ADD COLUMN more_hours jsonb,
  ADD COLUMN open_info jsonb,
  ADD COLUMN profile_metadata jsonb,
  ADD COLUMN profile_description jsonb,
  ADD COLUMN service_area jsonb,
  ADD COLUMN latlng jsonb,
  ADD COLUMN profile_snapshot jsonb,
  ADD COLUMN profile_synced_at timestamptz;
COMMENT ON COLUMN public.gbp_locations.location_id IS 'Persistent mapping to canonical Kockpit store. Never inferred from a profile name during sync.';
COMMENT ON COLUMN public.gbp_locations.profile_snapshot IS 'External Google Business Information representation, not canonical store data. No credentials.';

-- Existing seven compatibility columns retained for current Marketing/Brain reads.
-- JSON uses exact Google metric identifiers and decimal strings (int64 precision).
ALTER TABLE public.gbp_location_metrics
  ADD COLUMN metric_values jsonb,
  ADD COLUMN metric_breakdowns jsonb,
  ALTER COLUMN impressions_desktop_maps TYPE bigint,
  ALTER COLUMN impressions_desktop_search TYPE bigint,
  ALTER COLUMN impressions_mobile_maps TYPE bigint,
  ALTER COLUMN impressions_mobile_search TYPE bigint,
  ALTER COLUMN total_impressions TYPE bigint,
  ALTER COLUMN website_clicks TYPE bigint,
  ALTER COLUMN call_clicks TYPE bigint,
  ALTER COLUMN direction_requests TYPE bigint;
COMMENT ON COLUMN public.gbp_location_metrics.metric_values IS 'DailyMetric identifiers -> exact integer strings or null. Missing dated point/series is null; Google omits value on an actual zero-valued point.';

CREATE TABLE public.gbp_search_keywords_monthly (
  location_id uuid NOT NULL REFERENCES public.gbp_locations(id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  keyword text NOT NULL CHECK (length(keyword) > 0),
  impressions bigint CHECK (impressions >= 0),
  impressions_threshold bigint CHECK (impressions_threshold > 0),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, month, keyword),
  CHECK (impressions IS NULL OR impressions_threshold IS NULL)
);
CREATE INDEX gbp_search_keywords_month_idx ON public.gbp_search_keywords_monthly(month DESC);
ALTER TABLE public.gbp_search_keywords_monthly ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gbp_search_keywords_monthly FROM anon, authenticated;
GRANT ALL ON public.gbp_search_keywords_monthly TO service_role;
COMMENT ON COLUMN public.gbp_search_keywords_monthly.impressions_threshold IS 'Google reported actual impressions below this threshold; never treat the threshold as an exact count.';

-- Replace one fully fetched month atomically: corrected/removed queries cannot linger.
-- Called only after every Google page succeeds. Failure rolls back the whole month.
CREATE FUNCTION public.replace_gbp_keyword_month(p_location_id uuid, p_month date, p_rows jsonb, p_synced_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE affected integer;
BEGIN
  IF p_month IS NULL OR p_synced_at IS NULL OR p_rows IS NULL OR extract(day FROM p_month) <> 1 OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Invalid GBP keyword month snapshot';
  END IF;
  -- Serializes replacement of the same location even if called outside the orchestrator.
  PERFORM id FROM public.gbp_locations WHERE id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GBP location does not exist'; END IF;
  INSERT INTO public.gbp_search_keywords_monthly(location_id, month, keyword, impressions, impressions_threshold, synced_at)
  SELECT p_location_id, p_month, r.keyword, r.impressions, r.impressions_threshold, p_synced_at
  FROM jsonb_to_recordset(p_rows) AS r(keyword text, impressions bigint, impressions_threshold bigint)
  ON CONFLICT (location_id, month, keyword) DO UPDATE SET
    impressions = excluded.impressions, impressions_threshold = excluded.impressions_threshold, synced_at = excluded.synced_at;
  GET DIAGNOSTICS affected = ROW_COUNT;
  DELETE FROM public.gbp_search_keywords_monthly existing
  WHERE existing.location_id = p_location_id AND existing.month = p_month
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) item WHERE item->>'keyword' = existing.keyword);
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION public.replace_gbp_keyword_month(uuid, date, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_gbp_keyword_month(uuid, date, jsonb, timestamptz) TO service_role;

-- Adopt any pre-existing review checkpoint without binding future sync to its credential owner.
INSERT INTO public.integration_sync_state(integration, user_id, status, cursor, last_success_at, last_attempt_at, last_error)
SELECT DISTINCT ON (s.integration) s.integration, NULL, s.status, s.cursor, s.last_success_at, s.last_attempt_at, s.last_error
FROM public.integration_sync_state s
WHERE s.integration LIKE 'gbp_reviews:%' AND s.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.integration_sync_state i WHERE i.integration = s.integration AND i.user_id IS NULL)
ORDER BY s.integration, s.last_success_at DESC NULLS LAST;
