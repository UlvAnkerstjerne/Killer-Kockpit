import type { ImplementationMode, ImplementationStatus, ImplementationView } from './types'
import { RESERVING_STATUSES } from './types'

const FINISHED_TASK = new Set(['done', 'cancelled'])

/**
 * What the card should show. Work handed to people ("started") follows the linked task: a done task completes it,
 * a cancelled one cancels it. The stored status is settled the next time a person prepares or approves anything.
 */
export function effectiveStatus(status: ImplementationStatus, taskStatus: string | null): ImplementationStatus {
  if ((status === 'started' || status === 'approved') && taskStatus === 'done') return 'completed'
  if ((status === 'started' || status === 'approved') && taskStatus === 'cancelled') return 'cancelled'
  return status
}

/** Mirrors paid_strategy_reserved_dkk() in the database: in-flight statuses whose linked task is not finished. */
export function isReserving(status: ImplementationStatus, taskStatus: string | null): boolean {
  return RESERVING_STATUSES.includes(status) && !(taskStatus && FINISHED_TASK.has(taskStatus))
}

const MODE_LABEL: Record<ImplementationMode, string> = {
  platform_action: 'Meta change', implementation_task: 'Implementation task', creative_task: 'Creative task',
  implementation_package: 'Launch package', needs_input: 'Needs input',
}
export const modeLabel = (mode: ImplementationMode) => MODE_LABEL[mode]

/** Short, honest card text. "Started" is never worded as launched or implemented. */
export function stateLabel(v: Pick<ImplementationView, 'status' | 'mode' | 'ownerName' | 'linkedTaskId'>): string {
  const task = v.linkedTaskId ? `Task created${v.ownerName ? ` · ${v.ownerName}` : ''}` : null
  switch (v.status) {
    case 'prepared': return 'Prepared · not yet confirmed'
    case 'needs_input': return 'Needs input'
    case 'approved': return 'Starting…'
    case 'started': return v.mode === 'implementation_package' ? `Package saved · ${task ?? 'task pending'}` : task ?? 'Started'
    case 'in_motion': return 'In motion · change applied, being monitored'
    case 'completed': return v.mode === 'platform_action' ? 'Completed · change applied' : `Completed${v.ownerName ? ` · ${v.ownerName}` : ''}`
    case 'cancelled': return 'Cancelled · task cancelled'
    case 'needs_attention': return 'Needs attention · check before retrying'
    case 'failed': return 'Failed · nothing was changed'
  }
}

/** The confirm button says whether Meta will change. Only a platform action says "execute". */
export const confirmLabel = (changesMeta: boolean) => (changesMeta ? 'Confirm & execute' : 'Confirm implementation')
