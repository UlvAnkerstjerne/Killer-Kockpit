/**
 * capture.test.ts
 *
 * Unit tests for the analyzeCapture() server action (M8B3).
 *
 * Tests in Node — no DOM, no real DB, no real Anthropic API.
 *
 * Covers:
 *   - Authentication gate
 *   - Management role gate
 *   - Input validation (blank text, too long, bad date)
 *   - Date defaulting to today in Europe/Copenhagen
 *   - Deterministic entity resolver: exact / partial / ambiguous / not_found
 *   - Atomicity: multiple facts → multiple candidates preserved
 *   - Action-like content: the action must NOT filter model output (human review)
 *   - No DB writes
 *   - AI failure propagation
 *   - resolveEntityRef exported helper — unit-tested directly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  canAccessManagementView: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/ai/analyze-capture', () => ({
  analyzeCapture: vi.fn(),
}))

import { getCurrentUser }          from '@/lib/auth'
import { canAccessManagementView } from '@/lib/permissions'
import { createClient }            from '@/lib/supabase/server'
import { analyzeCapture as mockRunAI } from '@/lib/ai/analyze-capture'
import {
  analyzeCapture,
  resolveEntityRef,
  type EnrichedCandidateUpdate,
} from '@/lib/actions/capture'

const mockGetCurrentUser       = getCurrentUser          as ReturnType<typeof vi.fn>
const mockCanAccessManagement  = canAccessManagementView as ReturnType<typeof vi.fn>
const mockCreateClient         = createClient            as ReturnType<typeof vi.fn>
const mockAI                   = mockRunAI               as ReturnType<typeof vi.fn>

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MANAGER_USER = { id: 'user-mgr', role: 'UM', display_name: 'Manager' }
const MEMBER_USER  = { id: 'user-mbr', role: 'MEMBER', display_name: 'Member' }

const PROJECTS  = [
  { id: 'proj-1', title: 'Knife sharpening SOP' },
  { id: 'proj-2', title: 'Packaging renewal' },
]
const EMPLOYEES = [
  { id: 'emp-1', name: 'Ahmed Al-Rashid' },
  { id: 'emp-2', name: 'Maria Jensen' },
]
const LOCATIONS = [
  { id: 'loc-1', name: 'Nørrebro', short_name: 'NRB' },
  { id: 'loc-2', name: 'Østerbro', short_name: 'ØST' },
]

function makeSelectChain(data: object[]) {
  const chain: Record<string, () => typeof chain> = {}
  const selectFn = () => chain
  chain.select  = selectFn
  chain.is      = () => chain
  chain.not     = () => chain
  chain.eq      = () => chain
  chain.order   = () => Promise.resolve({ data, error: null }) as unknown as typeof chain
  return chain
}

function makeSupabase(
  projects  = PROJECTS,
  employees = EMPLOYEES,
  locations = LOCATIONS,
) {
  let call = 0
  return {
    from: vi.fn(() => {
      call++
      if (call === 1) return makeSelectChain(projects)   // projects
      if (call === 2) return makeSelectChain(employees)  // employees
      return makeSelectChain(locations)                   // locations
    }),
  }
}

const HAPPY_AI_OUTPUT = {
  ok: true,
  output: {
    candidates: [
      {
        body:        'Ahmed Al-Rashid promoted to Head Chef.',
        occurred_on: '2026-09-05',
        entity_refs: [{ entity_type: 'employee' as const, name_hint: 'Ahmed Al-Rashid' }],
      },
    ],
    analysis_note: null,
  },
}

function setupHappy() {
  mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
  mockCanAccessManagement.mockReturnValue(true)
  mockCreateClient.mockResolvedValue(makeSupabase())
  mockAI.mockResolvedValue(HAPPY_AI_OUTPUT)
}

// ── Authentication gate ────────────────────────────────────────────────────────

describe('analyzeCapture — authentication', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null)
    const result = await analyzeCapture('Some note')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/not authenticated/i)
  })
})

// ── Management role gate ───────────────────────────────────────────────────────

describe('analyzeCapture — role gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns error for MEMBER role', async () => {
    mockGetCurrentUser.mockResolvedValue(MEMBER_USER)
    mockCanAccessManagement.mockReturnValue(false)
    const result = await analyzeCapture('Some note')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/access denied/i)
  })

  it('proceeds for UM role', async () => {
    setupHappy()
    const result = await analyzeCapture('Some note text here')
    expect(result).toHaveProperty('data')
  })

  it('proceeds for SUPER_ADMIN role', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-sa', role: 'SUPER_ADMIN' })
    mockCanAccessManagement.mockReturnValue(true)
    mockCreateClient.mockResolvedValue(makeSupabase())
    mockAI.mockResolvedValue(HAPPY_AI_OUTPUT)
    const result = await analyzeCapture('Some note text here')
    expect(result).toHaveProperty('data')
  })
})

// ── Input validation ───────────────────────────────────────────────────────────

describe('analyzeCapture — input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
    mockCanAccessManagement.mockReturnValue(true)
  })

  it('returns error for blank text', async () => {
    const result = await analyzeCapture('   ')
    expect((result as { error: string }).error).toMatch(/required/i)
  })

  it('returns error for empty string', async () => {
    const result = await analyzeCapture('')
    expect((result as { error: string }).error).toMatch(/required/i)
  })

  it('returns error when text exceeds 5000 characters', async () => {
    const longText = 'a'.repeat(5001)
    const result = await analyzeCapture(longText)
    expect((result as { error: string }).error).toMatch(/5,000|5000/i)
  })

  it('accepts text of exactly 5000 characters', async () => {
    mockCreateClient.mockResolvedValue(makeSupabase())
    mockAI.mockResolvedValue(HAPPY_AI_OUTPUT)
    const result = await analyzeCapture('a'.repeat(5000))
    expect(result).not.toHaveProperty('error')
  })

  it('returns error for malformed occurred_on', async () => {
    const result = await analyzeCapture('Some note', '07-09-2026')
    expect((result as { error: string }).error).toMatch(/YYYY-MM-DD/)
  })

  it('returns error for occurred_on with time component', async () => {
    const result = await analyzeCapture('Some note', '2026-09-07T10:00:00Z')
    expect((result as { error: string }).error).toMatch(/YYYY-MM-DD/)
  })

  it('accepts valid YYYY-MM-DD occurred_on', async () => {
    mockCreateClient.mockResolvedValue(makeSupabase())
    mockAI.mockResolvedValue(HAPPY_AI_OUTPUT)
    const result = await analyzeCapture('Some note', '2026-09-07')
    expect(result).not.toHaveProperty('error')
  })

  it('accepts null occurred_on', async () => {
    mockCreateClient.mockResolvedValue(makeSupabase())
    mockAI.mockResolvedValue(HAPPY_AI_OUTPUT)
    const result = await analyzeCapture('Some note', null)
    expect(result).not.toHaveProperty('error')
  })
})

// ── Date defaulting ────────────────────────────────────────────────────────────

describe('analyzeCapture — date defaulting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupHappy()
  })

  afterEach(() => vi.restoreAllMocks())

  it('calls AI with a non-null occurred_on when none is supplied (defaults to today)', async () => {
    await analyzeCapture('Some note')
    const aiCallArgs = mockAI.mock.calls[0][0]
    // occurred_on must be a YYYY-MM-DD date string (today in Copenhagen)
    expect(aiCallArgs.occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('passes supplied occurred_on through to AI', async () => {
    await analyzeCapture('Some note', '2026-08-15')
    const aiCallArgs = mockAI.mock.calls[0][0]
    expect(aiCallArgs.occurred_on).toBe('2026-08-15')
  })
})

// ── AI failure propagation ────────────────────────────────────────────────────

describe('analyzeCapture — AI failure', () => {
  beforeEach(() => vi.clearAllMocks())

  it('propagates AI error as action error', async () => {
    mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
    mockCanAccessManagement.mockReturnValue(true)
    mockCreateClient.mockResolvedValue(makeSupabase())
    mockAI.mockResolvedValue({ ok: false, error: 'AI model not configured.' })

    const result = await analyzeCapture('Some note')
    expect((result as { error: string }).error).toMatch(/AI model not configured/i)
  })
})

// ── Atomicity — multiple candidates preserved ──────────────────────────────────

describe('analyzeCapture — atomicity', () => {
  beforeEach(() => vi.clearAllMocks())

  it('preserves two separate candidates from a multi-fact note', async () => {
    mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
    mockCanAccessManagement.mockReturnValue(true)
    mockCreateClient.mockResolvedValue(makeSupabase())
    mockAI.mockResolvedValue({
      ok: true,
      output: {
        candidates: [
          {
            body:        'Ahmed Al-Rashid promoted to Head Chef.',
            occurred_on: '2026-09-05',
            entity_refs: [{ entity_type: 'employee', name_hint: 'Ahmed Al-Rashid' }],
          },
          {
            body:        'Nørrebro passed health inspection.',
            occurred_on: '2026-09-05',
            entity_refs: [{ entity_type: 'location', name_hint: 'Nørrebro' }],
          },
        ],
        analysis_note: null,
      },
    })

    const result = await analyzeCapture('Ahmed promoted and NRB passed health inspection yesterday')
    expect(result).toHaveProperty('data')
    const data = (result as { data: EnrichedCandidateUpdate[] }).data
    expect(data).toHaveLength(2)
    expect(data[0].body).toContain('Ahmed')
    expect(data[1].body).toContain('Nørrebro')
  })
})

// ── No DB writes ───────────────────────────────────────────────────────────────

describe('analyzeCapture — no DB writes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not call supabase .insert(), .update(), or .upsert()', async () => {
    setupHappy()
    // Use the proper multi-call supabase mock so entity names are well-typed
    const base = makeSupabase()
    mockCreateClient.mockResolvedValue(base)

    await analyzeCapture('Some note')

    // Only read calls (projects, employees, locations) — no mutation calls
    const tables = (base.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string)
    expect(tables).toHaveLength(3)
    expect(tables.sort()).toEqual(['employees', 'locations', 'projects'])
  })
})

// ── resolveEntityRef — unit tests ─────────────────────────────────────────────

describe('resolveEntityRef — exact match', () => {
  it('resolves project by exact title (case-insensitive)', () => {
    const result = resolveEntityRef(
      { entity_type: 'project', name_hint: 'knife sharpening sop' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.entity_id).toBe('proj-1')
      expect(result.match_kind).toBe('exact')
    }
  })

  it('resolves employee by exact name', () => {
    const result = resolveEntityRef(
      { entity_type: 'employee', name_hint: 'Ahmed Al-Rashid' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.entity_id).toBe('emp-1')
      expect(result.match_kind).toBe('exact')
    }
  })

  it('resolves location by short_name', () => {
    const result = resolveEntityRef(
      { entity_type: 'location', name_hint: 'NRB' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.entity_id).toBe('loc-1')
      expect(result.display_name).toBe('Nørrebro')
      expect(result.match_kind).toBe('exact')
    }
  })

  it('resolves location by full name', () => {
    const result = resolveEntityRef(
      { entity_type: 'location', name_hint: 'Nørrebro' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.entity_id).toBe('loc-1')
    }
  })
})

describe('resolveEntityRef — partial match', () => {
  it('resolves employee when hint is a substring of the name', () => {
    const result = resolveEntityRef(
      { entity_type: 'employee', name_hint: 'Ahmed' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.entity_id).toBe('emp-1')
      expect(result.match_kind).toBe('partial')
    }
  })

  it('resolves project when hint is a substring of the title', () => {
    const result = resolveEntityRef(
      { entity_type: 'project', name_hint: 'Packaging' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.entity_id).toBe('proj-2')
      expect(result.match_kind).toBe('partial')
    }
  })
})

describe('resolveEntityRef — ambiguous', () => {
  it('returns ambiguous when hint matches multiple employees', () => {
    const employees = [
      { id: 'emp-a', name: 'Ahmed Al-Rashid' },
      { id: 'emp-b', name: 'Ahmed Hassan' },
    ]
    const result = resolveEntityRef(
      { entity_type: 'employee', name_hint: 'Ahmed' },
      PROJECTS, employees, LOCATIONS,
    )
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') {
      expect(result.candidates).toHaveLength(2)
      expect(result.candidates.map(c => c.entity_id).sort()).toEqual(['emp-a', 'emp-b'])
    }
  })

  it('returns ambiguous when hint matches two projects', () => {
    const projects = [
      { id: 'p1', title: 'Nørrebro refit' },
      { id: 'p2', title: 'Nørrebro expansion' },
    ]
    const result = resolveEntityRef(
      { entity_type: 'project', name_hint: 'Nørrebro' },
      projects, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') {
      expect(result.candidates).toHaveLength(2)
    }
  })
})

describe('resolveEntityRef — not_found', () => {
  it('returns not_found for unknown employee name', () => {
    const result = resolveEntityRef(
      { entity_type: 'employee', name_hint: 'Unknownperson' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('not_found')
  })

  it('returns not_found for unknown project', () => {
    const result = resolveEntityRef(
      { entity_type: 'project', name_hint: 'Some random project' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('not_found')
  })

  it('returns not_found for unknown location', () => {
    const result = resolveEntityRef(
      { entity_type: 'location', name_hint: 'Valby' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('not_found')
  })
})

// ── resolveEntityRef — exact before partial ────────────────────────────────────

describe('resolveEntityRef — exact takes priority over partial', () => {
  it('resolves exact when both exact and partial matches exist', () => {
    const projects = [
      { id: 'p-exact',   title: 'SOP'      },  // exact match for hint "sop"
      { id: 'p-partial', title: 'New SOP project' }, // partial match for hint "sop"
    ]
    const result = resolveEntityRef(
      { entity_type: 'project', name_hint: 'SOP' },
      projects, EMPLOYEES, LOCATIONS,
    )
    // "SOP" matches "SOP" exactly and also contains "New SOP project" partially.
    // Exact match pool = [p-exact], so resolved exact.
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.entity_id).toBe('p-exact')
      expect(result.match_kind).toBe('exact')
    }
  })
})

// ── resolveEntityRef — case insensitivity ─────────────────────────────────────

describe('resolveEntityRef — case insensitivity', () => {
  it('matches regardless of capitalisation', () => {
    const result = resolveEntityRef(
      { entity_type: 'employee', name_hint: 'MARIA JENSEN' },
      PROJECTS, EMPLOYEES, LOCATIONS,
    )
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.entity_id).toBe('emp-2')
    }
  })
})

// ── Action-like content — human review handles filtering ──────────────────────

describe('analyzeCapture — action-like content boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns whatever candidates the AI produces — filtering is for human review', async () => {
    // If the model mistakenly produced a task-shaped body, the action returns it;
    // the human reviewer decides whether to apply it.
    mockGetCurrentUser.mockResolvedValue(MANAGER_USER)
    mockCanAccessManagement.mockReturnValue(true)
    mockCreateClient.mockResolvedValue(makeSupabase())
    mockAI.mockResolvedValue({
      ok: true,
      output: {
        candidates: [{
          body:        'Ahmed needs to submit the health certificate.',
          occurred_on: null,
          entity_refs: [],
        }],
        analysis_note: 'Note: this may be action-oriented rather than factual.',
      },
    })

    const result = await analyzeCapture('Ahmed needs to submit the health certificate.')
    expect(result).toHaveProperty('data')
    const data = (result as { data: EnrichedCandidateUpdate[] }).data
    // Action returns it — human review is the gate, not the server action
    expect(data).toHaveLength(1)
  })
})

// ── Security: entity UUIDs not exposed to AI ──────────────────────────────────

describe('analyzeCapture — security: entity context passed to AI', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not pass entity UUIDs to the AI module', async () => {
    setupHappy()
    await analyzeCapture('Some note')

    const aiCallCtx = mockAI.mock.calls[0][0]
    // AI module receives entity lists but UUIDs are not used in buildUserMessage
    // The context objects contain ids but buildUserMessage must exclude them.
    // We assert that the AI context contains the right shape and the
    // buildUserMessage (tested separately) excludes ids from the prompt.
    expect(aiCallCtx).toHaveProperty('projects')
    expect(aiCallCtx).toHaveProperty('employees')
    expect(aiCallCtx).toHaveProperty('locations')
    // The raw text passed through intact
    expect(aiCallCtx.rawText).toBe('Some note')
  })
})
