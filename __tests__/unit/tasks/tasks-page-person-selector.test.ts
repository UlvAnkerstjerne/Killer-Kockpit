/**
 * /tasks — team-member selector (no "Everyone's" / "All").
 * Renders the real page with a call-recording Supabase mock.
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
  taskListProps: null as null | { tasks: object[]; currentUser: { id: string; role: string } },
}))

vi.mock('@/lib/auth', () => ({
  getCurrentUser: async () => mocks.user,
  getActiveUsers: async () => [{ id: U.ulv, display_name: 'Ulv Ankerstjerne', email: 'u' }],
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
          data: table === 'tasks' ? [{ id: 't1', owner_user_id: U.ulv }, { id: 't2', owner_user_id: U.adam }, { id: 't3', owner_user_id: U.adam }] : [
            // active management users (Shuhei, a MEMBER, is not returned by the role filter)
            { id: U.sara, display_name: 'Sara Jørgensen' }, { id: U.lydia, display_name: 'Lydia Mertiri' },
            { id: U.adam, display_name: 'Adam Vearey' }, { id: U.ulv, display_name: 'Ulv Ankerstjerne' },
            { id: U.kasper, display_name: 'Kasper Kristiansen' },
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
    return createElement('div', null, `${props.tasks.length} tasks`)
  },
}))

import TasksPage from '@/app/(app)/tasks/page'
import {
  tasksHref, sanitizeOwnerParam, sanitizeStatusParam, orderPeople, resolveSelectedOwner, firstName,
} from '@/lib/tasks/tasks-url'
import { canEditTaskTerms } from '@/lib/permissions'

const ulv    = { id: U.ulv, role: 'SUPER_ADMIN', display_name: 'Ulv Ankerstjerne', email: 'u', active: true }
const lydia  = { id: U.lydia, role: 'UM', display_name: 'Lydia Mertiri', email: 'l', active: true }
const shuhei = { id: U.shuhei, role: 'MEMBER', display_name: 'Shuhei Kusanagi', email: 'sh', active: true }

async function render(params: Record<string, string> = {}) {
  const el = await TasksPage({ searchParams: Promise.resolve(params) })
  return renderToStaticMarkup(el as never)
}
const ownerEq = () => mocks.calls.filter(c => c.table === 'tasks' && c.op === 'eq' && c.args[0] === 'owner_user_id').map(c => c.args[1])
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'))
const pillLabels = (html: string) => {
  const nav = html.slice(html.indexOf('aria-label="Team member"'))
  return [...nav.slice(0, nav.indexOf('</nav>')).matchAll(/>([^<]+)<\/a>/g)].map(m => m[1])
}

beforeEach(() => {
  mocks.calls.length = 0
  mocks.taskListProps = null
  mocks.user = ulv
})

describe('default: the signed-in user', () => {
  it('queries only their own tasks, with their own pill active', async () => {
    const html = await render()
    expect(ownerEq()).toEqual([U.ulv])
    const active = html.match(/aria-current="page"[^>]*>([^<]+)</)
    expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>Ulv<`))
    expect(active).not.toBeNull()
  })

  it('works for any management user (Lydia is selected when Lydia signs in)', async () => {
    mocks.user = lydia
    const html = await render()
    expect(ownerEq()).toEqual([U.lydia])
    expect(html).toMatch(/aria-current="page"[^>]*>Lydia</)
  })
})

describe('team selector', () => {
  it('lists the active management team by first name in order — no All, no Everyone\'s, no toggle', async () => {
    const html = await render()
    expect(pillLabels(html)).toEqual(['Ulv', 'Kasper', 'Adam', 'Lydia', 'Sara'])
    expect(html).not.toMatch(/Everyone/i)
    expect(html).not.toMatch(/>All</)
    expect(html).not.toMatch(/My tasks/)
    expect(html).not.toContain('aria-label="Tasks view"')
    expect(html).not.toContain('Shuhei')
  })

  it('the people query is limited to active management roles and uses no hardcoded ids', async () => {
    await render()
    const people = mocks.calls.filter(c => c.table === 'app_users')
    expect(people.find(c => c.op === 'eq')?.args).toEqual(['active', true])
    expect(people.find(c => c.op === 'in')?.args).toEqual(['role', ['SUPER_ADMIN', 'UM']])
    const src = (await import('node:fs')).readFileSync('app/(app)/tasks/page.tsx', 'utf8')
    expect(src).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })

  it('clicking a name filters to that person; the link carries only owner (and status)', async () => {
    const h = hrefs(await render())
    expect(h).toContain(`/tasks?owner=${U.adam}`)
    expect(h).toContain(`/tasks?owner=${U.sara}`)
    expect(h).toContain('/tasks') // Ulv = own view: no owner param
    mocks.calls.length = 0
    const html = await render({ owner: U.adam })
    expect(ownerEq()).toEqual([U.adam])
    expect(html).toMatch(/aria-current="page"[^>]*>Adam</)
    expect(html).not.toMatch(/aria-current="page"[^>]*>Ulv</)
  })

  it('does not rely on ?view=management', async () => {
    await render({ view: 'management' })
    expect(ownerEq()).toEqual([U.ulv]) // view param has no effect
    const src = (await import('node:fs')).readFileSync('app/(app)/tasks/page.tsx', 'utf8')
    expect(src).not.toMatch(/view=management|resolveView/)
  })
})

describe('status filters keep the selected person (and vice versa)', () => {
  it('status tabs preserve the owner', async () => {
    const h = hrefs(await render({ owner: U.adam, status: 'blocked' }))
    expect(h).toContain(`/tasks?owner=${U.adam}`)                    // Active
    expect(h).toContain(`/tasks?owner=${U.adam}&status=open`)
    expect(h).toContain(`/tasks?owner=${U.adam}&status=in_progress`)
    expect(h).toContain(`/tasks?owner=${U.adam}&status=done`)
  })

  it('name pills preserve the status; Ulv\'s pill drops only the owner', async () => {
    const h = hrefs(await render({ owner: U.adam, status: 'blocked' }))
    expect(h).toContain(`/tasks?owner=${U.sara}&status=blocked`)
    expect(h).toContain(`/tasks?owner=${U.kasper}&status=blocked`)
    expect(h).toContain('/tasks?status=blocked')
  })

  it('applies the status filter together with the owner filter', async () => {
    await render({ owner: U.adam, status: 'blocked' })
    expect(ownerEq()).toEqual([U.adam])
    expect(mocks.calls.some(c => c.table === 'tasks' && c.op === 'eq' && c.args[0] === 'status' && c.args[1] === 'blocked')).toBe(true)
  })

  it('hides done/cancelled by default', async () => {
    await render()
    expect(mocks.calls.find(c => c.table === 'tasks' && c.op === 'not')?.args).toEqual(['status', 'in', '("done","cancelled")'])
  })
})

describe('non-management users', () => {
  it('see no selector and cannot view anyone else via ?owner=', async () => {
    mocks.user = shuhei
    for (const params of [{}, { owner: U.sara }, { owner: U.adam, status: 'open' }] as Record<string, string>[]) {
      mocks.calls.length = 0
      const html = await render(params)
      expect(html).not.toContain('aria-label="Team member"')
      expect(ownerEq()).toEqual([U.shuhei])
      expect(mocks.calls.some(c => c.table === 'app_users')).toBe(false)
    }
  })

  it('a manager cannot pick a non-management user or garbage via the URL either', async () => {
    for (const owner of [U.shuhei, "x' or 1=1 --", '']) {
      mocks.calls.length = 0
      await render({ owner })
      expect(ownerEq()).toEqual([U.ulv])
    }
  })
})

describe('heading and + Task pill', () => {
  it('puts "+ Task" beside the heading (not pushed to the far right) and keeps its action', async () => {
    const html = await render()
    const row = html.slice(html.indexOf('<h1'), html.indexOf('</div>', html.indexOf('<h1')))
    expect(row).toContain('Tasks')
    expect(row).toContain('href="/tasks/new"')
    expect(row).toContain('rounded-full')
    expect(html).not.toMatch(/justify-between[^"]*"><h1/)
  })

  it('every user (managers and members) still gets the pill', async () => {
    mocks.user = shuhei
    expect(await render()).toContain('href="/tasks/new"')
  })
})

describe('records shown', () => {
  it("shows only the selected person's tasks even if the read returned more (RLS leak safety net)", async () => {
    await render({ owner: U.adam })
    expect(mocks.taskListProps?.tasks.map(t => (t as { id: string }).id)).toEqual(['t2', 't3'])
    await render()
    expect(mocks.taskListProps?.tasks.map(t => (t as { id: string }).id)).toEqual(['t1'])
  })
})

describe('permissions and RLS unchanged', () => {
  it('the query is user-scoped (no service client) and TaskList still gets the signed-in user', async () => {
    await render({ owner: U.adam })
    expect(mocks.taskListProps?.currentUser).toMatchObject({ id: U.ulv, role: 'SUPER_ADMIN' })
    const src = (await import('node:fs')).readFileSync('app/(app)/tasks/page.tsx', 'utf8')
    expect(src).not.toMatch(/createServiceClient/)
  })

  it("viewing someone's task does not grant edit rights", () => {
    expect(canEditTaskTerms('UM', U.sara, U.lydia)).toBe(false)
    expect(canEditTaskTerms('UM', U.lydia, U.lydia)).toBe(true)
    expect(canEditTaskTerms('SUPER_ADMIN', U.sara, U.ulv)).toBe(true) // existing admin override, unchanged
    expect(canEditTaskTerms('MEMBER', U.sara, U.shuhei)).toBe(false)
  })
})

describe('selector helpers', () => {
  const people = [{ id: U.adam, display_name: 'Adam Vearey' }, { id: U.ulv, display_name: 'Ulv A' }]

  it('resolveSelectedOwner', () => {
    const base = { currentUserId: U.ulv, people }
    expect(resolveSelectedOwner({ ...base, isManagement: true, ownerParam: U.adam })).toBe(U.adam)
    expect(resolveSelectedOwner({ ...base, isManagement: true, ownerParam: U.adam.toUpperCase() })).toBe(U.adam)
    expect(resolveSelectedOwner({ ...base, isManagement: true, ownerParam: U.sara })).toBe(U.ulv) // not in list
    expect(resolveSelectedOwner({ ...base, isManagement: true, ownerParam: null })).toBe(U.ulv)
    expect(resolveSelectedOwner({ ...base, isManagement: false, ownerParam: U.adam })).toBe(U.ulv)
  })

  it('builds /tasks URLs', () => {
    expect(tasksHref({})).toBe('/tasks')
    expect(tasksHref({ owner: U.adam })).toBe(`/tasks?owner=${U.adam}`)
    expect(tasksHref({ owner: U.adam, status: 'blocked' })).toBe(`/tasks?owner=${U.adam}&status=blocked`)
    expect(tasksHref({ status: 'blocked' })).toBe('/tasks?status=blocked')
  })

  it('sanitises params, orders people and shortens names', () => {
    expect(sanitizeOwnerParam(U.sara.toUpperCase())).toBe(U.sara)
    expect(sanitizeOwnerParam('nope')).toBeNull()
    expect(sanitizeStatusParam('blocked')).toBe('blocked')
    expect(sanitizeStatusParam('drop table')).toBeNull()
    const names = orderPeople(['Sara J', 'Zed Z', 'Lydia M', 'Ulv A', 'Adam V', 'Kasper K'].map(display_name => ({ display_name })))
    expect(names.map(n => firstName(n.display_name))).toEqual(['Ulv', 'Kasper', 'Adam', 'Lydia', 'Sara', 'Zed'])
  })
})
