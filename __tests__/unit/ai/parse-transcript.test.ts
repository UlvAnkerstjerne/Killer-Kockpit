/**
 * Tests for lib/ai/parse-transcript.ts
 *
 * Strategy: pure functions imported directly — no mocking.
 *
 * Coverage:
 *   parseVtt  — header stripping, timestamp removal, cue text extraction,
 *               <v Speaker> tag conversion, inline tag stripping, NOTE/STYLE
 *               blocks, blank line collapse
 *   parseSrt  — sequence number removal, timestamp removal, HTML tag stripping,
 *               cue text preservation, blank line handling
 *   normaliseTranscript — dispatches by extension, passes txt through
 */

import { describe, it, expect } from 'vitest'
import { parseVtt, parseSrt, normaliseTranscript } from '@/lib/ai/parse-transcript'

// ─── parseVtt ─────────────────────────────────────────────────────────────────

describe('parseVtt', () => {
  it('strips the WEBVTT header', () => {
    const raw = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world`
    const result = parseVtt(raw)
    expect(result).toBe('Hello world')
    expect(result).not.toContain('WEBVTT')
    expect(result).not.toContain('-->')
  })

  it('strips timestamp lines', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:02.000
Line one

00:00:02.000 --> 00:00:04.000
Line two`
    const result = parseVtt(raw)
    expect(result).toBe('Line one\n\nLine two')
  })

  it('converts <v Speaker> tags to "Speaker: text" format', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:05.000
<v Alice>We should ship this feature.</v>`
    const result = parseVtt(raw)
    expect(result).toBe('Alice: We should ship this feature.')
  })

  it('strips generic inline VTT tags preserving content', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:03.000
<b>Bold text</b> and <i>italic</i>`
    const result = parseVtt(raw)
    expect(result).toBe('Bold text and italic')
  })

  it('strips timestamp tags', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:05.000
Hello <00:00:01.500> world`
    const result = parseVtt(raw)
    expect(result).toBe('Hello  world')
  })

  it('strips NOTE blocks entirely', () => {
    const raw = `WEBVTT

NOTE This is a comment block
that spans multiple lines

00:00:00.000 --> 00:00:03.000
Cue text after note`
    const result = parseVtt(raw)
    expect(result).not.toContain('NOTE')
    expect(result).not.toContain('comment')
    expect(result).toBe('Cue text after note')
  })

  it('strips STYLE blocks entirely', () => {
    const raw = `WEBVTT

STYLE
::cue { color: red; }

00:00:00.000 --> 00:00:02.000
Visible text`
    const result = parseVtt(raw)
    expect(result).not.toContain('STYLE')
    expect(result).not.toContain('color')
    expect(result).toBe('Visible text')
  })

  it('collapses multiple consecutive blank lines', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:01.000
A

00:00:01.000 --> 00:00:02.000
B`
    const result = parseVtt(raw)
    // Should have at most one blank line between cues
    expect(result).not.toMatch(/\n{3,}/)
  })

  it('preserves multi-line speaker turns', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:05.000
<v Bob>First line
second line</v>`
    const result = parseVtt(raw)
    expect(result).toContain('Bob:')
    expect(result).toContain('second line')
  })

  it('handles cue identifier lines before timestamps', () => {
    const raw = `WEBVTT

intro
00:00:00.000 --> 00:00:02.000
Hello`
    const result = parseVtt(raw)
    // The cue identifier "intro" should not appear in output
    expect(result).not.toContain('intro')
    expect(result).toBe('Hello')
  })

  it('returns empty string for empty input', () => {
    expect(parseVtt('')).toBe('')
  })

  it('returns empty string for header-only file', () => {
    expect(parseVtt('WEBVTT\n')).toBe('')
  })

  it('does not throw on malformed input', () => {
    expect(() => parseVtt('not a vtt at all\x00\x01')).not.toThrow()
  })

  it('handles WEBVTT with metadata header block', () => {
    const raw = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000
Caption text`
    const result = parseVtt(raw)
    expect(result).toBe('Caption text')
    expect(result).not.toContain('Kind')
    expect(result).not.toContain('Language')
  })
})

