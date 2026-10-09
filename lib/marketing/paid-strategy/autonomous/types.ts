import type { CapabilityId } from './capabilities'

/**
 * Why an implementation cannot continue by itself. A blocker is shown as the exact missing thing and the
 * smallest action that clears it. It is NOT a task: nobody is asked to do work Kockpit can do.
 *
 *   access      Kockpit lacks a permission or integration it needs (waiting_for_access)
 *   capability  Kockpit has not been built to do this step yet (waiting_for_access)
 *   input       a genuine decision or fact only a person has (waiting_for_input)
 *   physical    a physical human act that cannot be digital (the only blocker that may create a task)
 */
export interface Blocker {
  kind: 'access' | 'capability' | 'input' | 'physical'
  code: string
  capability?: CapabilityId
  /** What is missing, in one sentence. */
  message: string
  /** The smallest action that unblocks it. */
  unblock: string
}

/** One external or internal step of an execution. The ledger makes retries resume instead of repeating. */
export interface StepRecord {
  key: string
  status: 'done' | 'failed' | 'uncertain' | 'skipped'
  at: string
  /** IDs of objects this step created (Meta ids are server-side data, never sent to a model). */
  externalId?: string
  detail?: Record<string, unknown>
}

export interface ExecutionLedger {
  version: 'v1'
  token: string
  steps: StepRecord[]
  blockers: Blocker[]
  evidence: Record<string, unknown>
}

export const emptyLedger = (token: string): ExecutionLedger => ({ version: 'v1', token, steps: [], blockers: [], evidence: {} })
export const stepDone = (l: ExecutionLedger, key: string) => l.steps.find(s => s.key === key && s.status === 'done')
export const stepId = (l: ExecutionLedger, key: string) => stepDone(l, key)?.externalId
