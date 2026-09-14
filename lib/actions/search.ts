'use server'

import { getCurrentUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

const LIMIT = 5

export type SearchResultKind = 'task' | 'project' | 'meeting' | 'decision' | 'waiting_on' | 'person'

export interface SearchResult {
  kind: SearchResultKind
  id: string
  title: string
  subtitle?: string
  href: string
}

export interface GlobalSearchResults {
  tasks: SearchResult[]
  projects: SearchResult[]
  meetings: SearchResult[]
  decisions: SearchResult[]
  waitingOns: SearchResult[]
  people: SearchResult[]
}

const EMPTY: GlobalSearchResults = {
  tasks: [], projects: [], meetings: [], decisions: [], waitingOns: [], people: [],
}

export async function globalSearch(query: string): Promise<GlobalSearchResults> {
  const user = await getCurrentUser()
  if (!user) return EMPTY

  const q = query.trim()
  if (!q || q.length > 200) return EMPTY

  const supabase = await createClient()

  const [
    tasksResult,
    projectsResult,
    meetingsResult,
    decisionsResult,
    waitingOnsResult,
    peopleResult,
  ] = await Promise.all([
    supabase
      .from('tasks')
      .select('id, title, status')
      .is('archived_at', null)
      .or(`title.ilike.%${q}%,description.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(LIMIT),

    supabase
      .from('projects')
      .select('id, title, status')
      .is('archived_at', null)
      .ilike('title', `%${q}%`)
      .order('title')
      .limit(LIMIT),

    supabase
      .from('meetings')
      .select('id, title, scheduled_start')
      .is('cancelled_at', null)
      .ilike('title', `%${q}%`)
      .order('scheduled_start', { ascending: false })
      .limit(LIMIT),

    supabase
      .from('decisions')
      .select('id, title, status')
      .is('archived_at', null)
      .or(`title.ilike.%${q}%,decision_text.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(LIMIT),

    supabase
      .from('waiting_ons')
      .select('id, title, status')
      .is('archived_at', null)
      .or(`title.ilike.%${q}%,notes.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(LIMIT),

    supabase
      .from('employees')
      .select('id, name, role_title')
      .eq('employment_status', 'active')
      .or(`name.ilike.%${q}%,role_title.ilike.%${q}%`)
      .order('name')
      .limit(LIMIT),
  ])

  return {
    tasks: (tasksResult.data ?? []).map(r => ({
      kind: 'task',
      id: r.id,
      title: r.title,
      subtitle: r.status?.replace('_', ' '),
      href: `/tasks/${r.id}`,
    })),
    projects: (projectsResult.data ?? []).map(r => ({
      kind: 'project',
      id: r.id,
      title: r.title,
      subtitle: r.status,
      href: `/projects/${r.id}`,
    })),
    meetings: (meetingsResult.data ?? []).map(r => ({
      kind: 'meeting',
      id: r.id,
      title: r.title,
      subtitle: r.scheduled_start
        ? new Date(r.scheduled_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : undefined,
      href: `/meetings/${r.id}`,
    })),
    decisions: (decisionsResult.data ?? []).map(r => ({
      kind: 'decision',
      id: r.id,
      title: r.title,
      subtitle: r.status,
      href: `/decisions/${r.id}`,
    })),
    waitingOns: (waitingOnsResult.data ?? []).map(r => ({
      kind: 'waiting_on',
      id: r.id,
      title: r.title,
      subtitle: r.status,
      href: `/waiting-ons/${r.id}`,
    })),
    people: (peopleResult.data ?? []).map(r => ({
      kind: 'person',
      id: r.id,
      title: r.name,
      subtitle: r.role_title ?? undefined,
      href: `/people/${r.id}`,
    })),
  }
}
