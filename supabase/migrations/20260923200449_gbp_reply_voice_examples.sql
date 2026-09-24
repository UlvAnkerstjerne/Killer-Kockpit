-- Bounded style-example lookups filter one approver before ordering by recency.
CREATE INDEX gbp_review_replies_voice_examples_idx
  ON public.gbp_review_replies (approved_by_user_id, approved_at DESC, id DESC)
  WHERE approved_by_user_id IS NOT NULL AND status IN ('approved', 'published');
