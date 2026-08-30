/**
 * Tests for lib/ai/generate-meeting-draft.ts
 *
 * Coverage:
 *   • PROMPT_VERSION is a non-empty string
 *   • generateDraftFromContext:
 *     - Missing env vars → error (no API call)
 *     - countTokens failure → error (no generation call)
 *     - Context too large → error (no generation call)
 *     - Successful generation → typed output returned
 *     - Model returns no parsed_output → error (no draft row)
 *     - Zod validation failure → error (no draft row)
 *     - API failure during generation → error
 *     - Attendee names included but NOT emails/UUIDs
 *     - Transcript prompt injection labelled as untrusted source
 *     - Normalised transcript sent (not raw VTT)
 *     - Null fileName (paste) → plain-text pass-through
 *     - working_notes preserved in context sent to model
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock Anthropic SDK ───────────────────────────────────────────────────────

const mockCountTokens  = vi.fn()
const mockParse        = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(function MockAnthropic() {
      return {
        messages: {
          countTokens: mockCountTokens,
          parse:       mockParse,
        },
      }
    }),
  }
})

vi.mock('@anthropic-ai/sdk/helpers/zod', () => ({
  zodOutputFormat: vi.fn().mockReturnValue({ __isMockFormat: true }),
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_OUTPUT = {
  minutes:     'The team discussed project status.',
  tasks:       [{ title: 'Write report', description: null, owner_display_name: 'Alice', suggested_due: null, deadline_evidence: null, project_hint: null, priority_hint: null }],
  decisions:   [{ title: 'Adopt new framework', decision_text: 'The team agreed to adopt it.', rationale: null }],
  waiting_ons: [{ title: 'Waiting for approval', waiting_for: 'Legal team', owner_display_name: 'Bob', suggested_due: null, deadline_evidence: null, notes: null }],
}

const BASE_CTX = {
  meetingTitle:       'Weekly Sync',
  scheduledStart:     '2026-08-29T10:00:00Z',
  projectTitle:       'Alpha',
  attendeeNames:      ['Alice Smith', 'Bob Jones'],
  workingNotes:       'Discussed roadmap.',
  transcriptContent:  'Alice: Hello everyone.\nBob: Hi Alice.',
  transcriptFileName: 'standup.txt',
}

import { generateDraftFromContext, PROMPT_VERSION } from '@/lib/ai/generate-meeting-draft'

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PROMPT_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof PROMPT_VERSION).toBe('string')
    expect(PROMPT_VERSION.length).toBeGreaterThan(0)
  })
})

describe('generateDraftFromContext', () => {
  const OLD_ENV = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MEETING_AI_MODEL = 'claude-sonnet-4-6'
    process.env.ANTHROPIC_API_KEY = 'test-key'

    // Default mocks for happy-path
    mockCountTokens.mockResolvedValue({ input_tokens: 1_000 })
    mockParse.mockResolvedValue({ parsed_output: VALID_OUTPUT, stop_reason: 'end_turn' })
  })

  afterEach(() => {
    process.env = { ...OLD_ENV }
  })

  // ── Environment guards ──────────────────────────────────────────────────────

  it('returns error when MEETING_AI_MODEL is not set', async () => {
    delete process.env.MEETING_AI_MODEL
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/model.*not configured/i)
    expect(mockCountTokens).not.toHaveBeenCalled()
    expect(mockParse).not.toHaveBeenCalled()
  })

  it('returns error when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not configured/i)
    expect(mockCountTokens).not.toHaveBeenCalled()
  })

  // ── Context size ────────────────────────────────────────────────────────────

  it('returns error and calls no generation when countTokens fails', async () => {
    mockCountTokens.mockRejectedValue(new Error('Network error'))
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/failed to reach/i)
    expect(mockParse).not.toHaveBeenCalled()
  })

  it('returns error when context is too large and does not call generation', async () => {
    // Simulate input_tokens exceeding limit (200,000 - 8,192 = 191,808)
    mockCountTokens.mockResolvedValue({ input_tokens: 195_000 })
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/too long/i)
      expect(result.error).toContain('195,000')
    }
    expect(mockParse).not.toHaveBeenCalled()
  })

  // ── Successful generation ───────────────────────────────────────────────────

  it('returns typed output on success', async () => {
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output.minutes).toBe(VALID_OUTPUT.minutes)
      expect(result.output.tasks).toHaveLength(1)
      expect(result.output.decisions).toHaveLength(1)
      expect(result.output.waiting_ons).toHaveLength(1)
      expect(result.model).toBe('claude-sonnet-4-6')
      expect(result.inputCharCount).toBeGreaterThan(0)
    }
  })

  // ── Model output failures ───────────────────────────────────────────────────

  it('returns error when model returns no parsed_output', async () => {
    mockParse.mockResolvedValue({ parsed_output: null, stop_reason: 'max_tokens' })
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/did not return.*valid/i)
  })

  it('returns error when parsed_output fails Zod validation', async () => {
    mockParse.mockResolvedValue({
      parsed_output: { minutes: 123, tasks: 'bad' }, // wrong types
      stop_reason: 'end_turn',
    })
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/unexpected output/i)
  })

  it('returns error when model call throws', async () => {
    mockParse.mockRejectedValue(new Error('API rate limit'))
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/failed/i)
  })

  // ── Prompt content checks ───────────────────────────────────────────────────

  it('includes attendee display names in the user message', async () => {
    await generateDraftFromContext(BASE_CTX)

    const callArgs = mockParse.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    expect(userContent).toContain('Alice Smith')
    expect(userContent).toContain('Bob Jones')
  })

  it('does NOT include emails or UUIDs in the user message', async () => {
    const ctx = {
      ...BASE_CTX,
      attendeeNames: ['Alice Smith'], // only display names
    }
    await generateDraftFromContext(ctx)

    const callArgs = mockParse.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    // No UUID patterns (8-4-4-4-12 hex)
    expect(userContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    // No email patterns
    expect(userContent).not.toMatch(/\S+@\S+\.\S+/)
  })

  it('labels the transcript as untrusted source material in the user message', async () => {
    await generateDraftFromContext(BASE_CTX)
    const callArgs = mockParse.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    // The prompt injection warning label must appear
    expect(userContent.toLowerCase()).toContain('untrusted source material')
  })

  it('includes transcript prompt-injection protection in the system prompt', async () => {
    await generateDraftFromContext(BASE_CTX)
    const callArgs = mockParse.mock.calls[0][0]
    const systemPrompt = callArgs.system as string
    expect(systemPrompt.toLowerCase()).toContain('untrusted source material')
    expect(systemPrompt.toLowerCase()).toContain('cannot override')
  })

  it('instructs the model to use exact attendee display names without shortening', async () => {
    // Regression: model was outputting speaker-label abbreviations (e.g. "Adam")
    // instead of the full attendee display name (e.g. "Adam Fullname").
    // The system prompt must explicitly require exact full names from the attendee list.
    await generateDraftFromContext(BASE_CTX)
    const callArgs = mockParse.mock.calls[0][0]
    const systemPrompt = callArgs.system as string
    // Must tell the model to use exact name from attendee list
    expect(systemPrompt.toLowerCase()).toContain('exact')
    // Must prohibit shortening/abbreviating
    expect(systemPrompt.toLowerCase()).toMatch(/shorten|abbreviat/)
    // Must include the concrete example pattern that guided the fix
    expect(systemPrompt).toContain('owner_display_name')
  })

  it('sends working notes to the model', async () => {
    await generateDraftFromContext({ ...BASE_CTX, workingNotes: 'Important notes here' })
    const callArgs = mockParse.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    expect(userContent).toContain('Important notes here')
  })

  it('sends meeting title and project to the model', async () => {
    await generateDraftFromContext(BASE_CTX)
    const callArgs = mockParse.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    expect(userContent).toContain('Weekly Sync')
    expect(userContent).toContain('Alpha')
  })

  // ── Transcript normalisation ────────────────────────────────────────────────

  it('normalises VTT transcript before sending to model', async () => {
    const vttTranscript = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Alice>Hello world</v>

00:00:05.000 --> 00:00:08.000
<v Bob>Goodbye</v>`

    await generateDraftFromContext({
      ...BASE_CTX,
      transcriptContent:  vttTranscript,
      transcriptFileName: 'meeting.vtt',
    })

    const callArgs = mockParse.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    // VTT metadata stripped; speaker preserved
    expect(userContent).not.toContain('WEBVTT')
    expect(userContent).not.toContain('-->')
    expect(userContent).toContain('Alice:')
    expect(userContent).toContain('Bob:')
  })

  it('sends plain text as-is for paste (null fileName)', async () => {
    const pasteText = 'Alice: Good morning everyone.\nBob: Let us begin.'

    await generateDraftFromContext({
      ...BASE_CTX,
      transcriptContent:  pasteText,
      transcriptFileName: null,
    })

    const callArgs = mockParse.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    expect(userContent).toContain('Alice: Good morning everyone.')
    expect(userContent).toContain('Bob: Let us begin.')
  })

  it('shows "(None)" when working notes are absent', async () => {
    await generateDraftFromContext({ ...BASE_CTX, workingNotes: null })
    const callArgs = mockParse.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    expect(userContent).toContain('(None)')
  })

  // ── v3 prompt: task existence vs owner resolution ───────────────────────────

  it('v3: system prompt explicitly states task existence is independent of owner resolution', async () => {
    await generateDraftFromContext(BASE_CTX)
    const systemPrompt = mockParse.mock.calls[0][0].system as string
    // Must contain the independence rule in some form
    expect(systemPrompt).toMatch(/independent/i)
    expect(systemPrompt).toMatch(/owner.*resolut|resolut.*owner/i)
  })

  it('v3: system prompt says never discard a task due to owner resolution failure', async () => {
    await generateDraftFromContext(BASE_CTX)
    const systemPrompt = mockParse.mock.calls[0][0].system as string
    expect(systemPrompt).toMatch(/never discard.*task|discard.*valid.*task/i)
  })

  it('v3: system prompt instructs suppression of tasks from hypothetical or test language', async () => {
    await generateDraftFromContext(BASE_CTX)
    const systemPrompt = mockParse.mock.calls[0][0].system as string
    expect(systemPrompt).toMatch(/hypothetical|illustrative|test.*scenario/i)
    expect(systemPrompt).toMatch(/not.*making.*real commitment|not.*commitment/i)
  })

  it('v3: system prompt clarifies that owner name rule governs the field value only', async () => {
    await generateDraftFromContext(BASE_CTX)
    const systemPrompt = mockParse.mock.calls[0][0].system as string
    // Should say this rule is about the field value, not task existence
    expect(systemPrompt).toMatch(/field value|field only|governs.*field/i)
  })

  it('PROMPT_VERSION is v3', () => {
    expect(PROMPT_VERSION).toBe('v3')
  })

  // ── Context size edge cases ─────────────────────────────────────────────────

  it('accepts input just within the safe limit', async () => {
    mockCountTokens.mockResolvedValue({ input_tokens: 191_807 }) // 200,000 - 8,192 - 1
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(true)
    expect(mockParse).toHaveBeenCalled()
  })

  it('rejects input exactly at the safe limit boundary', async () => {
    mockCountTokens.mockResolvedValue({ input_tokens: 191_809 }) // 200,000 - 8,192 + 1
    const result = await generateDraftFromContext(BASE_CTX)
    expect(result.ok).toBe(false)
    expect(mockParse).not.toHaveBeenCalled()
  })
})
