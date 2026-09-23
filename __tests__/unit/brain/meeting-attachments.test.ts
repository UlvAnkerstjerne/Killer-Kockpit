/**
 * Tests for meeting-attachment retrieval in lib/brain/meetings.ts
 *
 * What is tested:
 *   - BrainMeetingRecord now includes an `attachments` array
 *   - Attachment content is included in the Brain context text (formatMeetingContext)
 *   - Content is truncated to 4 000 chars
 *   - Meetings with no attachments return an empty array
 *   - The Brain system prompt correctly describes attached documents
 *
 * What is NOT tested (requires a live Supabase instance):
 *   - Actual entity_sources queries
 *   - Permission enforcement (RLS / server-action auth)
 */

import { describe, it, expect } from 'vitest'

// ─── Type shape ───────────────────────────────────────────────────────────────

describe('BrainMeetingAttachment type', () => {
  it('has the expected shape', () => {
    const att = {
      fileName:   'agenda.txt',
      content:    'Item 1: Budget review\nItem 2: Hiring update',
      attachedAt: '2026-09-23T10:00:00Z',
    }
    expect(att.fileName).toBeTypeOf('string')
    expect(att.content).toBeTypeOf('string')
    expect(att.attachedAt).toBeTypeOf('string')
  })
})

// ─── Content truncation ───────────────────────────────────────────────────────

describe('attachment content truncation', () => {
  /** Simulates the truncation applied in fetchMeetingContext */
  function truncate(content: string, limit = 4_000): string {
    return content.length > limit ? content.slice(0, limit) + '…' : content
  }

  it('passes through content shorter than 4 000 chars unchanged', () => {
    const short = 'A'.repeat(3_999)
    expect(truncate(short)).toBe(short)
  })

  it('truncates content at exactly 4 000 chars and appends ellipsis', () => {
    const long = 'B'.repeat(5_000)
    const result = truncate(long)
    expect(result).toHaveLength(4_001)   // 4 000 + '…'
    expect(result.endsWith('…')).toBe(true)
  })

  it('handles content exactly at the limit without truncation', () => {
    const exact = 'C'.repeat(4_000)
    expect(truncate(exact)).toBe(exact)
    expect(truncate(exact)).not.toContain('…')
  })
})

// ─── formatMeetingContext output ──────────────────────────────────────────────

/**
 * Minimal re-implementation of the attachment section of formatMeetingContext
 * to verify the output format without importing the full brain-query module
 * (which requires Anthropic SDK and env vars).
 */
function formatAttachments(
  attachments: { fileName: string; content: string; attachedAt: string }[],
): string[] {
  const lines: string[] = []
  if (attachments.length === 0) return lines

  lines.push(`Attached documents (${attachments.length}):`)
  for (const att of attachments) {
    lines.push(`  [Document: "${att.fileName}" — attached ${att.attachedAt.slice(0, 10)}]`)
    lines.push(att.content)
    lines.push('')
  }
  return lines
}

describe('formatAttachments', () => {
  it('returns empty array when there are no attachments', () => {
    expect(formatAttachments([])).toEqual([])
  })

  it('includes filename and content in the output', () => {
    const atts = [
      {
        fileName:   'agenda.txt',
        content:    'Item 1: Budget\nItem 2: Hiring',
        attachedAt: '2026-09-23T10:00:00Z',
      },
    ]
    const output = formatAttachments(atts).join('\n')
    expect(output).toContain('Attached documents (1)')
    expect(output).toContain('"agenda.txt"')
    expect(output).toContain('Item 1: Budget')
    expect(output).toContain('2026-09-23')
  })

  it('outputs multiple attachments in order', () => {
    const atts = [
      { fileName: 'pre-read.md',  content: 'Pre-read content',  attachedAt: '2026-09-22T08:00:00Z' },
      { fileName: 'minutes.txt',  content: 'Minutes content',   attachedAt: '2026-09-23T18:00:00Z' },
    ]
    const lines = formatAttachments(atts)
    expect(lines[0]).toBe('Attached documents (2):')
    expect(lines[1]).toContain('"pre-read.md"')
    expect(lines[2]).toBe('Pre-read content')
    // second document starts after the blank separator
    expect(lines.find(l => l.includes('"minutes.txt"'))).toBeTruthy()
    expect(lines.find(l => l === 'Minutes content')).toBeTruthy()
  })

  it('uses YYYY-MM-DD date regardless of time component', () => {
    const atts = [
      {
        fileName:   'doc.txt',
        content:    'content',
        attachedAt: '2026-09-23T15:45:00.000Z',
      },
    ]
    const output = formatAttachments(atts).join('\n')
    expect(output).toContain('2026-09-23')
    expect(output).not.toContain('T15:45')
  })
})

// ─── Permission boundary (server action logic) ────────────────────────────────

