import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing } from '@/lib/permissions'
import { getUserMarketingPermissions } from '@/lib/actions/marketing/permissions'
import MarketingShell from '@/components/layout/MarketingShell'

// All /marketing/* routes live inside this layout.
// It enforces authentication and Marketing workspace access.
//
// This layout is completely separate from app/(app)/layout.tsx.
// Marketing-specific data fetching, integrations, and AI features
// must remain inside the (marketing) route group so they never
// run on the Management request path.
//
// marketingPermissions is fetched here so the shell and all child pages
// can use fine-grained permission checks without additional DB round-trips.
// It is never fetched on Management routes — isolation is structural.
export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  if (!canAccessMarketing(user.role, user.marketing_access)) {
    redirect('/today')
  }

  const marketingPermissions = await getUserMarketingPermissions(user.id)

  return (
    <MarketingShell user={user} marketingPermissions={marketingPermissions}>
      {children}
    </MarketingShell>
  )
}
