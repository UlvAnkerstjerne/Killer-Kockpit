import Link from 'next/link'

type Props = {
  currentWorkspace: 'management' | 'marketing'
}

/**
 * Renders two workspace links: Management (→ /today) and Marketing (→ /marketing).
 * Pure links — no state, no query params, no context.
 *
 * In Management: visible only to users with Marketing access (controlled by caller).
 * In Marketing: always visible (layout already enforces access).
 */
export default function WorkspaceSwitcher({ currentWorkspace }: Props) {
  return (
    <div className="flex bg-[#171717] rounded-xl p-1">
      <Link
        href="/today"
        className={[
          'flex-1 text-xs text-center py-1.5 px-2 rounded-lg transition-colors',
          currentWorkspace === 'management'
            ? 'bg-kraft-light text-[#171717] font-semibold'
            : 'text-kraft-light/60 hover:text-kraft-light',
        ].join(' ')}
      >
        Management
      </Link>
      <Link
        href="/marketing"
        className={[
          'flex-1 text-xs text-center py-1.5 px-2 rounded-lg transition-colors',
          currentWorkspace === 'marketing'
            ? 'bg-kraft-light text-[#171717] font-semibold'
            : 'text-kraft-light/60 hover:text-kraft-light',
        ].join(' ')}
      >
        Marketing
      </Link>
    </div>
  )
}