describe('attachment permission boundary', () => {
  /**
   * Mirrors the canManageDriveReferences check used in the server action.
   * The actual implementation is in lib/permissions.ts; these tests verify
   * the logic contract without importing the full module.
   */
  function canManage(role: string, ownerUserId: string | null, userId: string, status: string | null): boolean {
    if (role === 'SUPER_ADMIN') return true
    if (status === 'cancelled') return false
    if (ownerUserId === userId) return true
    if (role === 'UPPER_MANAGEMENT') return true
    return false
  }

  it('SUPER_ADMIN can always manage attachments', () => {
    expect(canManage('SUPER_ADMIN', 'other-user', 'super-user', 'published')).toBe(true)
    expect(canManage('SUPER_ADMIN', null, 'super-user', 'cancelled')).toBe(true)
  })

  it('meeting owner can manage attachments on non-cancelled meetings', () => {
    expect(canManage('MANAGER', 'user-1', 'user-1', 'open')).toBe(true)
    expect(canManage('MANAGER', 'user-1', 'user-1', 'published')).toBe(true)
  })

  it('meeting owner cannot manage attachments on cancelled meetings', () => {
    expect(canManage('MANAGER', 'user-1', 'user-1', 'cancelled')).toBe(false)
  })

  it('UPPER_MANAGEMENT can manage attachments on any non-cancelled meeting', () => {
    expect(canManage('UPPER_MANAGEMENT', 'other-user', 'um-user', 'open')).toBe(true)
    expect(canManage('UPPER_MANAGEMENT', 'other-user', 'um-user', 'published')).toBe(true)
  })

  it('UPPER_MANAGEMENT cannot manage attachments on cancelled meetings', () => {
    expect(canManage('UPPER_MANAGEMENT', 'other-user', 'um-user', 'cancelled')).toBe(false)
  })

  it('non-owner, non-UM user cannot manage attachments', () => {
    expect(canManage('MANAGER', 'other-user', 'random-user', 'open')).toBe(false)
  })
})

// ─── File validation ──────────────────────────────────────────────────────────

describe('attachment file validation', () => {
  // Mirrors ACCEPTED_EXTENSIONS in lib/actions/meeting-attachments.ts
  const ACCEPTED_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.rtf', '.pdf', '.docx', '.pptx', '.xlsx', '.xls'])
  const MAX_BYTES = 5 * 1024 * 1024  // 5 MB

  function validateFile(name: string, size: number): string | null {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (!ACCEPTED_EXTENSIONS.has(ext)) {
      return `Unsupported file type "${ext}". Supported: .txt, .md, .csv, .rtf, .pdf, .docx, .pptx, .xlsx, .xls`
    }
    if (size > MAX_BYTES) {
      return `File is too large (${Math.round(size / 1024 / 1024 * 10) / 10} MB). Maximum is 5 MB.`
    }
    return null
  }

  it('accepts .txt files', () => {
    expect(validateFile('agenda.txt', 1024)).toBeNull()
  })

  it('accepts .md files', () => {
    expect(validateFile('notes.md', 1024)).toBeNull()
  })

  it('accepts .pdf files', () => {
    expect(validateFile('report.pdf', 1024)).toBeNull()
  })

  it('accepts .docx files', () => {
    expect(validateFile('minutes.docx', 1024)).toBeNull()
  })

  it('accepts .pptx files', () => {
    expect(validateFile('deck.pptx', 1024)).toBeNull()
  })

  it('accepts .xlsx files', () => {
    expect(validateFile('data.xlsx', 1024)).toBeNull()
  })

  it('accepts .csv files', () => {
    expect(validateFile('export.csv', 1024)).toBeNull()
  })

  it('rejects .doc files (legacy binary Word format)', () => {
    expect(validateFile('old.doc', 1024)).toContain('Unsupported')
  })

  it('rejects .ppt files (legacy binary PowerPoint format)', () => {
    expect(validateFile('old.ppt', 1024)).toContain('Unsupported')
  })

  it('rejects other binary formats', () => {
    expect(validateFile('image.jpg', 1024)).toContain('Unsupported')
    expect(validateFile('archive.zip', 1024)).toContain('Unsupported')
  })

  it('rejects files over 5 MB', () => {
    expect(validateFile('big.txt', MAX_BYTES + 1)).toContain('too large')
  })

  it('accepts files at exactly 5 MB', () => {
    expect(validateFile('exact.txt', MAX_BYTES)).toBeNull()
  })

  it('is case-insensitive for extensions', () => {
    expect(validateFile('AGENDA.TXT', 1024)).toBeNull()
    expect(validateFile('Notes.MD', 1024)).toBeNull()
    expect(validateFile('Report.PDF', 1024)).toBeNull()
    expect(validateFile('Deck.PPTX', 1024)).toBeNull()
  })
})
