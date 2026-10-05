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
  const isMarketing = currentWorkspace === 'marketing'

  return (
    <div className={[
      'flex rounded-xl p-1',
      isMarketing ? 'bg-kk-line' : 'bg-[#171717]',
    ].join(' ')}>
      <Link
        href="/today"
        className={[
          'flex-1 text-xs text-center py-1.5 px-2 rounded-lg transition-colors',
          currentWorkspace === 'management'
            ? 'bg-kraft-light text-[#171717] font-semibold'
            : isMarketing
              ? 'text-kk-muted hover:text-kk-ink'
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
            ? 'bg-kk-brand text-white font-semibold'
            : 'text-kraft-light/60 hover:text-kraft-light',
        ].join(' ')}
      >
        Marketing
      </Link>
    </div>
  )
}
