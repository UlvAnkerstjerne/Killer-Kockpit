/**
 * lib/extractors/text.ts
 *
 * Server-side text extraction for all supported document formats.
 *
 * Accepted formats
 * ────────────────
 * • .txt / text/plain       — decoded as UTF-8
 * • .md  / text/markdown    — decoded as UTF-8
 * • .csv / text/csv         — decoded as UTF-8
 * • .rtf / text/rtf         — RTF markup stripped via regex
 * • .pdf / application/pdf  — extracted via pdf-parse (no OCR for scanned pages)
 * • .docx / .doc            — extracted via mammoth
 * • .xlsx / .xls            — sheet rows extracted via xlsx (SheetJS)
 * • .pptx / .ppt            — NOT supported; returns a clear unsupported error
 *
 * Return shape
 * ────────────
 * { text: string }             — successful extraction; text may be empty
 * { error: string }            — file format not supported or extraction failed
 * { warning: string; text: string } — partial extraction (e.g. PDF with scanned pages)
 *
 * Limits
 * ──────
 * MAX_EXTRACT_CHARS (200 000) — content is sliced before returning to prevent DB bloat.
 * Callers that need keyword excerpts should use extractKeywordExcerpt().
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExtractionResult =
  | { ok: true;  text: string; warning?: string }
  | { ok: false; error: string }

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_EXTRACT_CHARS = 200_000

// Google Workspace MIME types (export via Drive API — cannot be extracted from bytes)
const GOOGLE_WORKSPACE_MIMES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.form',
])

// ─── MIME / extension helpers ─────────────────────────────────────────────────

/** True when the MIME type is a Google Workspace file that needs the Drive export API. */
export function isGoogleWorkspaceMime(mimeType: string): boolean {
  return GOOGLE_WORKSPACE_MIMES.has(mimeType)
}

/** Returns the canonical extension for a filename (lowercased, includes dot). */
function getExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
}

// ─── RTF stripper ─────────────────────────────────────────────────────────────

/**
 * Minimal RTF plain-text extractor.
 * Removes RTF control words and braces; decodes common \'XX hex escapes.
 */
function extractRtf(content: string): string {
  let text = content
  // Strip all RTF control words (backslash sequences + optional numeric param)
  text = text.replace(/\\[a-z*]+[-\d]* ?/gi, ' ')
  // Decode \' hex pairs (RTF code page escape)
  text = text.replace(/\\'([0-9a-f]{2})/gi, (_, hex) => {
    const code = parseInt(hex, 16)
    return code > 127 ? '?' : String.fromCharCode(code)
  })
  // Remove curly braces and backslashes
  text = text.replace(/[{}\\]/g, ' ')
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

// ─── extractTextFromBuffer ─────────────────────────────────────────────────────

/**
 * Extracts plain text from a file buffer.
 *
 * @param buffer    Raw file bytes
 * @param fileName  Original filename (used for extension detection)
 * @param mimeType  MIME type from the browser or API
 *
 * Note: Google Workspace files (Docs, Sheets, Slides) cannot be extracted
 * from bytes — they need the Drive export API.  Call extractGoogleWorkspaceContent()
 * for those MIME types instead.
 */
