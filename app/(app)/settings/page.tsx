import { getCurrentUser } from '@/lib/auth'
import { getGoogleConnectionStatus } from '@/lib/google/auth'
import { getPlandayConnectionStatus } from '@/lib/planday/auth'
import { canAccessAdminSettings } from '@/lib/permissions'
import { getKKEmployeesForLinking } from '@/lib/actions/planday-import'
import GoogleConnectionCard from './GoogleConnectionCard'
import PlandayBootstrapCard from './PlandayBootstrapCard'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const user = await getCurrentUser()
  if (!user) return null

  const isAdmin = canAccessAdminSettings(user.role)

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
        <GoogleConnectionCard status={googleStatus} userRole={user.role} />
        {isAdmin && plandayStatus && (
          <PlandayBootstrapCard initialStatus={plandayStatus} kkEmployees={kkEmployees} />
        )}
      </div>
    </div>
  )
}
