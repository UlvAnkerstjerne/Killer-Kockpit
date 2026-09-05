/**
 * lib/ai/email-analysis-schema.ts
 *
 * Zod schema for the structured AI output produced by analyzeEmail().
 *
 * This output is EPHEMERAL — it is returned to the browser for human review
 * and NEVER persisted to any database table, audit log, or cache.
 *
 * Design notes
 * ────────────
 * • No persistence IDs, user UUIDs, or entity IDs — those belong to the apply step.
 * • `responsible` on task uses a discriminated sub-object so the model can
 *   distinguish current_user / named_person / unknown without inventing UUIDs.
 * • `evidence` is a short verbatim excerpt — proof for the human reviewer.
 *   It is returned transiently only and must never be logged or persisted.
 * • Nullable fields default to null when the model cannot confidently infer them.
 */

import { z } from 'zod'

// ─── Responsibility sub-schema ────────────────────────────────────────────────

const ResponsibilitySchema = z.object({
  type:         z.enum(['current_user', 'named_person', 'unknown']),
  /** Non-null only when type === 'named_person'. Free text — NOT a KK UUID. */
  display_name: z.string().nullable(),
})

// ─── Per-kind suggestion schemas ──────────────────────────────────────────────

const TodoSuggestionSchema = z.object({
  kind:          z.literal('todo'),
  title:         z.string(),
  reason:        z.string(),
  evidence:      z.string().nullable(),
  notes:         z.string().nullable(),
  /** ISO date string (YYYY-MM-DD) — only when explicitly stated in the email. */
  scheduled_for: z.string().nullable(),
})

const TaskSuggestionSchema = z.object({
  kind:          z.literal('task'),
  title:         z.string(),
  reason:        z.string(),
  evidence:      z.string().nullable(),
  description:   z.string().nullable(),
  responsible:   ResponsibilitySchema,
  /** ISO timestamp — only when explicitly stated. */
  due_at:        z.string().nullable(),
  priority_hint: z.enum(['high', 'normal', 'low']).nullable(),
})

const WaitingOnSuggestionSchema = z.object({
  kind:              z.literal('waiting_on'),
  title:             z.string(),
  reason:            z.string(),
  evidence:          z.string().nullable(),
  /** Person or organisation being waited on — free text, not a KK user ID. */
  waiting_for_name:  z.string().nullable(),
  /** ISO timestamp — only when explicitly stated. */
  due_at:            z.string().nullable(),
  notes:             z.string().nullable(),
})

const MeetingSuggestionSchema = z.object({
  kind:            z.literal('meeting'),
  title:           z.string(),
  reason:          z.string(),
  evidence:        z.string().nullable(),
  /** ISO timestamp — only when date AND time are explicitly stated. */
  scheduled_start: z.string().nullable(),
  /** ISO timestamp — only when explicitly stated. */
  scheduled_end:   z.string().nullable(),
  /** Free-text venue — only when explicitly stated. */
  location:        z.string().nullable(),
  /** Proposed agenda or purpose. */
  context:         z.string().nullable(),
})

// ─── Union ────────────────────────────────────────────────────────────────────

export const EmailSuggestionSchema = z.discriminatedUnion('kind', [
  TodoSuggestionSchema,
  TaskSuggestionSchema,
  WaitingOnSuggestionSchema,
  MeetingSuggestionSchema,
])

// ─── Root output schema ───────────────────────────────────────────────────────

export const EmailAnalysisOutputSchema = z.object({
  /** May be empty — zero suggestions is valid. */
  suggestions:   z.array(EmailSuggestionSchema),
  /** Optional note explaining ambiguities or why no suggestions were made. */
  analysis_note: z.string().nullable(),
})

// ─── Exported types ───────────────────────────────────────────────────────────

export type Responsibility       = z.infer<typeof ResponsibilitySchema>
export type TodoSuggestion       = z.infer<typeof TodoSuggestionSchema>
export type TaskSuggestion       = z.infer<typeof TaskSuggestionSchema>
export type WaitingOnSuggestion  = z.infer<typeof WaitingOnSuggestionSchema>
export type MeetingSuggestion    = z.infer<typeof MeetingSuggestionSchema>
export type EmailSuggestion      = z.infer<typeof EmailSuggestionSchema>
export type EmailAnalysisOutput  = z.infer<typeof EmailAnalysisOutputSchema>
