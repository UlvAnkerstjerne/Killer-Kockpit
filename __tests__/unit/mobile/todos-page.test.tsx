// /todos: default is strictly the signed-in user's list (incl. recurring). Management users pick ONE team member at a time
// via ?owner=; another person's list is read-only. Non-management users can never view anyone else.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createFakeSupabase, type FakeMode } from '../../helpers/fake-supabase'

const ME = '0b5b5b08-1d0b-4d13-9d93-e1b7fc2c0dc1'
const OTHER = '3a3a3a3a-0000-4000-8000-000000000002'
const SHU = '4b4b4b4b-0000-4000-8000-000000000003'
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
  projects: [], app_users: [
    { id: ME, display_name: 'Lydia Test', role: 'UM', active: true },
    { id: OTHER, display_name: 'Other', role: 'UM', active: true },
    { id: SHU, display_name: 'Shu Member', role: 'MEMBER', active: true },
  ],
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

async function render(role: string, mode: FakeMode, owner?: string) {
  state.role = role; state.mode = mode
  return renderToStaticMarkup((await TodosPage({ searchParams: Promise.resolve(owner ? { owner } : {}) })) as React.ReactElement)
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

describe.each(['UM', 'SUPER_ADMIN'])('/todos person selector — %s', role => {
  it('default: own list selected, team names shown, no Everyone/All', async () => {
    const html = await render(role, 'rls-leak')
    expect(html).toContain('aria-label="Team member"')
    expect(html).toMatch(/aria-current="page"[^>]*>Lydia</)
    expect(html).toContain('>Other<')
    expect(html).not.toContain('Shu') // MEMBERs are not offered
    expect(html).not.toMatch(/Everyone/i)
    expect(html).not.toMatch(/>All</)
    expect(html).toContain('Add a to-do...') // own list is interactive
  })

  for (const mode of ['rls-leak', 'honest-eq'] as FakeMode[]) {
    it(`${mode}: ?owner= shows only that person's open to-dos, read-only`, async () => {
      const html = await render(role, mode, OTHER)
      expect(html).toContain('THEIRS todo')
      expect(html).toContain('THEIRS recurring')
      expect(html).not.toContain('MINE')
      expect(html).toMatch(/aria-current="page"[^>]*>Other</)
      expect(html).not.toContain('Add a to-do...')      // no create form
      expect(html).not.toContain('title="Mark complete"') // no complete control
      expect(html).not.toContain('title="Edit"')          // no edit control
    })
  }

  it('shows one person at a time (never several columns)', async () => {
    const html = await render(role, 'rls-leak', OTHER)
    expect((html.match(/uppercase tracking-wide/g) ?? []).length).toBe(1)
  })

  it('an unknown or non-management owner falls back to my own list', async () => {
    for (const owner of [SHU, 'not-a-uuid']) {
      const html = await render(role, 'honest-eq', owner)
      expect(html).toContain('MINE todo')
      expect(html).not.toContain('THEIRS')
    }
  })
})

describe('/todos — non-management users', () => {
  it('see no selector and cannot view another owner via the URL', async () => {
    for (const mode of ['rls-leak', 'honest-eq'] as FakeMode[]) {
      const html = await render('MEMBER', mode, OTHER)
      expect(html).not.toContain('aria-label="Team member"')
      expect(html).toContain('MINE todo')
      expect(html).not.toContain('THEIRS')
    }
  })
})
