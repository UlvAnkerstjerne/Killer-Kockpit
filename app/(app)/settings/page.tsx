import { getCurrentUser } from '@/lib/auth'
import { getGoogleConnectionStatus } from '@/lib/google/auth'
import GoogleConnectionCard from './GoogleConnectionCard'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const user = await getCurrentUser()
  if (!user) return null

  const googleStatus = await getGoogleConnectionStatus(user.id)

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-black tracking-tight text-kk-ink mb-6">Settings</h1>

      <div className="space-y-5">
        <GoogleConnectionCard status={googleStatus} />
      </div>
    </div>
  )
}
