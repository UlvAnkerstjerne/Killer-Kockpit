import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import AppShell from '@/components/layout/AppShell'

// All authenticated app routes live inside this layout.
// It enforces that the user is both authenticated AND an active app_user.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCurrentUser()

  if (!user) {
    redirect('/login')
  }

  return <AppShell user={user}>{children}</AppShell>
}
