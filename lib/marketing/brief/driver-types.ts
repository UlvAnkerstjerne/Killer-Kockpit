/**
 * lib/marketing/brief/driver-types.ts
 *
 * Types for the Marketing Driver Intelligence layer.
 *
 * A DriverCandidate explains WHY a material signal likely happened
 * by looking across other data sources for plausible causes.
 *
 * Candidates are deterministic — computed by code, not AI.
 * Claude interprets only the supplied candidates; it cannot invent causes.
 */

// ─── Driver confidence levels ────────────────────────────────────────────────
//
// Only two levels. Weak/speculative candidates are discarded entirely.
//   likely   — strong temporal alignment + mechanism + magnitude match
//   possible — some evidence but weaker alignment or counter-evidence

export type DriverConfidence = 'likely' | 'possible'

// ─── Driver types ────────────────────────────────────────────────────────────

export type DriverType =
  | 'google_ads_to_gbp'
  | 'paid_to_ga4'
  | 'gsc_to_ga4_organic'
  | 'content_to_ig_reach'
  | 'posting_cadence_to_organic'
  | 'creative_intelligence_context'

// ─── Driver evidence ────────────────────────────────────────────────────────

export interface DriverEvidence {
  metric:       string          // e.g. 'google_ads_impressions_7d'
  label:        string          // human-readable: 'Google Ads impressions'
  current:      number | null
  prior:        number | null
  change_pct:   number | null   // fractional: -0.59 = -59%
  window:       '7d' | '28d'    // which comparison window this evidence uses
}

// ─── Temporal alignment ──────────────────────────────────────────────────────

export type TemporalAlignment =
  | 'preceding'     // driver change came before target movement
  | 'overlapping'   // driver and target changed in overlapping windows
  | 'following'     // driver change came after target (weakens claim)
  | 'unclear'       // insufficient granularity to determine

// ─── The core candidate ──────────────────────────────────────────────────────

export interface MarketingDriverCandidate {
  id:                   string
  target_signal_id:     string           // the MaterialSignalCandidate.id this driver explains
  driver_type:          DriverType
  source:               string           // data source providing driver evidence
  observation:          string           // factual sentence describing what the driver data shows
  evidence:             DriverEvidence[]
  temporal_alignment:   TemporalAlignment
  mechanism:            string           // brief description of the causal mechanism
  confidence:           DriverConfidence
  caveat:               string           // always present — attribution uncertainty
  supporting_entity_ids?: string[]       // campaign IDs, post IDs where useful
}

// ─── Scoring inputs (internal, not surfaced to user) ─────────────────────────

export interface DriverScoreFactors {
  mechanism_strength:   number   // 0–1
  temporal_alignment:   number   // 0–1
  magnitude_alignment:  number   // 0–1
  supporting_evidence:  number   // 0–1 based on count of evidence items
  counter_evidence:     number   // 0–1 penalty (1 = no counter-evidence, 0 = strong counter)
}

// ─── Persisted driver shape (stored in sections_json) ────────────────────────
//
// Lighter than the full candidate — only what the UI needs.
// Optional for backward compat with old stored briefs.

export interface StoredDriver {
  id:          string
  label:       string
  confidence:  DriverConfidence
  evidence:    string         // pre-formatted evidence string
  caveat:      string
}

// ─── Extended observation (backward-compatible) ──────────────────────────────
//
// When a driver exists, these optional fields are added to BriefObservation.

export interface ObservationDriver {
  driver_id:         string
  driver_label:      string
  driver_confidence: DriverConfidence
  driver_evidence:   string
  driver_caveat:     string
}
