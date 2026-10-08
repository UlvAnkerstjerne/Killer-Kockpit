// Regression protection for the mobile Today experience and personal data scoping.
// Renders the real TodayPage server component against a fake Supabase.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createFakeSupabase, type FakeMode } from '../../helpers/fake-supabase'

const ME = 'me-id'
const OTHER = 'other-id'
const state = { role: 'UM' as string, mode: 'rls-leak' as FakeMode, tables: {} as Record<string, Record<string, unknown>[]> }

vi.mock('@/lib/auth', () => ({
  getCurrentUser: async () => ({ id: ME, role: state.role, display_name: 'Lydia Test', email: 'lydia@example.test' }),
  getActiveUsers: async () => [{ id: ME, display_name: 'Lydia Test', email: 'lydia@example.test' }],
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => createFakeSupabase(state.tables, state.mode),
  createServiceClient: () => createFakeSupabase(state.tables, state.mode),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh() {}, push() {} }),
  usePathname: () => '/today',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/cache', () => ({ revalidatePath() {}, revalidateTag() {} }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get() {}, getAll: () => [] }), headers: async () => new Headers() }))
vi.mock('@/lib/actions/tasks', () => ({ createTask: vi.fn() }))
vi.mock('@/components/layout/CaptureBar', () => ({ default: () => null }))

import TodayPage from '@/app/(app)/today/page'

const future = new Date(Date.now() + 2 * 3600_000).toISOString()
function task(id: string, title: string, owner: string) {
  return { id, title, priority: 2, due_at: future, completed_at: null, status: 'open', returned_at: null, submitted_at: null, created_by_user_id: owner, owner_user_id: owner, owner: { id: owner, display_name: owner } }
}
function todo(id: string, title: string, owner: string, extra: Record<string, unknown> = {}) {
  return {
    id, user_id: owner, title, priority: 2, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z',
    completed_at: null, cancelled_at: null, notes: null, scheduled_for: null, recurrence_rule: null,
    recurrence_day: null, parent_todo_id: null, upgraded_to_task_id: null, upgraded_at: null,
    completion_context: null, completed_by_user_id: null, sort_order: null, ...extra,
  }
}

beforeEach(() => {
  state.tables = {
    tasks: [task('t1', 'MINE task one', ME), task('t2', 'MINE task two', ME), task('t3', 'THEIRS task alpha', OTHER), task('t4', 'THEIRS task beta', OTHER), task('t5', 'THEIRS task gamma', OTHER)],
    todos: [
      todo('d1', 'MINE todo', ME),
      todo('d2', 'MINE recurring', ME, { recurrence_rule: 'daily', scheduled_for: '2026-01-01' }),
      todo('d3', 'THEIRS todo', OTHER),
      todo('d4', 'THEIRS recurring', OTHER, { recurrence_rule: 'daily', scheduled_for: '2026-01-01' }),
    ],
    waiting_ons: [
      { id: 'w1', title: 'MINE waiting', priority: 2, due_at: future, fulfilled_at: null, owner_user_id: ME, waiting_for_name: 'x' },
      { id: 'w2', title: 'THEIRS waiting', priority: 2, due_at: future, fulfilled_at: null, owner_user_id: OTHER, waiting_for_name: 'y' },
    ],
    meetings: [{ id: 'm1', title: 'Team sync', status: 'scheduled', scheduled_start: future }],
    projects: [],
  }
})

async function render(role: string, mode: FakeMode, view?: string) {
  state.role = role
  state.mode = mode
  const el = await TodayPage({ searchParams: Promise.resolve(view ? { view } : {}) })
  return renderToStaticMarkup(el as React.ReactElement)
}

function section(html: string, testid: string): string {
  const i = html.indexOf(`data-testid="${testid}"`)
  expect(i, `missing ${testid}`).toBeGreaterThan(-1)
  return html.slice(i)
}

const MANAGERS = ['UM', 'SUPER_ADMIN']
const VIEWS = [undefined, 'personal', 'management']

describe.each(MANAGERS)('mobile Today — %s', role => {
  describe.each(VIEWS)('view=%s', view => {
    it('keeps Add Audit and Add KQC shortcuts', async () => {
      const html = await render(role, 'honest-eq', view)
      const actions = section(html, 'mobile-quick-actions')
      expect(actions).toContain('href="/kkc/audit"')
      expect(actions).toContain('+ Add Audit')
      expect(actions).toContain('href="/kkc/ssp-cph"')
      expect(actions).toContain('+ Add KQC')
    })

    it('keeps My tasks with quick add and Meetings with quick add', async () => {
      const html = await render(role, 'honest-eq', view)
      const mine = section(html, 'mobile-my-tasks')
      expect(mine).toContain('My tasks')
      expect(mine).toMatch(/placeholder="[^"]*[Tt]ask/) // QuickAddTask input
      const meetings = section(html, 'mobile-meetings')
      expect(meetings).toContain('Meetings')
      expect(meetings).toContain('Team sync')
    })

    it('hides the desktop dashboard grid on mobile', async () => {
      const html = await render(role, 'honest-eq', view)
      expect(html).toContain('hidden lg:grid')
    })
  })
})

