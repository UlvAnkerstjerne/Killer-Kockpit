import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canAccessMarketing } from '@/lib/permissions'
import MarketingShell from '@/components/layout/MarketingShell'

// All /marketing/* routes live inside this layout.
// It enforces authentication and Marketing workspace access.
//
// This layout is completely separate from app/(app)/layout.tsx.
// Marketing-specific data fetching, integrations, and AI features
// must remain inside the (marketing) route group so they never
// run on the Management request path.
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

  return <MarketingShell user={user}>{children}</MarketingShell>
}
