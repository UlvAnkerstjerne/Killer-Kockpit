import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentUser } from '@/lib/auth'
import { canCreateDecision } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import DecisionForm from './DecisionForm'

export default async function NewDecisionPage({
  searchParams,
}: {
  searchParams: Promise<{ project_id?: string; supersedes?: string }>
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])
  if (!user) return null
  if (!canCreateDecision(user.role)) redirect('/decisions')

  const supabase = await createClient()
  const { data: projects } = await supabase
    .from('projects')
    .select('id, title')
    .is('archived_at', null)
    .not('status', 'in', '("completed","archived","cancelled")')
    .order('title')

  let supersededDecision = null
  if (params.supersedes) {
    const { data } = await supabase
      .from('decisions')
      .select('id, title')
      .eq('id', params.supersedes)
      .single()
    supersededDecision = data
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-kk-muted mb-1">
          <Link href="/decisions" className="hover:text-kk-ink transition-colors">Decisions</Link>
          <span>›</span>
          <span>New</span>
        </div>
        <h1 className="text-2xl font-black tracking-tight text-kk-ink">
          {supersededDecision ? 'Record superseding decision' : 'Record decision'}
        </h1>
        {supersededDecision && (
          <p className="text-sm text-kk-muted mt-0.5">
            This will supersede: <span className="font-medium text-kk-ink">{supersededDecision.title}</span>
          </p>
        )}
      </div>

      <div className="bg-kk-panel border border-kk-line rounded-2xl p-6">
        <DecisionForm
          projects={projects ?? []}
          defaultProjectId={params.project_id}
          supersedesDecisionId={params.supersedes}
        />
      </div>
    </div>
  )
}