export async function extractTextFromBuffer(
  buffer:   ArrayBuffer | Buffer,
  fileName: string,
  mimeType: string,
): Promise<ExtractionResult> {
  const ext      = getExt(fileName)
  const baseMime = mimeType.split(';')[0].trim().toLowerCase()

  // Google Workspace files need Drive export — cannot extract from bytes
  if (isGoogleWorkspaceMime(baseMime)) {
    return {
      ok:    false,
      error: `${fileName} is a Google Workspace file. Its content is extracted via the Drive API, not direct upload.`,
    }
  }

  // PowerPoint — not supported (would need full ZIP/XML parsing library)
  if (ext === '.pptx' || ext === '.ppt' ||
      baseMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      baseMime === 'application/vnd.ms-powerpoint') {
    return {
      ok:    false,
      error: `PowerPoint files (.pptx, .ppt) are not supported. Export the presentation to PDF or paste the text as a .txt file.`,
    }
  }

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)

  // ── Plain text (txt, md, csv) ───────────────────────────────────────────────
  if (
    ext === '.txt' || ext === '.md' || ext === '.csv' ||
    baseMime === 'text/plain' || baseMime === 'text/markdown' ||
    baseMime === 'text/x-markdown' || baseMime === 'text/csv' ||
    baseMime === 'application/octet-stream' && (ext === '.txt' || ext === '.md' || ext === '.csv')
  ) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      return { ok: true, text: text.slice(0, MAX_EXTRACT_CHARS) }
    } catch {
      return { ok: false, error: 'Could not read the file as UTF-8 text. Please check the file encoding.' }
    }
  }

  // ── RTF ────────────────────────────────────────────────────────────────────
  if (ext === '.rtf' || baseMime === 'text/rtf' || baseMime === 'application/rtf') {
    try {
      const raw  = buf.toString('latin1')
      const text = extractRtf(raw)
      if (!text.trim()) return { ok: false, error: 'RTF file appears to be empty or unreadable.' }
      return { ok: true, text: text.slice(0, MAX_EXTRACT_CHARS) }
    } catch {
      return { ok: false, error: 'Failed to extract text from RTF file.' }
    }
  }

  // ── PDF ────────────────────────────────────────────────────────────────────
  if (
    ext === '.pdf' ||
    baseMime === 'application/pdf' ||
    baseMime === 'application/x-pdf'
  ) {
    try {
      // pdf-parse v2 API: PDFParse({ data: Buffer, verbosity: number })
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: buf, verbosity: -1 })
      const result = await parser.getText()
      const text   = (result.text ?? '').trim()

      if (!text) {
        return {
          ok:      true,
          text:    '',
          warning: 'PDF was parsed but no text was extracted. It may be a scanned image-only PDF (OCR is not available).',
        }
      }
      return { ok: true, text: text.slice(0, MAX_EXTRACT_CHARS) }
    } catch (err) {
      return { ok: false, error: `Failed to extract text from PDF: ${(err as Error).message}` }
    }
  }

  // ── DOCX / DOC ─────────────────────────────────────────────────────────────
  if (
    ext === '.docx' || ext === '.doc' ||
    baseMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    baseMime === 'application/msword'
  ) {
    try {
      const mammoth = await import('mammoth')
      const result  = await mammoth.extractRawText({ buffer: buf })
      const text    = (result.value ?? '').trim()

      if (!text) return { ok: false, error: 'Word document appears to be empty or image-only.' }
      return { ok: true, text: text.slice(0, MAX_EXTRACT_CHARS) }
    } catch (err) {
      return { ok: false, error: `Failed to extract text from Word document: ${(err as Error).message}` }
    }
  }

  // ── XLSX / XLS ─────────────────────────────────────────────────────────────
  if (
    ext === '.xlsx' || ext === '.xls' ||
    baseMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    baseMime === 'application/vnd.ms-excel'
  ) {
    try {
      const XLSX     = await import('xlsx')
      const workbook = XLSX.read(buf, { type: 'buffer' })
      const lines: string[] = []

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        const csv   = XLSX.utils.sheet_to_csv(sheet)
        if (csv.trim()) {
          lines.push(`[Sheet: ${sheetName}]`)
          lines.push(csv.trim())
          lines.push('')
        }
      }

      const text = lines.join('\n').trim()
      if (!text) return { ok: false, error: 'Spreadsheet appears to be empty.' }
      return { ok: true, text: text.slice(0, MAX_EXTRACT_CHARS) }
    } catch (err) {
      return { ok: false, error: `Failed to extract text from spreadsheet: ${(err as Error).message}` }
    }
  }

  // ── Unsupported ────────────────────────────────────────────────────────────
  return {
    ok:    false,
    error: `Unsupported file type "${ext || baseMime}". Supported formats: .txt, .md, .csv, .rtf, .pdf, .docx, .doc, .xlsx, .xls`,
  }
}

// ─── extractKeywordExcerpt ─────────────────────────────────────────────────────

/**
 * Extracts a keyword-relevant excerpt from a long document.
 * When keywords are provided, returns the most relevant lines up to maxChars.
 * When no keywords match, returns the leading content.
 *
 * This is the same algorithm as extractTranscriptExcerpt in lib/brain/meetings.ts
 * but operates on plain text (no transcript markup stripping).
 */
export function extractKeywordExcerpt(
  text:     string,
  keywords: string[],
  maxChars  = 4_000,
): string {
  if (!text.trim()) return ''
  if (text.length <= maxChars) return text

  const terms = keywords
    .map(k => k.toLowerCase().trim())
    .filter(k => k.length >= 3)

  if (terms.length === 0) {
    return text.slice(0, maxChars) + '…'
  }

  const lines  = text.split(/\n+/).filter(l => l.trim().length > 0)
  const scored = lines
    .map(line => {
      const lower = line.toLowerCase()
      const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0)
      return { line, score }
    })
    .filter(({ score }) => score > 0)

  if (scored.length === 0) {
    return text.slice(0, maxChars) + '…'
  }

  scored.sort((a, b) => b.score - a.score)

  let totalChars = 0
  const excerptLines: string[] = []
  for (const { line } of scored) {
    if (totalChars + line.length + 1 > maxChars) break
    excerptLines.push(line)
    totalChars += line.length + 1
  }

  const excerpt = excerptLines.join('\n')
  return excerpt.length > maxChars ? excerpt.slice(0, maxChars) + '…' : excerpt
}
