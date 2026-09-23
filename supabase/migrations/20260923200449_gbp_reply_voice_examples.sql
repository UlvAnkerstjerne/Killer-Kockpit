-- Bounded style-example lookups use only recent, human-approved replies.
CREATE INDEX gbp_review_replies_voice_examples_idx
  ON public.gbp_review_replies (approved_at DESC, id DESC)
  WHERE approved_by_user_id IS NOT NULL AND status IN ('approved', 'published');
