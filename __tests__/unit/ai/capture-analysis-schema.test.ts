/**
 * capture-analysis-schema.test.ts
 *
 * Tests for the Zod schema that validates AI output from analyzeCapture().
 * Runs in Node — the schema is pure and environment-independent.
 */

import { describe, it, expect } from 'vitest'
import {
  CaptureAnalysisOutputSchema,
  CandidateEntityRefSchema,
  CandidateUpdateSchema,
} from '@/lib/ai/capture-analysis-schema'

// ── CandidateEntityRefSchema ───────────────────────────────────────────────────

describe('CandidateEntityRefSchema', () => {
  it('accepts valid project ref', () => {
    const result = CandidateEntityRefSchema.safeParse({
      entity_type: 'project',
      name_hint:   'Knife sharpening SOP',
    })
    expect(result.success).toBe(true)
  })

  it('accepts valid employee ref', () => {
    const result = CandidateEntityRefSchema.safeParse({
      entity_type: 'employee',
      name_hint:   'Ahmed',
    })
    expect(result.success).toBe(true)
  })

  it('accepts valid location ref', () => {
    const result = CandidateEntityRefSchema.safeParse({
      entity_type: 'location',
      name_hint:   'Nørrebro',
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown entity_type', () => {
    const result = CandidateEntityRefSchema.safeParse({
      entity_type: 'meeting',
      name_hint:   'Something',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty name_hint', () => {
    const result = CandidateEntityRefSchema.safeParse({
      entity_type: 'project',
      name_hint:   '',
    })
    expect(result.success).toBe(false)
  })

  it('does NOT accept a UUID as name_hint at the Zod level (is a string — enforcement is by prompt)', () => {
    // The schema accepts any non-empty string; UUID prevention is by instruction.
    // This documents the design intentionally.
    const result = CandidateEntityRefSchema.safeParse({
      entity_type: 'project',
      name_hint:   'aaaaaaaa-1111-1111-1111-111111111111',
    })
    // Passes schema — UUID prevention is a prompt contract, not a Zod constraint.
    expect(result.success).toBe(true)
  })
})

// ── CandidateUpdateSchema ─────────────────────────────────────────────────────

describe('CandidateUpdateSchema', () => {
  it('accepts a valid candidate with occurred_on', () => {
    const result = CandidateUpdateSchema.safeParse({
      body:        'Supplier contract for packaging signed.',
      occurred_on: '2026-09-01',
      entity_refs: [{ entity_type: 'project', name_hint: 'Packaging renewal' }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a candidate with null occurred_on', () => {
    const result = CandidateUpdateSchema.safeParse({
      body:        'Ahmed promoted to Head Chef.',
      occurred_on: null,
      entity_refs: [{ entity_type: 'employee', name_hint: 'Ahmed' }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a candidate with empty entity_refs', () => {
    const result = CandidateUpdateSchema.safeParse({
      body:        'General update with no specific entity.',
      occurred_on: null,
      entity_refs: [],
    })
    expect(result.success).toBe(true)
  })

  it('accepts multiple entity_refs', () => {
    const result = CandidateUpdateSchema.safeParse({
      body:        'Ahmed transferred from Østerbro to Nørrebro.',
      occurred_on: '2026-09-05',
      entity_refs: [
        { entity_type: 'employee', name_hint: 'Ahmed' },
        { entity_type: 'location', name_hint: 'Østerbro' },
        { entity_type: 'location', name_hint: 'Nørrebro' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty body', () => {
    const result = CandidateUpdateSchema.safeParse({
      body:        '',
      occurred_on: null,
      entity_refs: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing occurred_on field entirely', () => {
    const result = CandidateUpdateSchema.safeParse({
      body:        'Something happened.',
      entity_refs: [],
    })
    // occurred_on is required (must be string | null)
    expect(result.success).toBe(false)
  })
})

// ── CaptureAnalysisOutputSchema ───────────────────────────────────────────────

describe('CaptureAnalysisOutputSchema', () => {
  it('accepts valid output with candidates', () => {
    const result = CaptureAnalysisOutputSchema.safeParse({
      candidates: [
        {
          body:        'Supplier contract signed.',
          occurred_on: '2026-09-01',
          entity_refs: [{ entity_type: 'project', name_hint: 'Packaging project' }],
        },
        {
          body:        'Ahmed promoted.',
          occurred_on: null,
          entity_refs: [{ entity_type: 'employee', name_hint: 'Ahmed' }],
        },
      ],
      analysis_note: null,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.candidates).toHaveLength(2)
    }
  })

  it('accepts empty candidates array', () => {
    const result = CaptureAnalysisOutputSchema.safeParse({
      candidates:    [],
      analysis_note: 'Note contained only action items — no Universal Updates extracted.',
    })
    expect(result.success).toBe(true)
  })

  it('accepts null analysis_note', () => {
    const result = CaptureAnalysisOutputSchema.safeParse({
      candidates: [{
        body:        'Test fact.',
        occurred_on: null,
        entity_refs: [],
      }],
      analysis_note: null,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing candidates field', () => {
    const result = CaptureAnalysisOutputSchema.safeParse({
      analysis_note: 'Only note, no candidates field.',
    })
    expect(result.success).toBe(false)
  })

  it('rejects candidate with invalid entity_type inside output', () => {
    const result = CaptureAnalysisOutputSchema.safeParse({
      candidates: [{
        body:        'Some fact.',
        occurred_on: null,
        entity_refs: [{ entity_type: 'task', name_hint: 'Something' }],
      }],
      analysis_note: null,
    })
    expect(result.success).toBe(false)
  })
})
