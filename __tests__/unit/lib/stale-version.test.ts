import { describe, it, expect, beforeEach } from 'vitest'
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error'
import {
  classifyActionError,
  getStaleVersionSnapshot,
  isStaleVersionError,
  dismissStaleVersion,
  reportStaleVersion,
  resetStaleVersionForTests,
  settleAction,
  subscribeStaleVersion,
} from '@/lib/client/stale-version'

const stale = () =>
  new UnrecognizedActionError(
    'Server Action "7f3a" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
  )

beforeEach(() => resetStaleVersionForTests())

describe('isStaleVersionError', () => {
  it('recognises Next\'s UnrecognizedActionError', () => {
    expect(isStaleVersionError(stale())).toBe(true)
  })

  it('recognises the error after it lost its prototype (message / name only)', () => {
    expect(isStaleVersionError(new Error('Server Action "abc" was not found on the server.'))).toBe(true)
    expect(isStaleVersionError({ name: 'UnrecognizedActionError', message: 'x' })).toBe(true)
  })

  it('does not misclassify ordinary failures', () => {
    expect(isStaleVersionError(new Error('Search failed.'))).toBe(false)
    expect(isStaleVersionError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isStaleVersionError(null)).toBe(false)
    expect(isStaleVersionError(undefined)).toBe(false)
  })
})

describe('settleAction', () => {
  it('passes results through, including empty results', async () => {
    expect(await settleAction(async () => ({ tasks: [] }))).toEqual({ kind: 'ok', data: { tasks: [] } })
  })

  it('turns a thrown stale-version error into data and flags the app-wide banner', async () => {
    const seen: boolean[] = []
    subscribeStaleVersion(() => seen.push(getStaleVersionSnapshot()))
    const outcome = await settleAction(async () => { throw stale() })
    expect(outcome).toEqual({ kind: 'stale' })
    expect(getStaleVersionSnapshot()).toBe(true)
    expect(seen).toContain(true)
  })

  it('turns any other failure into "failed" without touching the banner', async () => {
    const outcome = await settleAction(async () => { throw new Error('boom') })
    expect(outcome).toEqual({ kind: 'failed' })
    expect(getStaleVersionSnapshot()).toBe(false)
  })

  it('never rejects, so callers always reach their loading-state cleanup', async () => {
    await expect(settleAction(() => Promise.reject(stale()))).resolves.toBeDefined()
    await expect(settleAction(() => { throw new Error('sync throw') })).resolves.toEqual({ kind: 'failed' })
  })
})

describe('stale-version store', () => {
  it('is idempotent, dismissible, and re-arms on the next stale error', () => {
    let notifications = 0
    subscribeStaleVersion(() => { notifications++ })
    reportStaleVersion()
    reportStaleVersion()
    expect(notifications).toBe(1)
    expect(getStaleVersionSnapshot()).toBe(true)

    dismissStaleVersion()
    expect(getStaleVersionSnapshot()).toBe(false)

    expect(classifyActionError(stale())).toBe('stale')
    expect(getStaleVersionSnapshot()).toBe(true)
  })
})
