/**
 * Tests for lib/google/calendar.ts
 * Tests pure/deterministic functions only.
 * Live Google API calls are not tested here — those require credentials.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL            = 'https://kk.test'
  process.env.GOOGLE_MANAGEMENT_CALENDAR_ID  = 'management@group.calendar.google.com'
})
afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.GOOGLE_MANAGEMENT_CALENDAR_ID
})

describe('buildCalendarEventId', () => {
  it('prefixes with kk and removes hyphens', async () => {
    const { buildCalendarEventId } = await import('@/lib/google/calendar')
    expect(buildCalendarEventId('550e8400-e29b-41d4-a716-446655440000'))
      .toBe('kk550e8400e29b41d4a716446655440000')
  })

  it('is deterministic for the same input', async () => {
    const { buildCalendarEventId } = await import('@/lib/google/calendar')
    const id = '00000000-0000-0000-0000-000000000001'
    expect(buildCalendarEventId(id)).toBe(buildCalendarEventId(id))
  })

  it('produces different IDs for different meetings', async () => {
    const { buildCalendarEventId } = await import('@/lib/google/calendar')
    expect(buildCalendarEventId('aaaaaaaa-0000-0000-0000-000000000001'))
      .not.toBe(buildCalendarEventId('bbbbbbbb-0000-0000-0000-000000000001'))
  })

  it('produces a result ≥5 chars and only lowercase alphanumeric', async () => {
    const { buildCalendarEventId } = await import('@/lib/google/calendar')
    const result = buildCalendarEventId('123e4567-e89b-12d3-a456-426614174000')
    expect(result.length).toBeGreaterThanOrEqual(5)
    expect(result).toMatch(/^[a-z0-9]+$/)
  })
})

describe('buildCalendarEvent', () => {
  it('sets id, summary, start, end and description link', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id:              '550e8400-e29b-41d4-a716-446655440000',
      title:           'Leadership Sync',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], null)
    expect(event.id).toBe('kk550e8400e29b41d4a716446655440000')
    expect(event.summary).toBe('Leadership Sync')
    expect(event.start?.dateTime).toBe('2026-09-01T10:00:00+02:00')
    expect(event.end?.dateTime).toBe('2026-09-01T11:00:00+02:00')
    expect(event.description).toContain('https://kk.test/meetings/550e8400-e29b-41d4-a716-446655440000')
  })

  it('includes project name when provided', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      title: 'Q4 Review',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], { title: 'KK Copenhagen Expansion' })
    expect(event.description).toContain('Project: KK Copenhagen Expansion')
  })

  it('does NOT include project name when null', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000002',
      title: 'Standup',
      scheduled_start: '2026-09-01T09:00:00+02:00',
      scheduled_end:   '2026-09-01T09:15:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], null)
    expect(event.description).not.toContain('Project:')
  })

  it('maps attendee emails and omits null/undefined emails', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000003',
      title: 'Test',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const attendees = [
      { email: 'alice@killerkebab.com' },
      { email: null },
      { email: 'bob@killerkebab.com' },
    ]
    const event = buildCalendarEvent(meeting, attendees, null)
    expect(event.attendees).toHaveLength(2)
    expect(event.attendees?.map((a) => a.email)).toEqual([
      'alice@killerkebab.com',
      'bob@killerkebab.com',
    ])
  })

  it('omits attendees property when list is empty', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000004',
      title: 'Solo',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], null)
    expect(event.attendees).toBeUndefined()
  })

  it('uses default visibility', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000005',
      title: 'T',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], null)
    expect(event.visibility).toBe('default')
  })

  it('does NOT include working notes, minutes or corrections in description', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000006',
      title: 'Confidential',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], null)
    // Description must only contain the KK link and the KK attribution
    const lines = (event.description ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines).toHaveLength(2) // link + attribution
  })

  // ── conferenceData / Meet conference creation ──────────────────────────

  it('does NOT include conferenceData by default (requestConference omitted)', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000007',
      title: 'No Conference',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], null)
    expect(event.conferenceData).toBeUndefined()
  })

  it('does NOT include conferenceData when requestConference=false', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000008',
      title: 'No Conference Explicit',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], null, false)
    expect(event.conferenceData).toBeUndefined()
  })

  it('includes conferenceData.createRequest when requestConference=true', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000009',
      title: 'With Meet',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], null, true)
    expect(event.conferenceData).toBeDefined()
    expect(event.conferenceData?.createRequest?.requestId).toBe(meeting.id)
    expect(event.conferenceData?.createRequest?.conferenceSolutionKey?.type).toBe('hangoutsMeet')
  })

  it('uses the meeting.id as requestId — stable across retries', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'stable-id-0000-0000-0000-000000000010',
      title: 'Idempotent',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event1 = buildCalendarEvent(meeting, [], null, true)
    const event2 = buildCalendarEvent(meeting, [], null, true)
    expect(event1.conferenceData?.createRequest?.requestId)
      .toBe(event2.conferenceData?.createRequest?.requestId)
  })

  it('does NOT include recording or smart-notes config in conferenceData', async () => {
    const { buildCalendarEvent } = await import('@/lib/google/calendar')
    const meeting = {
      id: 'aaaaaaaa-0000-0000-0000-000000000011',
      title: 'Safe Conference',
      scheduled_start: '2026-09-01T10:00:00+02:00',
      scheduled_end:   '2026-09-01T11:00:00+02:00',
    }
    const event = buildCalendarEvent(meeting, [], null, true)
    // Only createRequest key should be present under conferenceData
    const keys = Object.keys(event.conferenceData ?? {})
    expect(keys).toEqual(['createRequest'])
  })
})
