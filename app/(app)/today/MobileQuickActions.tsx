import Link from 'next/link'

// Mobile Today shortcuts for manager roles. Rendered when hasMobileManagerExperience(role),
// regardless of Personal/Management view. Regression-protected by __tests__/unit/mobile/.
export default function MobileQuickActions() {
  return (
    <div className="lg:hidden mb-2.5" data-testid="mobile-quick-actions">
      <Link
        href="/kkc/audit"
        className="flex items-center justify-center gap-2 w-full py-4 bg-[#AD3919] text-white text-base font-bold rounded-lg hover:opacity-90 transition-opacity [box-shadow:4px_4px_0_#555555]"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M5 5.5h6M5 8h6M5 10.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
        + Add Audit
      </Link>
      <Link
        href="/kkc/ssp-cph"
        className="flex items-center justify-center gap-2 w-full mt-2.5 py-4 bg-[#171717] text-kraft-light text-base font-bold rounded-lg hover:opacity-90 transition-opacity [box-shadow:4px_4px_0_#555555]"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1.5L9.8 5.2l4.2.6-3 2.9.7 4.1L8 10.8l-3.7 2 .7-4.1-3-2.9 4.2-.6L8 1.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        </svg>
        + Add KQC
      </Link>
    </div>
  )
}