describe.each(MANAGERS)('personal scoping — %s', role => {
  for (const mode of ['rls-leak', 'honest-eq'] as FakeMode[]) {
    describe.each(['personal', 'management'])(`${mode}, view=%s`, view => {
      it('My tasks, to-dos and recurring to-dos contain only my items, counts match', async () => {
        const html = await render(role, mode, view)
        const mine = section(html, 'mobile-my-tasks')
        const myTasksCard = mine.slice(0, mine.indexOf('data-testid="mobile-meetings"'))
        expect(myTasksCard).toContain('MINE task one')
        expect(myTasksCard).toContain('MINE task two')
        expect(myTasksCard).not.toContain('THEIRS')
        expect(myTasksCard).toMatch(/My tasks<span[^>]*>· 2<\/span>/)
        expect(html).toContain('MINE todo')
        expect(html).toContain('MINE recurring')
        expect(html).not.toContain('THEIRS todo')
        expect(html).not.toContain('THEIRS recurring')
        if (view !== 'management') expect(html).not.toContain('THEIRS task')
      })
    })
  }

  it('desktop Management view stays available and is org-wide', async () => {
    const html = await render(role, 'honest-eq', 'management')
    expect(html).toContain('href="/today?view=personal"')
    expect(html).toContain('href="/today?view=management"')
    expect(html).toContain('THEIRS task alpha') // desktop grid shows org-wide work in Management view
  })

  it('desktop default is Personal (no org-wide tasks)', async () => {
    const html = await render(role, 'honest-eq')
    expect(html).not.toContain('THEIRS')
  })
})

describe('MEMBER', () => {
  it('has no manager mobile features and no view toggle', async () => {
    const html = await render('MEMBER', 'honest-eq', 'management')
    expect(html).not.toContain('mobile-quick-actions')
    expect(html).not.toContain('mobile-my-tasks')
    expect(html).not.toContain('/today?view=management')
    expect(html).not.toContain('THEIRS')
  })
})

// Browser-check fixtures: when E2E_FIXTURE_DIR is set, dump the rendered pages so the Playwright
// suite (e2e/mobile-today.spec.ts) can assert real responsive visibility at phone and desktop widths.
describe('e2e fixtures', () => {
  it.skipIf(!process.env.E2E_FIXTURE_DIR)('writes rendered Today HTML', async () => {
    const dir = process.env.E2E_FIXTURE_DIR as string
    mkdirSync(dir, { recursive: true })
    for (const [name, role, view] of [
      ['um-default', 'UM', undefined], ['um-management', 'UM', 'management'],
      ['admin-default', 'SUPER_ADMIN', undefined], ['member', 'MEMBER', undefined],
    ] as const) {
      writeFileSync(path.join(dir, `today-${name}.html`), await render(role, 'honest-eq', view))
    }
  })
})
