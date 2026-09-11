import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canAccessQualityCheck } from '@/lib/permissions'
import { createServiceClient } from '@/lib/supabase/server'
import DinerInvitations from './DinerInvitations'

export const dynamic = 'force-dynamic'

export interface DinerInvitationRow {
  id:            string
  diner_name:    string
  diner_email:   string | null
  location_id:   string | null
  location_name: string | null
  created_at:    string
  expires_at:    string
  status:        'pending' | 'active' | 'submitted' | 'expired'
  submitted_at:  string | null
  score_pct:     number | null
}

async function getDinerInvitations(): Promise<DinerInvitationRow[]> {
  const db = createServiceClient()

  const { data, error } = await db
    .from('diner_invitations')
    .select(`
      id, diner_name, diner_email, location_id, created_at, expires_at, status,
      locations ( name ),
      diner_submissions ( score_pct, updated_at, status )
    `)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    console.error('[kkc/diner] getDinerInvitations error:', error.message)
    return []
  }

  return (data ?? []).map((row: any) => {
    const sub = Array.isArray(row.diner_submissions)
      ? row.diner_submissions[0] ?? null
      : row.diner_submissions ?? null

    return {
      id:            row.id,
      diner_name:    row.diner_name,
      diner_email:   row.diner_email ?? null,
      location_id:   row.location_id ?? null,
      location_name: (row.locations as any)?.name ?? null,
      created_at:    row.created_at,
      expires_at:    row.expires_at,
      status:        row.status,
      submitted_at:  sub?.status === 'submitted' ? sub.updated_at : null,
      score_pct:     sub?.score_pct ?? null,
    }
  })
}

export default async function DinerPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canAccessQualityCheck(user.role)) redirect('/today')

  const invitations = await getDinerInvitations()

  return <DinerInvitations invitations={invitations} />
}
