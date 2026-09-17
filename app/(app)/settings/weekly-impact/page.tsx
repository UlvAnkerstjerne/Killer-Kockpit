import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getActiveUsers, getCurrentUser } from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { currentCopenhagenDate, mondayForDate } from '@/lib/weekly-impact/week'
import WeeklyImpactPreviewClient from './WeeklyImpactPreviewClient'

export const dynamic = 'force-dynamic'

export default async function WeeklyImpactPreviewPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canAccessManagementView(user.role)) redirect('/today')

  const users = await getActiveUsers()
  const initialUserId = users.some(option => option.id === user.id) ? user.id : (users[0]?.id ?? '')

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/settings" className="text-sm font-semibold text-kk-muted hover:text-kk-ink">← Settings</Link>
      <div className="mt-4 mb-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-kk-brand">Management preview</p>
        <h1 className="mt-1 font-brand text-3xl text-kk-ink sm:text-4xl">Weekly Impact Brief</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-kk-muted">See the actual evidence and AI synthesis for one active Kockpit member before any team delivery is enabled.</p>
      </div>
      <WeeklyImpactPreviewClient users={users} initialUserId={initialUserId} initialWeek={mondayForDate(currentCopenhagenDate())} />
    </div>
  )
}
