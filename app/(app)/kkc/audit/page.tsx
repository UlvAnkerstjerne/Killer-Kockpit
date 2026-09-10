import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { getOperationalAuditSubmissions, getActiveLocations } from '@/lib/audit/submissions'
import AuditLanding from './AuditLanding'

export const dynamic = 'force-dynamic'

export default async function OperationalAuditPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canAccessQualityCheck(user.role)) redirect('/today')

  const [{ submissions }, locations] = await Promise.all([
    getOperationalAuditSubmissions(),
    getActiveLocations(),
  ])

  return <AuditLanding submissions={submissions} locations={locations} />
}
