// lib/client/stale-version.ts
//
// Shared client-side handling for a browser tab that is running an older build
// than the server ("Failed to find Server Action", UnrecognizedActionError).
// Server Action IDs change between builds, so any tab left open across a deploy
// can no longer call its actions until the page is reloaded.
//
// This module only detects and records the condition. It never reloads the page:
// the banner offers a Refresh button so unsaved input is not discarded unprompted.

import { unstable_isUnrecognizedActionError } from 'next/navigation'

const STALE_ACTION_MESSAGE = /Server Action .* was not found on the server|Failed to find Server Action/i

/** True when `err` means this tab's build no longer matches the deployed server. */
export function isStaleVersionError(err: unknown): boolean {
  if (unstable_isUnrecognizedActionError(err)) return true
  // Fallback for errors that crossed a boundary and lost their prototype.
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown }
    if (e.name === 'UnrecognizedActionError') return true
    if (typeof e.message === 'string' && STALE_ACTION_MESSAGE.test(e.message)) return true
  }
  return typeof err === 'string' && STALE_ACTION_MESSAGE.test(err)
}

// ─── Tiny external store (useSyncExternalStore-compatible) ───────────────────

let stale = false
let dismissed = false
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

/** Record that the tab is out of date. Idempotent. */
export function reportStaleVersion() {
  if (stale && !dismissed) return
  stale = true
  dismissed = false
  emit()
}

export function dismissStaleVersion() {
  dismissed = true
  emit()
}

export function subscribeStaleVersion(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** True while the "newer version available" notice should be showing. */
export function getStaleVersionSnapshot() {
  return stale && !dismissed
}

/** Test helper. */
export function resetStaleVersionForTests() {
  stale = false
  dismissed = false
  listeners.clear()
}

/**
 * Normalise a failure from a server action call into UI state, recording
 * stale-version errors so the app-wide banner appears too.
 */
export function classifyActionError(err: unknown): 'stale' | 'failed' {
  if (isStaleVersionError(err)) {
    reportStaleVersion()
    return 'stale'
  }
  return 'failed'
}

// ─── Search request wrapper ──────────────────────────────────────────────────

export type RequestOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'stale' }
  | { kind: 'failed' }

/**
 * Run a server action and turn every outcome into data. Never throws, so a
 * caller that always clears its loading flag afterwards cannot get stuck.
 */
export async function settleAction<T>(call: () => Promise<T>): Promise<RequestOutcome<T>> {
  try {
    return { kind: 'ok', data: await call() }
  } catch (err) {
    return { kind: classifyActionError(err) }
  }
}