// ─── parseSrt ─────────────────────────────────────────────────────────────────

describe('parseSrt', () => {
  it('strips sequence numbers', () => {
    const raw = `1
00:00:01,000 --> 00:00:04,000
Hello world`
    const result = parseSrt(raw)
    expect(result).toBe('Hello world')
    expect(result).not.toMatch(/^\d+$/)
  })

  it('strips SRT timestamp lines (comma milliseconds)', () => {
    const raw = `1
00:00:01,000 --> 00:00:04,000
Hello world`
    const result = parseSrt(raw)
    expect(result).not.toContain('-->')
    expect(result).not.toContain(',000')
  })

  it('strips SRT timestamp lines (dot milliseconds variant)', () => {
    const raw = `1
00:00:01.000 --> 00:00:04.000
Dot variant`
    const result = parseSrt(raw)
    expect(result).toBe('Dot variant')
  })

  it('preserves cue text verbatim', () => {
    const raw = `1
00:00:00,000 --> 00:00:02,000
Alice: We need to decide on the budget.`
    const result = parseSrt(raw)
    expect(result).toBe('Alice: We need to decide on the budget.')
  })

  it('handles multiple cues', () => {
    const raw = `1
00:00:00,000 --> 00:00:02,000
First cue

2
00:00:02,000 --> 00:00:04,000
Second cue`
    const result = parseSrt(raw)
    expect(result).toContain('First cue')
    expect(result).toContain('Second cue')
  })

  it('strips HTML-style tags sometimes found in SRT', () => {
    const raw = `1
00:00:00,000 --> 00:00:02,000
<b>Bold</b> and <i>italic</i> text`
    const result = parseSrt(raw)
    expect(result).toBe('Bold and italic text')
  })

  it('strips font tags', () => {
    const raw = `1
00:00:00,000 --> 00:00:02,000
<font color="red">Coloured text</font>`
    const result = parseSrt(raw)
    expect(result).toBe('Coloured text')
  })

  it('returns empty string for empty input', () => {
    expect(parseSrt('')).toBe('')
  })

  it('does not throw on malformed input', () => {
    expect(() => parseSrt('random garbage\n\nno timestamps')).not.toThrow()
  })

  it('preserves speaker labels written as plain text', () => {
    const raw = `1
00:00:00,000 --> 00:00:05,000
Sarah: The deadline is end of Q3.`
    const result = parseSrt(raw)
    expect(result).toBe('Sarah: The deadline is end of Q3.')
  })
})

// ─── normaliseTranscript ──────────────────────────────────────────────────────

describe('normaliseTranscript', () => {
  it('dispatches .vtt files to parseVtt', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello from VTT`
    const result = normaliseTranscript(raw, 'meeting.vtt')
    expect(result).toBe('Hello from VTT')
    expect(result).not.toContain('WEBVTT')
  })

  it('dispatches .srt files to parseSrt', () => {
    const raw = `1
00:00:00,000 --> 00:00:02,000
Hello from SRT`
    const result = normaliseTranscript(raw, 'meeting.srt')
    expect(result).toBe('Hello from SRT')
    expect(result).not.toContain('-->')
  })

  it('passes .txt files through unchanged', () => {
    const raw = 'Alice: This is a plain text transcript.\nBob: Agreed.'
    const result = normaliseTranscript(raw, 'notes.txt')
    expect(result).toBe(raw.trim())
  })

  it('is case-insensitive on extension', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:01.000
Upper VTT`
    const result = normaliseTranscript(raw, 'MEETING.VTT')
    expect(result).toBe('Upper VTT')
  })

  it('passes through unrecognised extensions as plain text', () => {
    const raw = 'Some content'
    const result = normaliseTranscript(raw, 'transcript.docx')
    expect(result).toBe('Some content')
  })
})
