// /todos: personal list is strictly the signed-in user's, incl. recurring; team columns only on explicit Management view.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createFakeSupabase, type FakeMode } from '../../helpers/fake-supabase'

const ME = 'me-id'
const OTHER = 'other-id'
const state = { role: 'UM', mode: 'rls-leak' as FakeMode }
const base = {
  priority: 2, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', completed_at: null, cancelled_at: null,
  notes: null, scheduled_for: null, recurrence_rule: null, recurrence_day: null, parent_todo_id: null,
  upgraded_to_task_id: null, upgraded_at: null, completion_context: null, completed_by_user_id: null, sort_order: null,
}
const tables = {
  todos: [
    { ...base, id: 'a', user_id: ME, title: 'MINE todo' },
    { ...base, id: 'b', user_id: ME, title: 'MINE recurring', recurrence_rule: 'daily', scheduled_for: '2026-01-01' },
    { ...base, id: 'c', user_id: OTHER, title: 'THEIRS todo', owner: { id: OTHER, display_name: 'Other' } },
    { ...base, id: 'd', user_id: OTHER, title: 'THEIRS recurring', recurrence_rule: 'daily', scheduled_for: '2026-01-01', owner: { id: OTHER, display_name: 'Other' } },
  ],
  projects: [], app_users: [{ id: OTHER, display_name: 'Other' }],
}

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: async () => ({ id: ME, role: state.role, display_name: 'Lydia Test', email: 'l@example.test' }),
  getActiveUsers: async () => [{ id: ME, display_name: 'Lydia Test', email: 'l@example.test' }],
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => createFakeSupabase(tables, state.mode),
  createServiceClient: () => createFakeSupabase(tables, state.mode),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/todos', useSearchParams: () => new URLSearchParams() }))
vi.mock('next/cache', () => ({ revalidatePath() {}, revalidateTag() {} }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get() {}, getAll: () => [] }), headers: async () => new Headers() }))

import TodosPage from '@/app/(app)/todos/page'

async function render(role: string, mode: FakeMode, view?: string) {
  state.role = role; state.mode = mode
  return renderToStaticMarkup((await TodosPage({ searchParams: Promise.resolve(view ? { view } : {}) })) as React.ReactElement)
}

describe.each(['UM', 'SUPER_ADMIN'])('/todos personal scoping — %s', role => {
  for (const mode of ['rls-leak', 'honest-eq'] as FakeMode[]) {
    it(`${mode}: default view shows only my to-dos and recurring to-dos`, async () => {
      const html = await render(role, mode)
      expect(html).toContain('MINE todo')
      expect(html).toContain('MINE recurring')
      expect(html).not.toContain('THEIRS')
    })
  }
})
