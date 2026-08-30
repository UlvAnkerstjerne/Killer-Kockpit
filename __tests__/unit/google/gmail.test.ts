/**
 * Tests for lib/google/gmail.ts
 *
 * Covers the pure utility functions:
 *   • stripHtmlTags
 *   • extractPlainText
 *   • buildGmailDeepLink
 *
 * The Gmail API calls (listInboxMessages, getMessageFull) require live
 * OAuth credentials and are not tested here.
 */

import { describe, it, expect } from 'vitest'
import { stripHtmlTags, extractPlainText, buildGmailDeepLink } from '@/lib/google/gmail'
import type { gmail_v1 } from 'googleapis'

// ─── stripHtmlTags ────────────────────────────────────────────────────────

describe('stripHtmlTags', () => {
  it('removes simple tags', () => {
    expect(stripHtmlTags('<p>Hello world</p>')).toBe('Hello world')
  })

  it('converts <br> to newline', () => {
    expect(stripHtmlTags('line one<br>line two')).toBe('line one\nline two')
  })

  it('converts </p> to double newline', () => {
    const result = stripHtmlTags('<p>First</p><p>Second</p>')
    expect(result).toContain('First')
    expect(result).toContain('Second')
    expect(result).toMatch(/First\n\nSecond/)
  })

  it('strips <style> blocks entirely', () => {
    const html = '<style>body { color: red; }</style><p>Content</p>'
    const result = stripHtmlTags(html)
    expect(result).not.toContain('color: red')
    expect(result).toContain('Content')
  })

  it('strips <script> blocks entirely', () => {
    const html = '<script>alert("xss")</script><p>Safe</p>'
    const result = stripHtmlTags(html)
    expect(result).not.toContain('alert')
    expect(result).toContain('Safe')
  })

  it('decodes HTML entities', () => {
    // &nbsp; → ' ' then trim removes trailing spaces
    expect(stripHtmlTags('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe("& < > \" '")
  })

  it('collapses 3+ consecutive newlines to 2', () => {
    const result = stripHtmlTags('a</p></p></p>b')
    expect(result).not.toMatch(/\n{3,}/)
  })

  it('trims leading/trailing whitespace', () => {
    expect(stripHtmlTags('  <p>text</p>  ')).toBe('text')
  })

  it('returns empty string for empty input', () => {
    expect(stripHtmlTags('')).toBe('')
  })
})

// ─── extractPlainText ─────────────────────────────────────────────────────

function makePart(
  mimeType: string,
  text: string,
  parts?: gmail_v1.Schema$MessagePart[],
): gmail_v1.Schema$MessagePart {
  return {
    mimeType,
    body: {
      data: text ? Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '') : undefined,
    },
    parts,
  }
}

describe('extractPlainText', () => {
  it('returns text/plain body directly', () => {
    const part = makePart('text/plain', 'Hello from plain text')
    expect(extractPlainText(part)).toBe('Hello from plain text')
  })

  it('strips HTML from text/html body', () => {
    const part = makePart('text/html', '<p>Hello</p>')
    const result = extractPlainText(part)
    expect(result).toContain('Hello')
    expect(result).not.toContain('<p>')
  })

  it('prefers text/plain over text/html in multipart/alternative', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        makePart('text/plain', 'Plain version'),
        makePart('text/html', '<p>HTML version</p>'),
      ],
    }
    expect(extractPlainText(payload)).toBe('Plain version')
  })

  it('falls back to text/html when no text/plain in multipart', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        makePart('text/html', '<p>HTML only</p>'),
      ],
    }
    const result = extractPlainText(payload)
    expect(result).toContain('HTML only')
  })

  it('recurses into nested multipart parts', () => {
    const inner: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        makePart('text/plain', 'Nested plain text'),
      ],
    }
    const outer: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [inner],
    }
    expect(extractPlainText(outer)).toBe('Nested plain text')
  })

  it('returns empty string when no readable part found', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'application/pdf', body: {} }],
    }
    expect(extractPlainText(payload)).toBe('')
  })
})

// ─── buildGmailDeepLink ───────────────────────────────────────────────────

describe('buildGmailDeepLink', () => {
  it('includes authuser param when email is provided', () => {
    const url = buildGmailDeepLink('ulv@example.com', 'abc123')
    expect(url).toContain('authuser=ulv%40example.com')
    expect(url).toContain('#all/abc123')
  })

  it('omits authuser when email is null', () => {
    const url = buildGmailDeepLink(null, 'abc123')
    expect(url).not.toContain('authuser')
    expect(url).toContain('#all/abc123')
  })

  it('returns a mail.google.com URL', () => {
    const url = buildGmailDeepLink('user@example.com', 'msgid')
    expect(url).toMatch(/^https:\/\/mail\.google\.com\//)
  })

  it('uses #all/ anchor so archived messages are reachable', () => {
    expect(buildGmailDeepLink(null, 'xyz')).toContain('#all/xyz')
  })
})
