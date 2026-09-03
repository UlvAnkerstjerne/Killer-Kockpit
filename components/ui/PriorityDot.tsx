/**
 * PriorityDot — single source of truth for urgency/priority visual treatment.
 *
 * Mapping (matches reference To-Dos panel):
 *   1 Critical   → red dot
 *   2 Normal     → orange dot
 *   3 Low        → yellow dot
 *   4 Background → grey dot
 *
 * Usage: <PriorityDot priority={item.priority} />
 * The dot is always shown regardless of priority level.
 * Due-date state (Overdue / Today / Tomorrow) is separate — display both when relevant.
 */

export const PRIORITY_CONFIG: Record<number, { label: string; dot: string }> = {
  1: { label: 'Critical',   dot: 'bg-red-600' },
  2: { label: 'Normal',     dot: 'bg-orange-500' },
  3: { label: 'Low',        dot: 'bg-yellow-500' },
  4: { label: 'Background', dot: 'bg-stone-400' },
}

export function PriorityDot({ priority }: { priority: number }) {
  const config = PRIORITY_CONFIG[priority]
  if (!config) return null
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${config.dot}`}
      title={config.label}
      aria-label={config.label}
    />
  )
}
