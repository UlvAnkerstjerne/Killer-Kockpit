import { getCurrentUser } from '@/lib/auth'
import { getGoogleConnectionStatus } from '@/lib/google/auth'
import { getPlandayConnectionStatus } from '@/lib/planday/auth'
import { canAccessAdminSettings } from '@/lib/permissions'
import { canAccessManagementView } from '@/lib/permissions'
import Link from 'next/link'
import { getKKEmployeesForLinking } from '@/lib/actions/planday-import'
import GoogleConnectionCard from './GoogleConnectionCard'
import PlandayBootstrapCard from './PlandayBootstrapCard'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const user = await getCurrentUser()
  if (!user) return null

  const isAdmin = canAccessAdminSettings(user.role)
  const isManagement = canAccessManagementView(user.role)

  const [googleStatus, plandayStatus, kkEmployeesResult] = await Promise.all([
    getGoogleConnectionStatus(user.id),
    isAdmin ? getPlandayConnectionStatus() : Promise.resolve(null),
    isAdmin ? getKKEmployeesForLinking() : Promise.resolve({ data: [] }),
  ])

  const kkEmployees = kkEmployeesResult.data ?? []

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-black tracking-tight text-kk-ink mb-6">Settings</h1>

      <div className="space-y-5">
        {isManagement && (
          <Link href="/settings/weekly-impact" className="block rounded-xl border border-kk-line bg-kk-panel p-5 transition hover:border-kk-muted">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-kk-brand">Management preview</p>
                <h2 className="mt-1 text-base font-black text-kk-ink">Weekly Impact Brief</h2>
                <p className="mt-1 text-sm leading-relaxed text-kk-muted">Review a personalised weekly synthesis for any active Kockpit member. No email is sent.</p>
              </div>
              <span aria-hidden="true" className="text-xl text-kk-muted">→</span>
            </div>
          </Link>
        )}
        <GoogleConnectionCard status={googleStatus} userRole={user.role} />
        {isAdmin && plandayStatus && (
          <PlandayBootstrapCard initialStatus={plandayStatus} kkEmployees={kkEmployees} />
        )}
      </div>
    </div>
  )
}
