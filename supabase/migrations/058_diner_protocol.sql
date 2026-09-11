-- 058_diner_protocol.sql
--
-- Mystery Diner checkpoint model + v1 protocol seed.
--
-- Changes:
--   1. diner_templates      — versioned protocol containers
--   2. diner_checkpoints    — typed, ordered checkpoints with Critical/conditional flags
--   3. Add template_id + score columns to diner_submissions
--   4. Add FK: diner_responses.checkpoint_id → diner_checkpoints.id
--   5. Replace submit_diner_submission() — now computes scores on submit
--   6. RLS for new tables (management read; service_role writes)
--   7. Seed Mystery Diner v1 (42 checkpoints, published)
--
-- Checkpoint types:
--   scored       — Acceptable / Unacceptable / Not assessed
--   gold_star    — Achieved / Not achieved / Not assessed; never counts in normal score
--   waiting_time — 5-band scale stored in notes; 20+ band = critical flag at submit
--   informational — free text only; not scored
--
-- Critical flag semantics:
--   is_critical on a 'scored' checkpoint → fail counts toward critical_fail_count
--   waiting_time = '20+' → adds 1 to critical_fail_count at submit time
--   Gold Stars are never critical
--
-- Score computation (in submit_diner_submission):
--   score_pct = (pass_count / answered_scored_count) * 100
--   Conditional checkpoints (11, 12) only count when waiting_time > 15 min;
--   this is enforced by the client (conditional checkpoints are hidden/not saved
--   when band ≤ 15 min) and honoured here by only counting responses actually
--   present in diner_responses.

-- ===========================================================================
-- 1. diner_templates
-- ===========================================================================

CREATE TABLE diner_templates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  version      integer     NOT NULL,
  title        text        NOT NULL,
  status       text        NOT NULL DEFAULT 'draft'
    CONSTRAINT diner_templates_status_check
    CHECK (status IN ('draft', 'published', 'retired')),
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- At most one published template at a time
CREATE UNIQUE INDEX diner_templates_one_published
  ON diner_templates (status) WHERE status = 'published';

-- ===========================================================================
-- 2. diner_checkpoints
-- ===========================================================================

CREATE TABLE diner_checkpoints (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id    uuid    NOT NULL REFERENCES diner_templates(id),
  section        text    NOT NULL,
  order_index    integer NOT NULL,
  label          text    NOT NULL,
  -- Full scoring criterion shown to the diner on the form
  description    text,
  -- Optional short diner-behaviour reminder (e.g. "Order one roll first")
  hint           text,
  type           text    NOT NULL
    CONSTRAINT diner_checkpoints_type_check
    CHECK (type IN ('scored', 'gold_star', 'waiting_time', 'informational')),
  is_critical    boolean NOT NULL DEFAULT false,
  -- Only visible and scored when actual waiting time > 15 min
  is_conditional boolean NOT NULL DEFAULT false,
  UNIQUE (template_id, order_index)
);

CREATE INDEX diner_checkpoints_template_order_idx
  ON diner_checkpoints (template_id, order_index);

-- ===========================================================================
-- 3. diner_submissions additions
-- ===========================================================================

-- Which template version this submission was taken against
ALTER TABLE diner_submissions
  ADD COLUMN template_id uuid REFERENCES diner_templates(id);

-- Scores computed and stored at submit time
ALTER TABLE diner_submissions
  ADD COLUMN score_pct           numeric(5,2),
  ADD COLUMN critical_fail_count integer,
  ADD COLUMN gold_star_count     integer,
  ADD COLUMN waiting_time_band   text;

-- ===========================================================================
-- 4. FK: diner_responses.checkpoint_id → diner_checkpoints
-- ===========================================================================

ALTER TABLE diner_responses
  ADD CONSTRAINT diner_responses_checkpoint_fk
  FOREIGN KEY (checkpoint_id) REFERENCES diner_checkpoints(id);

-- ===========================================================================
-- 5. submit_diner_submission — replace with score-computing version
-- ===========================================================================
--
-- Return type changes text → jsonb, so we drop + recreate.
-- Callable by service_role only (GRANT unchanged from 057).

