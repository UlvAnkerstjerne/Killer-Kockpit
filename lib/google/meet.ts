/**
 * lib/google/meet.ts
 *
 * Typed wrappers around the Google Meet REST API v2.
 *
 * M5E1-B scope: space name resolution (getMeetSpaceName).
 * M5E1-C scope: auto-transcription configuration (ensureMeetAutoTranscription).
 * M5E1-D will add: conferenceRecords, transcripts, entries retrieval.
 *
 * Required OAuth scopes:
 *   meetings.space.readonly  — spaces.get, conferenceRecords.*, transcripts.*
 *   meetings.space.settings  — spaces.patch (auto-transcription config)
 */

import { google } from 'googleapis'
import type { Auth } from 'googleapis'

// ─── Space resolution ─────────────────────────────────────────────────────

/**
 * Resolves a Google Calendar conference meeting code (e.g. "abc-mnop-xyz")
 * to the permanent Meet space resource name (e.g. "spaces/jQCFfuBOdN5z").
 *
 * The meeting code is the 10-letter alias returned by the Calendar API in
 * conferenceData.conferenceId for hangoutsMeet conferences.  It can be used
 * as a path alias in the Meet API (spaces/{meetingCode}).
 *
 * The permanent space.name does not expire and is the correct identifier
 * to store long-term.  The meeting code expires after 365 days without use.
 *
 * Returns null if the space cannot be resolved (network error, scope missing,
 * invalid code, etc.).  Callers should treat null as a retryable condition
 * and not fail the broader Calendar sync.
 *
 * Required scope: meetings.space.readonly
 */
export async function getMeetSpaceName(
  client: Auth.OAuth2Client,
  meetingCode: string,
): Promise<string | null> {
  try {
    const meet = google.meet({ version: 'v2', auth: client })
    const { data } = await meet.spaces.get({ name: `spaces/${meetingCode}` })
    return typeof data.name === 'string' && data.name.length > 0 ? data.name : null
  } catch (err) {
    console.error(
      '[google/meet] getMeetSpaceName failed for code',
      meetingCode,
      ':',
      (err as Error).message,
    )
    return null
  }
}

// ─── Auto-transcription configuration ────────────────────────────────────

export type AutoTranscriptionResult =
  | 'enabled'          // PATCH succeeded; transcription is now ON
  | 'already_enabled'  // GET confirmed transcription was already ON; no PATCH issued
  | 'permission_denied' // 403/401 — missing scope or space not accessible
  | 'error'            // other API failure; treat as retryable

/**
 * Ensures that automatic transcription is ON for the given Meet space.
 *
 * Idempotent by design:
 *   1. GET the space to read the current transcriptionConfig.
 *   2. If autoTranscriptionGeneration is already 'ON' → return 'already_enabled'
 *      without issuing any PATCH.
 *   3. Otherwise PATCH with a tight updateMask that touches ONLY the
 *      transcription setting — never recording, never smart notes.
 *
 * This function never sets autoTranscriptionGeneration to OFF.
 * It is safe to call on every sync — repeated calls are no-ops after the first.
 *
 * Required scope: meetings.space.settings (for PATCH)
 *                 meetings.space.readonly  (for GET)
 */
export async function ensureMeetAutoTranscription(
  client: Auth.OAuth2Client,
  spaceName: string,
): Promise<AutoTranscriptionResult> {
  try {
    const meet = google.meet({ version: 'v2', auth: client })

    // ── Step 1: read current transcription config ─────────────────────────
    const { data: space } = await meet.spaces.get({ name: spaceName })

    // The ArtifactConfig types may not be fully typed in googleapis@176.
    // Use safe optional-chaining through the raw response.
    const spaceAny = space as Record<string, unknown>
    const config = spaceAny.config as Record<string, unknown> | undefined
    const artifactConfig = config?.artifactConfig as Record<string, unknown> | undefined
    const transcriptionConfig = artifactConfig?.transcriptionConfig as Record<string, unknown> | undefined
    const currentSetting = transcriptionConfig?.autoTranscriptionGeneration as string | undefined

    if (currentSetting === 'ON') {
      return 'already_enabled'
    }

    // ── Step 2: PATCH only the transcription setting ───────────────────────
    // updateMask is a FieldMask string — exactly one field, no wildcards.
    // This guarantees recording and smart-notes settings are never touched.
    await meet.spaces.patch({
      name:       spaceName,
      updateMask: 'config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration',
      requestBody: {
        config: {
          artifactConfig: {
            transcriptionConfig: {
              autoTranscriptionGeneration: 'ON',
            },
          },
        },
      } as object,
    })

    return 'enabled'
  } catch (err) {
    const status = getMeetErrorStatus(err)
    if (status === 401 || status === 403) {
      console.warn(
        '[google/meet] ensureMeetAutoTranscription permission denied for',
        spaceName,
        '— status', status,
      )
      return 'permission_denied'
    }
    console.error(
      '[google/meet] ensureMeetAutoTranscription failed for',
      spaceName,
      ':',
      (err as Error).message,
    )
    return 'error'
  }
}

// ─── Error helpers ────────────────────────────────────────────────────────

function getMeetErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  if (typeof e.code === 'number') return e.code
  if (typeof e.status === 'number') return e.status
  const resp = e.response as Record<string, unknown> | undefined
  if (typeof resp?.status === 'number') return resp.status
  return undefined
}
