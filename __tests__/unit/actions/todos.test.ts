/**
 * Unit tests for lib/actions/todos.ts server actions.
 *
 * Security invariants tested:
 *   - All mutations reject unauthenticated callers.
 *   - createTodo validates title and priority before hitting the DB.
 *   - All mutations pass .eq('user_id', user.id) — belt-and-suspenders over RLS.
 *   - No caller-supplied user_id is accepted; ownership is always server-derived.
 *
 * Test matrix (20 cases):
 *   [1-9]   createTodo — validation, success, DB error, revalidation
 *   [10-13] completeTodo — auth, success, user_id scoping, DB error
 *   [14-17] cancelTodo — auth, success, user_id scoping, DB error
 *   [18-20] reopenTodo — auth, success, revalidation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockGetCurrentUser = vi.fn()
  const mockRevalidatePath = vi.fn()

  // insert chain: .insert({}).select('id').single()
  const mockSingle = vi.fn()
  const mockSelect = vi.fn().mockReturnValue({ single: mockSingle })
  const mockInsert = vi.fn().mockReturnValue({ select: mockSelect })

  // update chain: .update({}).eq('id', id).eq('user_id', uid)
  // mockEq is used for both .eq() calls — see beforeEach for chain setup
  const mockEq = vi.fn()
  const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq })

  const mockFrom = vi.fn().mockReturnValue({
    insert: mockInsert,
    update: mockUpdate,
  })
  const mockClient = { from: mockFrom }

  return {
    mockGetCurrentUser,
    mockRevalidatePath,
    mockSingle,
    mockSelect,
    mockInsert,
    mockEq,
    mockUpdate,
    mockFrom,
    mockClient,
  }
})

vi.mock('@/lib/auth', () => ({ getCurrentUser: mocks.mockGetCurrentUser }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.mockRevalidatePath }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mocks.mockClient),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = {
  id: 'user-uuid-1',
  role: 'MEMBER' as const,
  display_name: 'Test User',
  email: 'test@example.com',
}

const TODO_ID = 'todo-uuid-1'

// ---------------------------------------------------------------------------
// Import actions (after mocks are set up)
// ---------------------------------------------------------------------------

import { createTodo, completeTodo, cancelTodo, reopenTodo } from '@/lib/actions/todos'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupAuth(user: typeof USER | null = USER) {
  mocks.mockGetCurrentUser.mockResolvedValue(user)
}

function setupInsertSuccess() {
  mocks.mockSingle.mockResolvedValue({ data: { id: TODO_ID }, error: null })
}

function setupInsertError() {
  mocks.mockSingle.mockResolvedValue({ data: null, error: { message: 'DB error' } })
}

/**
 * The update chain is .update({}).eq('id', id).eq('user_id', uid).
 * Both .eq() calls go through mockEq. The first must return { eq: mockEq }
 * so chaining continues; the second (awaited) must resolve to { error }.
 */
function setupUpdateSuccess() {
  mocks.mockEq
    .mockReturnValueOnce({ eq: mocks.mockEq }) // first .eq('id', id) → keeps chain
    .mockResolvedValue({ error: null })          // second .eq('user_id', uid) → awaited
}

function setupUpdateError() {
  mocks.mockEq
    .mockReturnValueOnce({ eq: mocks.mockEq })
    .mockResolvedValue({ error: { message: 'DB error' } })
}

beforeEach(() => {
  vi.clearAllMocks()

  // Restore mock chain implementations cleared by clearAllMocks
  mocks.mockFrom.mockReturnValue({ insert: mocks.mockInsert, update: mocks.mockUpdate })
  mocks.mockInsert.mockReturnValue({ select: mocks.mockSelect })
  mocks.mockSelect.mockReturnValue({ single: mocks.mockSingle })
  mocks.mockUpdate.mockReturnValue({ eq: mocks.mockEq })
  // mockEq base: returns { eq: mockEq } for chaining; overridden per-test
  mocks.mockEq.mockReturnValue({ eq: mocks.mockEq })
})

// ---------------------------------------------------------------------------
// createTodo
// ---------------------------------------------------------------------------

