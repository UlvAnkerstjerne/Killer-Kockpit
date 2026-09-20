/**
 * lib/assemblyai/transcript.ts
 *
 * Pure functions for assembling and correcting AssemblyAI transcripts.
 *
 * Output format
 * ─────────────
 * Speaker-attributed lines, one speaker block per speaker turn:
 *
 *   Ulv Ankerstjerne:
 *   I think the interesting part is...
 *
 *   Mikkel Jensen:
 *   What we could offer is...
 *
 * Consecutive utterances from the same speaker are merged into one block
 * with their text joined by a space.  This matches the format the existing
 * AI draft / minutes pipeline expects.
 *
 * Speaker label resolution
 * ────────────────────────
 * 1. If AssemblyAI speaker identification succeeded, utterance.speaker may
 *    already be a display name rather than 'A'/'B'/'C'.
 * 2. If not (or partially), the speakerMapping parameter (from the
 *    meeting_recordings.speaker_mapping column) is applied: e.g.
 *    { "A": "Ulv", "B": "Mikkel Jensen" }.
 * 3. Any remaining generic labels ('A', 'B', 'C') are left as-is and
 *    surfaced for the speaker review UI to correct.
 *
 * Idempotency
 * ───────────
 * buildTranscript is a pure function — safe to call multiple times with
 * the same data (e.g. for speaker review corrections).
 */

import type { AssemblyAIUtterance } from './client'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TranscriptBuildResult {
  content:            string         // formatted speaker-attributed text
  speakerMapping:     SpeakerMapping // final resolved { label → name } map
  hasUnmappedSpeakers: boolean       // true if any utterance still has A/B/C label
  speakerCount:       number         // distinct speakers in utterances
  wordCount:          number         // approximate word count
}

/**
 * Keys are the raw labels from AssemblyAI (e.g. "A", "B", "Speaker 1") or
 * display names if speaker identification already resolved them.
 * Values are the final display names to use in the transcript.
 */
export type SpeakerMapping = Record<string, string>

// ─── Helpers ───────────────────────────────────────────────────────────────

/** True when a string looks like a generic AssemblyAI diarization label */
function isGenericLabel(s: string): boolean {
  // Matches: "A", "B", "Speaker A", "Speaker 1", "SPEAKER_0", etc.
  return /^([A-Z]|Speaker\s+\w+|SPEAKER_\d+)$/i.test(s)
}

/** Count words in a string */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

// ─── Core assembly ─────────────────────────────────────────────────────────

/**
 * Builds the final transcript string from AssemblyAI utterances.
 *
 * @param utterances  - utterances from the AssemblyAI response
 * @param speakerMapping - optional name overrides: { "A": "Ulv", "B": "Mikkel" }
 *                         Applied on top of any names already in utterance.speaker.
 */
export function buildTranscript(
  utterances: AssemblyAIUtterance[],
  speakerMapping: SpeakerMapping = {},
): TranscriptBuildResult {
  if (utterances.length === 0) {
    return {
      content:             '',
      speakerMapping:      {},
      hasUnmappedSpeakers: false,
      speakerCount:        0,
      wordCount:           0,
    }
  }

  // Build a complete label → resolved name map
  const resolvedMapping: SpeakerMapping = {}
  const genericLabels = new Set<string>()

  for (const u of utterances) {
    const rawLabel = u.speaker
    if (!resolvedMapping[rawLabel]) {
      const override = speakerMapping[rawLabel]
      const resolved = override ?? rawLabel
      resolvedMapping[rawLabel] = resolved
      if (isGenericLabel(resolved)) {
        genericLabels.add(rawLabel)
      }
    }
  }

  // Merge consecutive same-speaker turns
  const merged: Array<{ speaker: string; text: string }> = []
  for (const u of utterances) {
    const resolvedName = resolvedMapping[u.speaker] ?? u.speaker
    const prev = merged[merged.length - 1]
    if (prev && prev.speaker === resolvedName) {
      prev.text += ' ' + u.text
    } else {
      merged.push({ speaker: resolvedName, text: u.text })
    }
  }

  // Format output
  const lines: string[] = []
  for (const block of merged) {
    lines.push(`${block.speaker}:\n${block.text}`)
  }
  const content = lines.join('\n\n')

  // Word count
  const wordCount = utterances.reduce((sum, u) => sum + countWords(u.text), 0)

  return {
    content,
    speakerMapping:      resolvedMapping,
    hasUnmappedSpeakers: genericLabels.size > 0,
    speakerCount:        Object.keys(resolvedMapping).length,
    wordCount,
  }
}

// ─── Speaker review helpers ────────────────────────────────────────────────

export interface SpeakerReviewItem {
  label:           string   // raw label from AssemblyAI (e.g. "A")
  currentName:     string   // currently assigned name (may be generic label)
  isGeneric:       boolean  // true if still unmapped
  sampleText:      string   // first utterance text, truncated
}

/**
 * Extracts the list of unique speakers for the review UI.
 * Includes both mapped and unmapped speakers, ordered by first appearance.
 */
export function buildSpeakerReviewItems(
  utterances: AssemblyAIUtterance[],
  speakerMapping: SpeakerMapping = {},
): SpeakerReviewItem[] {
  const seen = new Map<string, SpeakerReviewItem>()

  for (const u of utterances) {
    if (!seen.has(u.speaker)) {
      const currentName = speakerMapping[u.speaker] ?? u.speaker
      seen.set(u.speaker, {
        label:       u.speaker,
        currentName,
        isGeneric:   isGenericLabel(currentName),
        sampleText:  u.text.length > 80 ? u.text.slice(0, 80) + '…' : u.text,
      })
    }
  }

  return Array.from(seen.values())
}

/**
 * Applies a corrected speaker mapping and rebuilds the transcript.
 * The corrected mapping is the full authoritative map (not a diff).
 */
export function applyMappingCorrection(
  utterances: AssemblyAIUtterance[],
  correctedMapping: SpeakerMapping,
): TranscriptBuildResult {
  return buildTranscript(utterances, correctedMapping)
}
