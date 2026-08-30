/**
 * Tests for lib/google/meet.ts — ensureMeetAutoTranscription (M5E1-C).
 *
 * What is tested:
 *   - Already ON: returns 'already_enabled', no PATCH issued
 *   - OFF / unspecified: issues PATCH, returns 'enabled'
 *   - updateMask is scoped exactly to the transcription field (not recording / smartNotes)
 *   - requestBody does not include recording or smartNotes settings
 *   - 401 / 403 from GET → 'permission_denied'
 *   - Other API failure → 'error'
 *
 * What is NOT tested (requires live credentials):
 *   - Actual Meet API calls
 *   - Token refresh behaviour
 *   - getMeetSpaceName (covered in sync.test.ts via integration-level mock)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mock factories (must precede vi.mock calls) ──────────────────

const meetMocks = vi.hoisted(() => {
  const mockGet   = vi.fn()
  const mockPatch = vi.fn()
  return { mockGet, mockPatch }
})

vi.mock('googleapis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('googleapis')>()
  return {
    ...actual,
    google: {
      ...actual.google,
      meet: vi.fn().mockReturnValue({
        spaces: {
          get:   meetMocks.mockGet,
          patch: meetMocks.mockPatch,
        },
      }),
    },
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a spaces.get response fixture with optional transcription state. */
function makeSpaceResponse(transcriptionState?: string) {
  const data: Record<string, unknown> = { name: 'spaces/TestSpace' }
  if (transcriptionState !== undefined) {
    data.config = {
      artifactConfig: {
        transcriptionConfig: {
          autoTranscriptionGeneration: transcriptionState,
        },
      },
    }
  }
  return { data }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('ensureMeetAutoTranscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    meetMocks.mockPatch.mockResolvedValue({ data: {} })
  })

  it('returns already_enabled when autoTranscriptionGeneration is ON — no PATCH issued', async () => {
    meetMocks.mockGet.mockResolvedValue(makeSpaceResponse('ON'))

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    const result = await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    expect(result).toBe('already_enabled')
    expect(meetMocks.mockPatch).not.toHaveBeenCalled()
  })

  it('PATCHes and returns enabled when transcription is OFF', async () => {
    meetMocks.mockGet.mockResolvedValue(makeSpaceResponse('OFF'))

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    const result = await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    expect(result).toBe('enabled')
    expect(meetMocks.mockPatch).toHaveBeenCalledTimes(1)
  })

  it('PATCHes and returns enabled when config is absent (unspecified state)', async () => {
    meetMocks.mockGet.mockResolvedValue(makeSpaceResponse()) // no config field

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    const result = await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    expect(result).toBe('enabled')
    expect(meetMocks.mockPatch).toHaveBeenCalledTimes(1)
  })

  it('PATCH updateMask targets only the transcription field', async () => {
    meetMocks.mockGet.mockResolvedValue(makeSpaceResponse('OFF'))

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    const call = meetMocks.mockPatch.mock.calls[0][0]
    expect(call.updateMask).toBe(
      'config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration'
    )
  })

  it('PATCH requestBody sets autoTranscriptionGeneration to ON', async () => {
    meetMocks.mockGet.mockResolvedValue(makeSpaceResponse('OFF'))

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    const body = meetMocks.mockPatch.mock.calls[0][0].requestBody as Record<string, unknown>
    const config = body?.config as Record<string, unknown> | undefined
    const artifactConfig = config?.artifactConfig as Record<string, unknown> | undefined
    const txConfig = artifactConfig?.transcriptionConfig as Record<string, unknown> | undefined
    expect(txConfig?.autoTranscriptionGeneration).toBe('ON')
  })

  it('PATCH requestBody does NOT include recordingConfig or smartNotesConfig', async () => {
    meetMocks.mockGet.mockResolvedValue(makeSpaceResponse('OFF'))

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    const body = meetMocks.mockPatch.mock.calls[0][0].requestBody as Record<string, unknown>
    const config = body?.config as Record<string, unknown> | undefined
    const artifactConfig = config?.artifactConfig as Record<string, unknown> | undefined
    expect(artifactConfig?.recordingConfig).toBeUndefined()
    expect(artifactConfig?.smartNotesConfig).toBeUndefined()
  })

  it('returns permission_denied on 403', async () => {
    meetMocks.mockGet.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { code: 403 })
    )

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    const result = await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    expect(result).toBe('permission_denied')
    expect(meetMocks.mockPatch).not.toHaveBeenCalled()
  })

  it('returns permission_denied on 401', async () => {
    meetMocks.mockGet.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { code: 401 })
    )

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    const result = await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    expect(result).toBe('permission_denied')
  })

  it('returns error on unexpected API failure', async () => {
    meetMocks.mockGet.mockRejectedValue(new Error('Internal Server Error'))

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    const result = await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    expect(result).toBe('error')
    expect(meetMocks.mockPatch).not.toHaveBeenCalled()
  })

  it('returns error when PATCH itself fails (not permission-related)', async () => {
    meetMocks.mockGet.mockResolvedValue(makeSpaceResponse('OFF'))
    meetMocks.mockPatch.mockRejectedValue(new Error('Network timeout'))

    const { ensureMeetAutoTranscription } = await import('@/lib/google/meet')
    const result = await ensureMeetAutoTranscription({} as never, 'spaces/TestSpace')

    expect(result).toBe('error')
  })
})
