/**
 * lib/ai/capture-analysis-schema.ts
 *
 * Zod schema for the structured AI output produced by analyzeCapture() (M8B3).
 *
 * Design
 * ──────
 * • No entity UUIDs — the model only returns `name_hint` strings.
 *   Server-side deterministic resolution happens in lib/actions/capture.ts.
 * • No confidence scores — the schema stays lean and the resolver handles
 *   ambiguity through its own exact/partial/ambiguous/not_found logic.
 * • No persistence IDs — this output is ephemeral, returned for human review
 *   and never written to any database table.
 * • Each CandidateUpdate represents ONE atomic institutional fact.
 *   The model must not merge two different facts into a single candidate.
 */

import { z } from 'zod'

// ─── Entity reference ─────────────────────────────────────────────────────────

export const CandidateEntityRefSchema = z.object({
  entity_type: z.enum(['project', 'employee', 'location']),
  /**
   * The name the model found in the note.  Must be a human-readable string —
   * NEVER a UUID.  Resolution to a canonical entity_id is done server-side.
   */
  name_hint: z.string().min(1),
})

// ─── Candidate update ─────────────────────────────────────────────────────────

export const CandidateUpdateSchema = z.object({
  /**
   * Past-tense declarative statement of one institutional fact.
   * Must describe something that has happened, not something to do.
   */
  body: z.string().min(1),
  /**
   * Calendar date in YYYY-MM-DD format when a specific date is clearly stated
   * in the note.  Null when no date can be confidently resolved.
   */
  occurred_on: z.string().nullable(),
  /**
   * Entities this update directly concerns.  May be empty if the entity is
   * genuinely ambiguous in context.  Each entry is a name_hint only — no IDs.
   */
  entity_refs: z.array(CandidateEntityRefSchema),
})

// ─── Root output ──────────────────────────────────────────────────────────────

export const CaptureAnalysisOutputSchema = z.object({
  /** Zero or more atomic factual statements extracted from the note. */
  candidates: z.array(CandidateUpdateSchema),
  /**
   * Optional explanation of ambiguity, why candidates were or were not
   * produced, or any other note the model needs to surface.
   */
  analysis_note: z.string().nullable(),
})

// ─── Exported types ───────────────────────────────────────────────────────────

export type CandidateEntityRef    = z.infer<typeof CandidateEntityRefSchema>
export type CandidateUpdate       = z.infer<typeof CandidateUpdateSchema>
export type CaptureAnalysisOutput = z.infer<typeof CaptureAnalysisOutputSchema>