DROP FUNCTION IF EXISTS submit_diner_submission(uuid, uuid);

CREATE FUNCTION submit_diner_submission(
  p_submission_id uuid,
  p_invitation_id uuid
)
RETURNS jsonb
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_status         text;
  v_scored_total   int     := 0;
  v_pass_count     int     := 0;
  v_critical_fails int     := 0;
  v_gold_stars     int     := 0;
  v_waiting_band   text;
  v_score_pct      numeric(5,2);
BEGIN
  -- Lock the row to serialise concurrent submits
  SELECT status INTO v_status
  FROM diner_submissions
  WHERE id = p_submission_id AND invitation_id = p_invitation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Submission not found or invitation mismatch';
  END IF;

  IF v_status = 'submitted' THEN
    RAISE EXCEPTION 'Already submitted';
  END IF;

  -- Compute scores from saved responses
  -- Only responses that are actually stored count (conditional checkpoints
  -- not shown/saved by the client for short waits are absent here).
  SELECT
    COUNT(*)      FILTER (WHERE cp.type = 'scored' AND dr.result IN ('pass', 'fail')),
    COUNT(*)      FILTER (WHERE cp.type = 'scored' AND dr.result = 'pass'),
    COUNT(*)      FILTER (WHERE cp.type = 'scored' AND cp.is_critical AND dr.result = 'fail'),
    COUNT(*)      FILTER (WHERE cp.type = 'gold_star' AND dr.result = 'pass'),
    MAX(dr.notes) FILTER (WHERE cp.type = 'waiting_time')
  INTO v_scored_total, v_pass_count, v_critical_fails, v_gold_stars, v_waiting_band
  FROM diner_responses dr
  JOIN diner_checkpoints cp ON cp.id = dr.checkpoint_id
  WHERE dr.submission_id = p_submission_id;

  -- 20+ minute wait is a critical flag
  IF v_waiting_band = '20+' THEN
    v_critical_fails := COALESCE(v_critical_fails, 0) + 1;
  END IF;

  -- Score as percentage of answered (non-NA) scored checkpoints
  IF COALESCE(v_scored_total, 0) > 0 THEN
    v_score_pct := ROUND(COALESCE(v_pass_count, 0)::numeric / v_scored_total * 100, 2);
  END IF;

  -- Persist result
  UPDATE diner_submissions
  SET status              = 'submitted',
      submitted_at        = now(),
      score_pct           = v_score_pct,
      critical_fail_count = COALESCE(v_critical_fails, 0),
      gold_star_count     = COALESCE(v_gold_stars, 0),
      waiting_time_band   = v_waiting_band
  WHERE id = p_submission_id;

  -- Sync invitation status
  UPDATE diner_invitations
  SET status     = 'submitted',
      updated_at = now()
  WHERE id = p_invitation_id;

  RETURN jsonb_build_object(
    'status',              'submitted',
    'score_pct',           v_score_pct,
    'critical_fail_count', COALESCE(v_critical_fails, 0),
    'gold_star_count',     COALESCE(v_gold_stars, 0),
    'waiting_time_band',   v_waiting_band
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION submit_diner_submission(uuid, uuid) TO service_role;

-- ===========================================================================
-- 6. RLS for new tables
-- ===========================================================================

ALTER TABLE diner_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE diner_checkpoints ENABLE ROW LEVEL SECURITY;

-- Management users can read templates and checkpoints (for result dashboards)
CREATE POLICY "diner_templates: management can read"
  ON diner_templates FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

CREATE POLICY "diner_checkpoints: management can read"
  ON diner_checkpoints FOR SELECT
  TO authenticated
  USING (get_my_role() IN ('SUPER_ADMIN', 'UM'));

-- Public/diner routes use service_role — no additional policies needed.

-- ===========================================================================
-- 7. Seed Mystery Diner v1 (42 checkpoints)
-- ===========================================================================
--
-- Critical checkpoints: 3, 4, 5, 19, 25, 28, 30, 32, 34, 36 (10 total)
-- Gold Stars:           13, 14, 15 (3 total)
-- Waiting time:         16 (20+ band = critical flag at submit)
-- Informational:        42 (Shazam track — free text, not scored)
-- Conditional (>15 min only): 11, 12

WITH tpl AS (
  INSERT INTO diner_templates (version, title, status, published_at)
  VALUES (1, 'Mystery Diner v1', 'published', now())
  RETURNING id
)
INSERT INTO diner_checkpoints (
  template_id, section, order_index, label, description, hint, type, is_critical, is_conditional
)
SELECT
  tpl.id,
  c.section,
  c.ord::int,
  c.label,
  c.description,
  c.hint,
  c.type,
  c.is_critical::boolean,
  c.is_conditional::boolean
FROM tpl,
(VALUES
  -- ── SERVICE ──────────────────────────────────────────────────────────────
  ('Service', '1',
   'Acknowledged within 5 seconds',
   'Staff greet or acknowledge the diner within 5 seconds when reasonably available. If actively taking an order, handing over food or otherwise directly serving another guest, acknowledgement should happen as soon as practical.',
   NULL,
   'scored', 'false', 'false'),

  ('Service', '2',
   'Have a good one!',
   'Staff say goodbye and thank guests as they leave when reasonably available. If actively serving another guest, this should not count as a fail.',
   NULL,
   'scored', 'false', 'false'),

  ('Service', '3',
   'Welcoming and friendly',
   'Staff are warm and pleasant during the interaction.',
   NULL,
   'scored', 'true', 'false'),

  ('Service', '4',
   'Engaged and attentive',
   'Staff appear focused on the guest and the work, rather than personal phones or unnecessary coworker conversation.',
   NULL,
   'scored', 'true', 'false'),

  -- ── SALES ────────────────────────────────────────────────────────────────
  ('Sales', '5',
   'Combo offered',
   'Staff offer the combo before the diner asks for it.',
   'Initially order ONE roll only. Give staff the opportunity to offer the combo. If they offer it, accept it. If they do not, add the combo yourself before completing the order.',
   'scored', 'true', 'false'),

  ('Sales', '6',
   'Lemonade offered',
   NULL,
   'Give staff an opportunity to offer lemonade.',
   'scored', 'false', 'false'),

  ('Sales', '7',
   'Product knowledge',
   'Staff demonstrate good product knowledge when asked a reasonable question about the menu.',
   'Ask one reasonable menu/product question.',
   'scored', 'false', 'false'),

  ('Sales', '8',
   'Falafel sample offered when appropriate',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  -- ── GUEST EXPERIENCE ─────────────────────────────────────────────────────
  ('Guest Experience', '9',
   'Felt seen',
   'Staff make the diner feel noticed and personally acknowledged during the visit.',
   NULL,
   'scored', 'false', 'false'),

  ('Guest Experience', '10',
   'Waiting time communicated',
   'Staff give an approximate waiting time at ordering.',
   NULL,
   'scored', 'false', 'false'),

  ('Guest Experience', '11',
   'Delay communicated',
   'Staff inform the diner that the order is taking longer than expected.',
   'Only assessed when actual wait exceeded 15 minutes.',
   'scored', 'false', 'true'),

  ('Guest Experience', '12',
   'Apology for the wait',
   'Staff acknowledge/apologise for the extended waiting time.',
   'Only assessed when actual wait exceeded 15 minutes.',
   'scored', 'false', 'true'),

  -- ── GOLD STARS ───────────────────────────────────────────────────────────
  ('Gold Stars', '13',
   'Have a seat!',
   'Food is brought to the diner''s table.',
   NULL,
   'gold_star', 'false', 'false'),

  ('Gold Stars', '14',
   'Pickup interaction',
   'Staff make a genuine verbal interaction at food handover rather than only calling the order or placing the food.',
   NULL,
   'gold_star', 'false', 'false'),

  ('Gold Stars', '15',
   'Asked for a review',
   'After the diner returns to the bar and thanks staff for the food, staff ask for a review.',
   'After eating, return to the bar and thank staff for the food. Do not mention reviews.',
   'gold_star', 'false', 'false'),

  -- ── OPERATIONS ───────────────────────────────────────────────────────────
  ('Operations', '16',
   'Waiting time',
   'Record how long it took from ordering to receiving your food. A wait of 20+ minutes is recorded as a critical flag.',
   NULL,
   'waiting_time', 'false', 'false'),

  ('Operations', '17',
   'Smooth service flow',
   'Ordering, preparation and handover feel organised without obvious confusion or bottlenecks.',
   NULL,
   'scored', 'false', 'false'),

  ('Operations', '18',
   'Drinks faced forward',
   'Bottles/cans in the fridge are neatly arranged with labels facing forward.',
   NULL,
   'scored', 'false', 'false'),

  -- ── RESTAURANT ───────────────────────────────────────────────────────────
  ('Restaurant', '19',
   'Restaurant appears clean overall',
   NULL,
   NULL,
   'scored', 'true', 'false'),

  ('Restaurant', '20',
   'Tables clean and ready for guests',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Restaurant', '21',
   'Floors clean and free from obvious dirt/waste',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Restaurant', '22',
   'Bar top clean, organised and free from clutter',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Restaurant', '23',
   'Restaurant mostly organised and orderly',
   'Tables and chairs are mostly neatly arranged and in their intended positions, allowing for normal guest turnover.',
   NULL,
   'scored', 'false', 'false'),

  ('Restaurant', '24',
   'Trash station clean and organised',
   'Trash station is reasonably clean, orderly and not visibly filthy or overflowing.',
   NULL,
   'scored', 'false', 'false'),

  -- ── TOILET ───────────────────────────────────────────────────────────────
  ('Toilet', '25',
   'Toilet generally clean',
   NULL,
   NULL,
   'scored', 'true', 'false'),

  ('Toilet', '26',
   'Trash can not overflowing',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Toilet', '27',
   'Floor free from toilet paper or obvious litter',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  -- ── STAFF ────────────────────────────────────────────────────────────────
  ('Staff', '28',
   'Correct Killer Kebab uniform',
   NULL,
   NULL,
   'scored', 'true', 'false'),

  ('Staff', '29',
   'Presentable appearance',
   'Staff look clean, presentable and ready for service.',
   NULL,
   'scored', 'false', 'false'),

  -- ── PRODUCT — ROLL ───────────────────────────────────────────────────────
  ('Product — Roll', '30',
   'Bread warm',
   NULL,
   NULL,
   'scored', 'true', 'false'),

  ('Product — Roll', '31',
   'Bread properly caramelised',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Product — Roll', '32',
   'Meat / falafel warm',
   NULL,
   NULL,
   'scored', 'true', 'false'),

  ('Product — Roll', '33',
   'Roll neatly wrapped and holds together well',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Product — Roll', '34',
   'Roll tastes correct overall',
   NULL,
   NULL,
   'scored', 'true', 'false'),

  -- ── PRODUCT — FRIES ──────────────────────────────────────────────────────
  ('Product — Fries', '35',
   'Fries bag full',
   'The fries portion looks properly filled, not visibly under-portioned.',
   NULL,
   'scored', 'false', 'false'),

  ('Product — Fries', '36',
   'Fries warm',
   NULL,
   NULL,
   'scored', 'true', 'false'),

  ('Product — Fries', '37',
   'Fries crispy',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Product — Fries', '38',
   'Fries properly salted',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Product — Fries', '39',
   'Fries have dukkah on top',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  -- ── MUSIC ────────────────────────────────────────────────────────────────
  ('Music', '40',
   'Music is playing',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Music', '41',
   'Volume feels appropriate',
   NULL,
   NULL,
   'scored', 'false', 'false'),

  ('Music', '42',
   'Shazam track',
   'Record the artist and song name. Shazam one track during your visit.',
   'Shazam one song during your visit and record the artist and track name here.',
   'informational', 'false', 'false')

) AS c(section, ord, label, description, hint, type, is_critical, is_conditional);
