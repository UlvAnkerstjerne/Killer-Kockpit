import type { ImplementationMode, ImplementationStatus, ImplementationView } from './types'
import { RESERVING_STATUSES } from './types'

/** Mirrors paid_strategy_reserved_dkk() in the database (the linked-task release applies to physical handoffs only). */
export function isReserving(status: ImplementationStatus, taskStatus: string | null = null): boolean {
  return RESERVING_STATUSES.includes(status) && !(taskStatus && ['done', 'cancelled'].includes(taskStatus))
}

const MODE_LABEL: Record<ImplementationMode, string> = {
  platform_action: 'Meta change', tracking_execution: 'Tracking', creative_execution: 'Creative', campaign_creation: 'New campaign', needs_input: 'Needs input',
}
export const modeLabel = (mode: ImplementationMode) => MODE_LABEL[mode]

/** Short, honest card text. The blocker is quoted exactly; a task is never implied. */
export function stateLabel(v: Pick<ImplementationView, 'status' | 'mode' | 'blockers' | 'message'>): string {
  const first = v.blockers[0]
  switch (v.status) {
    case 'prepared': return 'Prepared · not yet confirmed'
    case 'needs_input': return 'Needs input'
    case 'approved': return 'Starting…'
    case 'planning': case 'executing': case 'verifying': return 'Kockpit is working on it…'
    case 'waiting_for_access': return `Blocked — needs access: ${first?.message ?? v.message ?? 'see below'}`
    case 'waiting_for_input': return first?.kind === 'physical' ? `Waiting for filming: ${first.unblock}` : `Waiting for you: ${first?.message ?? v.message ?? 'see below'}`
    case 'ready_to_activate': return 'Ready to activate · created and verified, still paused'
    case 'in_motion': return v.mode === 'platform_action' ? 'In motion · change applied, being monitored' : 'In motion · live and being monitored'
    case 'completed': return v.mode === 'platform_action' ? 'Completed · change applied' : 'Completed · verified'
    case 'started': return 'Started'
    case 'cancelled': return 'Cancelled · budget released'
    case 'needs_attention': return `Needs attention · check before retrying${v.message ? `: ${v.message}` : ''}`
    case 'failed': return 'Failed · nothing was changed'
    case 'rejected': return 'Rejected'
  }
}

/** The confirm button says what will happen. Only a platform change says "execute"; building paused objects says so. */
export const confirmLabel = (mode: ImplementationMode | undefined, changesMeta: boolean) =>
  mode === 'platform_action' ? 'Confirm & execute' : changesMeta ? 'Confirm & build (paused)' : 'Confirm implementation'
