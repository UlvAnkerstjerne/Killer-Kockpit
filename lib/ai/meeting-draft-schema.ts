/**
 * lib/ai/meeting-draft-schema.ts
 *
 * Zod schema for the structured AI output stored in meeting_ai_drafts.output_json.
 *
 * Imported by:
 *   • lib/ai/generate-meeting-draft.ts — passed to zodOutputFormat() for structured output
 *   • lib/actions/ai-drafts.ts         — used to type the stored/retrieved output_json
 *   • AiDraftSection.tsx               — used to type the preview data
 *
 * M5B only: no UUIDs, no resolved owners, no applied state.
 * Everything here is AI-suggested text for human review.
 */

import { z } from 'zod'

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const TaskDraftSchema = z.object({
  title:              z.string(),
  description:        z.string().nullable(),
  owner_display_name: z.string().nullable(),
  suggested_due:      z.string().nullable(),
  deadline_evidence:  z.string().nullable(),
  project_hint:       z.string().nullable(),
  priority_hint:      z.enum(['high', 'normal', 'low']).nullable(),
})

const DecisionDraftSchema = z.object({
  title:         z.string(),
  decision_text: z.string(),
  rationale:     z.string().nullable(),
})

const WaitingOnDraftSchema = z.object({
  title:              z.string(),
  waiting_for:        z.string().nullable(),
  owner_display_name: z.string().nullable(),
  suggested_due:      z.string().nullable(),
  deadline_evidence:  z.string().nullable(),
  notes:              z.string().nullable(),
})

// ─── Root schema ──────────────────────────────────────────────────────────────

export const MeetingDraftOutputSchema = z.object({
  minutes:     z.string(),
  tasks:       z.array(TaskDraftSchema),
  decisions:   z.array(DecisionDraftSchema),
  waiting_ons: z.array(WaitingOnDraftSchema),
})

export type MeetingDraftOutput = z.infer<typeof MeetingDraftOutputSchema>
export type TaskDraft       = z.infer<typeof TaskDraftSchema>
export type DecisionDraft   = z.infer<typeof DecisionDraftSchema>
export type WaitingOnDraft  = z.infer<typeof WaitingOnDraftSchema>
