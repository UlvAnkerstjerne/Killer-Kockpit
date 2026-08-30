/**
 * lib/ai/parse-transcript.ts
 *
 * Pure helpers to normalise raw transcript text for AI consumption.
 *
 * Rules
 * ─────
 * • Strip VTT/SRT metadata (cue numbers, timestamps, WEBVTT header, NOTE
 *   blocks, STYLE blocks, REGION blocks).
 * • Preserve speaker labels — they are essential for outcome attribution.
 * • Collapse runs of blank lines to a single blank line.
 * • Never throw — callers receive an empty string on malformed input.
 * • Never write the normalised form back to storage; the stored source
 *   always holds the raw verbatim bytes.
 *
 * The normalised output is passed to the AI model in Phase M5B.  These
 * functions are intentionally pure so they can be unit-tested without
 * any database or network access.
 */

// ─── VTT ─────────────────────────────────────────────────────────────────────

/**
 * Normalises a WebVTT transcript.
 *
 * Strips:
 *   • "WEBVTT" header line and any header metadata block
 *   • NOTE blocks
 *   • STYLE blocks
 *   • REGION blocks
 *   • Cue identifiers (numeric or text ids that appear before timestamps)
 *   • Timestamp lines (e.g. "00:00:01.000 --> 00:00:04.000 align:center")
 *   • VTT tags inside cue text (<c>, <b>, <ruby>, <v …>, etc.)
 *
 * Preserves:
 *   • Speaker labels in the form "Speaker Name: cue text" — these come from
 *     the <v SpeakerName> tag which we convert to "SpeakerName: " prefix,
 *     or from literal "Name: text" patterns already in the cue.
 */
export function parseVtt(raw: string): string {
  try {
    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = text.split('\n')

    // Skip WEBVTT header line and optional metadata block
    let startIdx = 0
    if (lines[0]?.trimStart().startsWith('WEBVTT')) {
      startIdx = 1
      while (startIdx < lines.length && lines[startIdx].trim() !== '') startIdx++
    }

    // Split body into blocks separated by blank lines.
    // Each cue is its own block: [optional-id] + timestamp + payload lines.
    const body = lines.slice(startIdx).join('\n')
    const blocks = body.split(/\n{2,}/)

    const output: string[] = []

    for (const block of blocks) {
      const blockLines = block.split('\n').map(l => l.trim()).filter(Boolean)
      if (blockLines.length === 0) continue

      // NOTE / STYLE / REGION blocks — skip entirely
      if (/^(NOTE|STYLE|REGION)/.test(blockLines[0])) continue

      // Find the timestamp line within the block
      const tsIdx = blockLines.findIndex(l => l.includes(' --> '))
      if (tsIdx === -1) continue // no timestamp → not a cue

      // Payload = everything after the timestamp line (may span multiple lines)
      const payloadLines = blockLines.slice(tsIdx + 1)
      if (payloadLines.length === 0) continue

      // Process the full payload block at once so multi-line <v> tags are matched
      const payload = payloadLines.join('\n')
      const stripped = stripVttTags(payload)
      if (stripped.trim()) {
        output.push(stripped.trim())
      }
    }

    return collapseBlankLines(output.join('\n\n')).trim()
  } catch {
    return ''
  }
}

/**
 * Strips VTT inline tags from a cue text line.
 *
 * <v Speaker Name>text</v>  →  "Speaker Name: text"
 * <c.class>text</c>         →  "text"
 * <b>text</b>               →  "text"
 * <00:00:00.000>            →  "" (timestamp tags)
 */
function stripVttTags(text: string): string {
  // Extract speaker from <v …> and prepend as "Name: "
  let result = text.replace(/<v\s+([^>]+)>([\s\S]*?)<\/v>/g, (_m, speaker, content) => {
    return `${speaker.trim()}: ${content}`
  })

  // Remove remaining timestamp tags <00:00:00.000>
  result = result.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')

  // Remove all other inline tags, preserving content
  result = result.replace(/<[^>]+>/g, '')

  return result
}

// ─── SRT ─────────────────────────────────────────────────────────────────────

/**
 * Normalises a SubRip (SRT) transcript.
 *
 * Strips:
 *   • Sequence numbers (lines containing only digits)
 *   • Timestamp lines (e.g. "00:00:01,000 --> 00:00:04,000")
 *   • HTML-style tags sometimes present in SRT (<b>, <i>, <font …>)
 *
 * Preserves:
 *   • Cue text verbatim (including any speaker labels the author wrote)
 */
export function parseSrt(raw: string): string {
  try {
    const lines = raw.split(/\r?\n/)
    const output: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()

      // Skip sequence numbers (line containing only digits)
      if (/^\d+$/.test(trimmed)) continue

      // Skip timestamp lines (SRT uses comma for milliseconds)
      if (/^\d{2}:\d{2}:\d{2}[,\.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,\.]\d{3}/.test(trimmed)) continue

      // Blank lines preserved as separators
      if (trimmed === '') {
        output.push('')
        continue
      }

      // Strip HTML-style tags sometimes found in SRT
      const stripped = trimmed.replace(/<[^>]+>/g, '')
      if (stripped.trim() !== '') {
        output.push(stripped)
      }
    }

    return collapseBlankLines(output.join('\n')).trim()
  } catch {
    return ''
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Collapses two or more consecutive blank lines to a single blank line. */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

/**
 * Detects format from file extension and dispatches to the right parser.
 * Returns normalised text, or the raw string if format is unrecognised
 * (plain text files pass through unchanged).
 */
export function normaliseTranscript(raw: string, fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'vtt') return parseVtt(raw)
  if (ext === 'srt') return parseSrt(raw)
  // Plain text — return as-is (already normalised)
  return raw.trim()
}
