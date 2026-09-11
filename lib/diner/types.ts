/**
 * lib/diner/types.ts
 *
 * Shared types for the Mystery Diner system.
 * Safe to import in both server and client components.
 */

export type CheckpointType = 'scored' | 'gold_star' | 'waiting_time' | 'informational'

export interface DinerTemplate {
  id:          string
  version:     number
  title:       string
  status:      'draft' | 'published' | 'retired'
  published_at: string | null
}

export interface DinerCheckpoint {
  id:             string
  template_id:    string
  section:        string
  order_index:    number
  label:          string
  description:    string | null
  hint:           string | null
  type:           CheckpointType
  is_critical:    boolean
  is_conditional: boolean
}

/** Result values for scored and gold_star checkpoints. */
export type CheckpointResult = 'pass' | 'fail' | 'na'

export interface DinerResponseValue {
  result: CheckpointResult | null
  notes:  string
}

/** Keyed by checkpoint ID. */
export type DinerResponsesMap = Record<string, DinerResponseValue>

/** Waiting time band values stored in diner_responses.notes. */
export const WAITING_TIME_BANDS = [
  { value: '0-5',   label: '0–5 min',   critical: false },
  { value: '6-10',  label: '6–10 min',  critical: false },
  { value: '11-15', label: '11–15 min', critical: false },
  { value: '16-20', label: '16–20 min', critical: false },
  { value: '20+',   label: '20+ min',   critical: true  },
] as const

export type WaitingTimeBand = typeof WAITING_TIME_BANDS[number]['value']
