/**
 * /tasks — My tasks vs Everyone's tasks.
 * Renders the real page server component with a call-recording Supabase mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const U = {
  ulv:    '1d1c6260-f084-464c-920d-5ff099d618a1',
  lydia:  '0b5b5b08-1d0b-4d13-9d93-e1b7fc2c0dc1',
  sara:   '5363b471-b4cb-4156-9e8e-3260d3ecb05e',
  kasper: '2f2f2f2f-0000-4000-8000-000000000001',
  adam:   '3a3a3a3a-0000-4000-8000-000000000002',
  shuhei: '4b4b4b4b-0000-4000-8000-000000000003',
}

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  calls: [] as { table: string; op: string; args: unknown[] }[],
  tasks: [] as object[],
  taskListProps: null as null | { tasks: object[]; currentUser: { id: string; role: string } },
}))

vi.mock('@/lib/auth', () => ({
  getCurrentUser: async () => mocks.user,
  getActiveUsers: async () => [
    { id: U.ulv, display_name: 'Ulv Ankerstjerne', email: 'u' }, { id: U.lydia, display_name: 'Lydia Mertiri', email: 'l' },
    { id: U.sara, display_name: 'Sara Jørgensen', email: 's' }, { id: U.kasper, display_name: 'Kasper Kristiansen', email: 'k' },
    { id: U.adam, display_name: 'Adam Vearey', email: 'a' }, { id: U.shuhei, display_name: 'Shuhei Kusanagi', email: 'sh' },
  ],
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const op of ['select', 'is', 'not', 'eq', 'in', 'order']) {
        chain[op] = (...args: unknown[]) => { mocks.calls.push({ table, op, args }); return chain }
      }
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({
          data: table === 'tasks' ? mocks.tasks : [
            { id: U.ulv, display_name: 'Ulv Ankerstjerne' }, { id: U.lydia, display_name: 'Lydia Mertiri' },
            { id: U.sara, display_name: 'Sara Jørgensen' }, { id: U.kasper, display_name: 'Kasper Kristiansen' },
            { id: U.adam, display_name: 'Adam Vearey' },
          ],
          error: null,
        })
      return chain
    },
  }),
}))
vi.mock('@/components/tasks/TaskList', () => ({
  default: (props: { tasks: object[]; currentUser: { id: string; role: string } }) => {
    mocks.taskListProps = props
    return createElement('div', { 'data-testid': 'task-list' }, `${props.tasks.length} tasks`)
  },
}))

import TasksPage from '@/app/(app)/tasks/page'
import { tasksHref, sanitizeOwnerParam, sanitizeStatusParam, orderPeople } from '@/lib/tasks/tasks-url'
import { canEditTaskTerms } from '@/lib/permissions'

const manager = { id: U.lydia, role: 'UM', display_name: 'Lydia Mertiri', email: 'l', active: true }
const member  = { id: U.shuhei, role: 'MEMBER', display_name: 'Shuhei Kusanagi', email: 'sh', active: true }

async function render(params: Record<string, string> = {}) {
  const el = await TasksPage({ searchParams: Promise.resolve(params) })
  return renderToStaticMarkup(el as never)
}
const taskCalls = (op: string) => mocks.calls.filter(c => c.table === 'tasks' && c.op === op)
const ownerEq = () => taskCalls('eq').filter(c => c.args[0] === 'owner_user_id')
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'))

beforeEach(() => {
  mocks.calls.length = 0
  mocks.tasks = [{ id: 't1' }, { id: 't2' }]
  mocks.taskListProps = null
  mocks.user = manager
})

describe('My tasks (default)', () => {
  it('only queries the current user\'s tasks', async () => {
    const html = await render()
    expect(ownerEq()).toEqual([{ table: 'tasks', op: 'eq', args: ['owner_user_id', U.lydia] }])
    expect(html).toContain('My tasks')
    expect(html).not.toContain('Filter by person')
  })

  it('ignores an owner param outside Everyone\'s tasks', async () => {
    await render({ owner: U.sara })
    expect(ownerEq().map(c => c.args[1])).toEqual([U.lydia])
  })

  it('hides done/cancelled by default and filters by status when asked', async () => {
    await render()
    expect(taskCalls('not')[0].args).toEqual(['status', 'in', '("done","cancelled")'])
    mocks.calls.length = 0
    await render({ status: 'blocked' })
    expect(taskCalls('eq').some(c => c.args[0] === 'status' && c.args[1] === 'blocked')).toBe(true)
  })
})

describe("Everyone's tasks (management)", () => {
  it('queries the whole organisation (no owner restriction) and says so', async () => {
    const html = await render({ view: 'management' })
    expect(ownerEq()).toEqual([])
    expect(html).toContain("Everyone&#x27;s tasks")
    expect(taskCalls('is')[0].args).toEqual(['archived_at', null])
  })

  it('renders the My tasks / Everyone\'s tasks toggle with the right links', async () => {
    const html = await render({ view: 'management' })
    expect(html).toContain('aria-label="Tasks view"')
    const h = hrefs(html)
    expect(h).toContain('/tasks')
    expect(h).toContain('/tasks?view=management')
  })

  it('the toggle is available from My tasks too (so managers never get stuck)', async () => {
    const html = await render()
    expect(html).toContain('aria-label="Tasks view"')
    expect(hrefs(html)).toContain('/tasks?view=management')
  })

  it('renders the person filter from active management users, in the preferred order', async () => {
    const html = await render({ view: 'management' })
    const group = html.slice(html.indexOf('aria-label="Filter by person"'))
    const labels = [...group.matchAll(/>([^<]+)<\/a>/g)].map(m => m[1]).slice(0, 6)
    expect(labels).toEqual(['All', 'Ulv', 'Kasper', 'Adam', 'Lydia', 'Sara'])
    expect(html).not.toContain('Shuhei') // MEMBERs are not offered unless selected via URL
  })

  it('owner filter narrows the query to that person', async () => {
    await render({ view: 'management', owner: U.sara })
    expect(ownerEq()).toEqual([{ table: 'tasks', op: 'eq', args: ['owner_user_id', U.sara] }])
  })

  it('a malformed owner param is ignored, never interpolated into a query', async () => {
    await render({ view: 'management', owner: "x' or 1=1 --" })
    expect(ownerEq()).toEqual([])
  })

  it('the owner filter is only a narrowing: the query still runs through the user-scoped client (RLS)', async () => {
    // The page never uses a service client; visibility is whatever RLS returns for the signed-in user.
    const src = (await import('node:fs')).readFileSync('app/(app)/tasks/page.tsx', 'utf8')
    expect(src).not.toMatch(/createServiceClient/)
  })

  it('status links preserve view and owner; owner links preserve view and status', async () => {
    const html = await render({ view: 'management', owner: U.sara, status: 'blocked' })
    const h = hrefs(html)
    expect(h).toContain(`/tasks?view=management&owner=${U.sara}`)                    // Active (no status)
    expect(h).toContain(`/tasks?view=management&owner=${U.sara}&status=open`)         // status tab keeps owner + view
    expect(h).toContain(`/tasks?view=management&owner=${U.kasper}&status=blocked`)    // person chip keeps status
    expect(h).toContain('/tasks?view=management&status=blocked')                       // All keeps status, drops owner
    expect(h).toContain('/tasks?status=blocked')                                      // My tasks keeps status, drops owner
  })

  it('shows a person chosen via URL even if they are not a management user', async () => {
    const html = await render({ view: 'management', owner: U.shuhei })
    expect(html).toContain('Shuhei')
  })
})

describe('non-management users', () => {
  it('never get the toggle or person filter, and ?view=management does nothing', async () => {
    mocks.user = member
    for (const params of [{}, { view: 'management' }, { view: 'management', owner: U.sara }] as Record<string, string>[]) {
      mocks.calls.length = 0
      const html = await render(params)
      expect(html).not.toContain('aria-label="Tasks view"')
      expect(html).not.toContain('Filter by person')
      expect(html).not.toContain("Everyone")
      expect(ownerEq()).toEqual([{ table: 'tasks', op: 'eq', args: ['owner_user_id', U.shuhei] }])
    }
  })
})

describe('edit permissions are unchanged', () => {
  it('TaskList still receives the signed-in user, so canEditTaskTerms decides per row', async () => {
    await render({ view: 'management' })
    expect(mocks.taskListProps?.currentUser).toMatchObject({ id: U.lydia, role: 'UM' })
  })

  it('seeing someone else\'s task does not grant edit rights', () => {
    expect(canEditTaskTerms('UM', U.sara, U.lydia)).toBe(false)       // UM, not the creator
    expect(canEditTaskTerms('UM', U.lydia, U.lydia)).toBe(true)       // creator
    expect(canEditTaskTerms('SUPER_ADMIN', U.sara, U.ulv)).toBe(true) // existing admin override, unchanged
    expect(canEditTaskTerms('MEMBER', U.sara, U.shuhei)).toBe(false)
  })
})

describe('tasks URL helpers', () => {
  it('builds the documented URLs', () => {
    expect(tasksHref({ view: 'personal' })).toBe('/tasks')
    expect(tasksHref({ view: 'management' })).toBe('/tasks?view=management')
    expect(tasksHref({ view: 'management', owner: U.sara })).toBe(`/tasks?view=management&owner=${U.sara}`)
    expect(tasksHref({ view: 'management', status: 'blocked' })).toBe('/tasks?view=management&status=blocked')
    expect(tasksHref({ view: 'personal', owner: U.sara, status: 'done' })).toBe('/tasks?status=done') // owner dropped outside Everyone's
  })

  it('sanitises params', () => {
    expect(sanitizeOwnerParam(U.sara.toUpperCase())).toBe(U.sara)
    expect(sanitizeOwnerParam('nope')).toBeNull()
    expect(sanitizeStatusParam('blocked')).toBe('blocked')
    expect(sanitizeStatusParam('drop table')).toBeNull()
  })

  it('orders people Ulv, Kasper, Adam, Lydia, Sara then alphabetical', () => {
    const names = orderPeople(['Sara J', 'Zed Z', 'Lydia M', 'Ulv A', 'Adam V', 'Kasper K', 'Bo B'].map(display_name => ({ display_name })))
    expect(names.map(n => n.display_name)).toEqual(['Ulv A', 'Kasper K', 'Adam V', 'Lydia M', 'Sara J', 'Bo B', 'Zed Z'])
  })
})
