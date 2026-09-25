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

  const [auditResult, locations] = await Promise.all([
    getOperationalAuditSubmissions(),
    getActiveLocations(),
  ])

  const { submissions, templateConfig, error: auditError } = auditResult

  // Diagnostic: log exactly what this user sees (remove after diagnosis)
  console.log('[audit/page] user=%s role=%s submissions=%d templateConfig=%s error=%s ids=%s',
    user.id, user.role, submissions.length,
    templateConfig ? 'yes' : 'null',
    auditError ?? 'none',
    submissions.map(s => `${s.id.slice(0,8)}:${s.status}`).join(',') || '(empty)',
  )

  return <AuditLanding submissions={submissions} locations={locations} templateConfig={templateConfig} />
}