describe('createTodo', () => {
  it('[1] returns error when user is not authenticated', async () => {
    setupAuth(null)
    const result = await createTodo('Buy milk')
    expect(result.error).toBeTruthy()
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('[2] returns error for blank title', async () => {
    setupAuth()
    const result = await createTodo('   ')
    expect(result.error).toBeTruthy()
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('[3] returns error for priority out of range', async () => {
    setupAuth()
    const result = await createTodo('Valid title', 5)
    expect(result.error).toBeTruthy()
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('[4] returns error for non-integer priority', async () => {
    setupAuth()
    const result = await createTodo('Valid title', 1.5)
    expect(result.error).toBeTruthy()
    expect(mocks.mockFrom).not.toHaveBeenCalled()
  })

  it('[5] succeeds and returns the new todo id', async () => {
    setupAuth()
    setupInsertSuccess()
    const result = await createTodo('Buy milk', 2)
    expect(result.error).toBeUndefined()
    expect(result.data?.id).toBe(TODO_ID)
  })

  it('[6] trims whitespace from the title before inserting', async () => {
    setupAuth()
    setupInsertSuccess()
    await createTodo('  Buy milk  ', 2)
    const insertArg = mocks.mockInsert.mock.calls[0][0]
    expect(insertArg.title).toBe('Buy milk')
  })

  it('[7] inserts with the server-derived user_id (never caller-supplied)', async () => {
    setupAuth()
    setupInsertSuccess()
    await createTodo('Task', 1)
    const insertArg = mocks.mockInsert.mock.calls[0][0]
    expect(insertArg.user_id).toBe(USER.id)
  })

  it('[8] returns error when DB insert fails', async () => {
    setupAuth()
    setupInsertError()
    const result = await createTodo('Buy milk', 2)
    expect(result.error).toBeTruthy()
  })

  it('[9] calls revalidatePath for /today and /todos on success', async () => {
    setupAuth()
    setupInsertSuccess()
    await createTodo('Buy milk', 2)
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/today')
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/todos')
  })
})

// ---------------------------------------------------------------------------
// completeTodo
// ---------------------------------------------------------------------------

describe('completeTodo', () => {
  it('[10] returns error when user is not authenticated', async () => {
    setupAuth(null)
    const result = await completeTodo(TODO_ID)
    expect(result.error).toBeTruthy()
  })

  it('[11] succeeds for an authenticated user', async () => {
    setupAuth()
    setupUpdateSuccess()
    const result = await completeTodo(TODO_ID)
    expect(result.error).toBeUndefined()
  })

  it('[12] passes .eq("user_id", user.id) to scope the update', async () => {
    setupAuth()
    setupUpdateSuccess()
    await completeTodo(TODO_ID)
    const eqCols = mocks.mockEq.mock.calls.map((args: unknown[]) => args[0])
    expect(eqCols).toContain('user_id')
  })

  it('[13] returns error when DB update fails', async () => {
    setupAuth()
    setupUpdateError()
    const result = await completeTodo(TODO_ID)
    expect(result.error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// cancelTodo
// ---------------------------------------------------------------------------

describe('cancelTodo', () => {
  it('[14] returns error when user is not authenticated', async () => {
    setupAuth(null)
    const result = await cancelTodo(TODO_ID)
    expect(result.error).toBeTruthy()
  })

  it('[15] succeeds for an authenticated user', async () => {
    setupAuth()
    setupUpdateSuccess()
    const result = await cancelTodo(TODO_ID)
    expect(result.error).toBeUndefined()
  })

  it('[16] passes .eq("user_id", user.id) to scope the update', async () => {
    setupAuth()
    setupUpdateSuccess()
    await cancelTodo(TODO_ID)
    const eqCols = mocks.mockEq.mock.calls.map((args: unknown[]) => args[0])
    expect(eqCols).toContain('user_id')
  })

  it('[17] returns error when DB update fails', async () => {
    setupAuth()
    setupUpdateError()
    const result = await cancelTodo(TODO_ID)
    expect(result.error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// reopenTodo
// ---------------------------------------------------------------------------

describe('reopenTodo', () => {
  it('[18] returns error when user is not authenticated', async () => {
    setupAuth(null)
    const result = await reopenTodo(TODO_ID)
    expect(result.error).toBeTruthy()
  })

  it('[19] succeeds for an authenticated user', async () => {
    setupAuth()
    setupUpdateSuccess()
    const result = await reopenTodo(TODO_ID)
    expect(result.error).toBeUndefined()
  })

  it('[20] calls revalidatePath for /today and /todos on success', async () => {
    setupAuth()
    setupUpdateSuccess()
    await reopenTodo(TODO_ID)
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/today')
    expect(mocks.mockRevalidatePath).toHaveBeenCalledWith('/todos')
  })
})
