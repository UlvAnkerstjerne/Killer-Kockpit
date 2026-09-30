import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canEditDecision } from '@/lib/permissions'
import { notFound, redirect } from 'next/navigation'
import EditDecisionForm from './EditDecisionForm'

export const dynamic = 'force-dynamic'

export default async function EditDecisionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const [user, { id }] = await Promise.all([getCurrentUser(), params])
  if (!user) return null

  const supabase = await createClient()

  const { data: d } = await supabase
    .from('decisions')
    .select('id, title, decision_text, rationale, status, decided_at, owner_user_id, project_id')
    .eq('id', id)
    .single()

  if (!d) notFound()

  if (!canEditDecision(user.role, d.owner_user_id, user.id)) {
    redirect(`/decisions/${id}`)
  }

  const { data: projects } = await supabase
    .from('projects')
    .select('id, title')
    .is('archived_at', null)
    .not('status', 'in', '("completed","archived","cancelled")')
    .order('title')

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
          <Link href="/decisions" className="hover:text-kk-ink transition-colors">Decisions</Link>
          <span>›</span>
          <Link href={`/decisions/${id}`} className="hover:text-kk-ink transition-colors truncate">{d.title}</Link>
          <span>›</span>
          <span>Edit</span>
        </div>
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">Edit decision</h1>
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-6">
        <EditDecisionForm
          decision={d}
          projects={projects ?? []}
        />
      </div>
    </div>
  )
}
