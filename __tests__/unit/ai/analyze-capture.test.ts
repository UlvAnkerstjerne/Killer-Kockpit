/**
 * analyze-capture.test.ts
 *
 * Tests for the prompt builder and module contracts of analyzeCapture().
 * Runs in Node — we test buildUserMessage() directly and the analyzer's
 * error paths via mocks.  Real Anthropic API calls are not made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildUserMessage, SYSTEM_PROMPT, type CaptureAnalysisContext } from '@/lib/ai/analyze-capture'

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_CTX: CaptureAnalysisContext = {
  rawText:       'Ahmed has been promoted to Head Chef at Nørrebro.',
  occurred_on:   '2026-09-05',
  referenceDate: '2026-09-06',
  projects:  [
    { id: 'proj-1', title: 'Knife sharpening SOP' },
    { id: 'proj-2', title: 'Packaging renewal' },
  ],
  employees: [
    { id: 'emp-1', name: 'Ahmed Al-Rashid' },
    { id: 'emp-2', name: 'Maria Jensen' },
  ],
  locations: [
    { id: 'loc-1', name: 'Nørrebro',  short_name: 'NRB' },
    { id: 'loc-2', name: 'Østerbro',  short_name: 'ØST' },
  ],
}

// ── buildUserMessage — prompt safety ──────────────────────────────────────────

describe('buildUserMessage — UNTRUSTED delimiter', () => {
  it('includes the UNTRUSTED SOURCE MATERIAL label before the note', () => {
    const msg = buildUserMessage(BASE_CTX)
    expect(msg).toMatch(/UNTRUSTED SOURCE MATERIAL/i)
  })

  it('wraps the raw note text between --- delimiters', () => {
    const msg = buildUserMessage(BASE_CTX)
    const delimIdx = msg.indexOf('---')
    expect(delimIdx).toBeGreaterThan(-1)
    // The note text should appear between two --- lines
    expect(msg).toContain('---\n' + BASE_CTX.rawText.trim())
  })

  it('puts the raw text AFTER the UNTRUSTED label', () => {
    const msg = buildUserMessage(BASE_CTX)
    const labelIdx = msg.indexOf('UNTRUSTED SOURCE MATERIAL')
    const noteIdx  = msg.indexOf(BASE_CTX.rawText.trim())
    expect(noteIdx).toBeGreaterThan(labelIdx)
  })
})

// ── buildUserMessage — entity grounding — names only, no UUIDs ───────────────

describe('buildUserMessage — entity grounding', () => {
  it('includes project titles in the message', () => {
    const msg = buildUserMessage(BASE_CTX)
    expect(msg).toContain('Knife sharpening SOP')
    expect(msg).toContain('Packaging renewal')
  })

  it('includes employee names in the message', () => {
    const msg = buildUserMessage(BASE_CTX)
    expect(msg).toContain('Ahmed Al-Rashid')
    expect(msg).toContain('Maria Jensen')
  })

  it('includes location names and short_names in the message', () => {
    const msg = buildUserMessage(BASE_CTX)
    expect(msg).toContain('Nørrebro')
    expect(msg).toContain('NRB')
    expect(msg).toContain('Østerbro')
  })

  it('does NOT include entity UUIDs in the message', () => {
    const msg = buildUserMessage(BASE_CTX)
    expect(msg).not.toContain('proj-1')
    expect(msg).not.toContain('emp-1')
    expect(msg).not.toContain('loc-1')
  })

  it('omits the projects line when projects array is empty', () => {
    const msg = buildUserMessage({ ...BASE_CTX, projects: [] })
    expect(msg).not.toMatch(/Known projects/i)
  })

  it('omits the employees line when employees array is empty', () => {
    const msg = buildUserMessage({ ...BASE_CTX, employees: [] })
    expect(msg).not.toMatch(/Known employees/i)
  })

  it('omits the locations line when locations array is empty', () => {
    const msg = buildUserMessage({ ...BASE_CTX, locations: [] })
    expect(msg).not.toMatch(/Known locations/i)
  })
})

// ── buildUserMessage — date context ───────────────────────────────────────────

describe('buildUserMessage — date context', () => {
  it('includes the reference date', () => {
    const msg = buildUserMessage(BASE_CTX)
    expect(msg).toContain('Reference date: 2026-09-06')
  })

  it('includes occurred_on hint when provided', () => {
    const msg = buildUserMessage({ ...BASE_CTX, occurred_on: '2026-09-05' })
    expect(msg).toContain('2026-09-05')
    expect(msg).toMatch(/occurrence date hint/i)
  })

  it('omits occurrence date hint when occurred_on is null', () => {
    const msg = buildUserMessage({ ...BASE_CTX, occurred_on: null })
    expect(msg).not.toMatch(/occurrence date hint/i)
  })
})

// ── SYSTEM_PROMPT — key safety and task instructions ─────────────────────────

describe('SYSTEM_PROMPT contracts', () => {
  it('contains the UNTRUSTED SOURCE MATERIAL security instruction', () => {
    expect(SYSTEM_PROMPT).toMatch(/UNTRUSTED SOURCE MATERIAL/i)
  })

  it('instructs the model not to return UUIDs', () => {
    expect(SYSTEM_PROMPT).toMatch(/never.*uuid|uuid.*never|do not produce uuid/i)
  })

  it('instructs the model not to include tasks or action items', () => {
    // The prompt must clearly exclude task/todo/action-item content
    expect(SYSTEM_PROMPT).toMatch(/task|to.?do|action item/i)
    expect(SYSTEM_PROMPT).toMatch(/not.*include|do not|must not/i)
  })

  it('specifies the atomicity rule (one fact per candidate)', () => {
    expect(SYSTEM_PROMPT).toMatch(/atomic|one.*fact|one candidate per fact/i)
  })

  it('specifies occurred_on format as YYYY-MM-DD', () => {
    expect(SYSTEM_PROMPT).toMatch(/YYYY-MM-DD/)
  })
})

// ── analyzeCapture — environment guard ────────────────────────────────────────

describe('analyzeCapture — missing env vars', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('MEETING_AI_MODEL', '')
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
  })

  it('returns ok:false when MEETING_AI_MODEL is not set', async () => {
    const { analyzeCapture } = await import('@/lib/ai/analyze-capture')
    const result = await analyzeCapture(BASE_CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/not configured/i)
    }
  })
})

describe('analyzeCapture — missing API key', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('MEETING_AI_MODEL', 'claude-sonnet-4-6')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
  })

  it('returns ok:false when ANTHROPIC_API_KEY is not set', async () => {
    const { analyzeCapture } = await import('@/lib/ai/analyze-capture')
    const result = await analyzeCapture(BASE_CTX)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/not configured/i)
    }
  })
})
