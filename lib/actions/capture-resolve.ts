/**
 * lib/actions/capture-resolve.ts
 *
 * Pure, synchronous entity resolution for Quick Capture (M8B3/M8B4).
 * Lives outside capture.ts so it can be exported from a non-server-action file
 * ('use server' files may only export async functions).
 */

import type { KkUpdateEntityType } from '@/lib/types'
import type { CandidateEntityRef } from '@/lib/ai/capture-analysis-schema'

// ─── Enriched output types ────────────────────────────────────────────────────

export type ResolvedEntityRef = {
  entity_type:  KkUpdateEntityType
  name_hint:    string
  status:       'resolved'
  entity_id:    string
  display_name: string
  match_kind:   'exact' | 'partial'
}

export type AmbiguousEntityRef = {
  entity_type: KkUpdateEntityType
  name_hint:   string
  status:      'ambiguous'
  candidates:  { entity_id: string; display_name: string }[]
}

export type NotFoundEntityRef = {
  entity_type: KkUpdateEntityType
  name_hint:   string
  status:      'not_found'
}

export type EnrichedEntityRef =
  | ResolvedEntityRef
  | AmbiguousEntityRef
  | NotFoundEntityRef

// ─── Helpers ──────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().trim()
}

interface PoolEntry {
  entity_id:    string
  display_name: string
  alt_name?:    string
}

function buildPool(
  entityType: KkUpdateEntityType,
  projects:   { id: string; title: string }[],
  employees:  { id: string; name: string }[],
  locations:  { id: string; name: string; short_name: string | null }[],
): PoolEntry[] {
  if (entityType === 'project') {
    return projects.map(p => ({ entity_id: p.id, display_name: p.title }))
  }
  if (entityType === 'employee') {
    return employees.map(e => ({ entity_id: e.id, display_name: e.name }))
  }
  return locations.map(l => ({
    entity_id:    l.id,
    display_name: l.name,
    alt_name:     l.short_name ?? undefined,
  }))
}

function matchesExact(entry: PoolEntry, hint: string): boolean {
  return (
    norm(entry.display_name) === hint ||
    (entry.alt_name !== undefined && norm(entry.alt_name) === hint)
  )
}

function matchesPartial(entry: PoolEntry, hint: string): boolean {
  const dn = norm(entry.display_name)
  const an = entry.alt_name !== undefined ? norm(entry.alt_name) : null
  return (
    dn.includes(hint) ||
    hint.includes(dn) ||
    (an !== null && (an.includes(hint) || hint.includes(an)))
  )
}

// ─── Informal-reference fallback ──────────────────────────────────────────────
//
// Used after exact matching, merged with substring matches, and only for projects
// and locations (never people). Compares the DISTINCTIVE words of a title with the
// hint's words, so "catering", "our catering" and "the catering delivery" resolve to
// "Killer Katering" even though "catering" is not a substring of "katering".
// Deterministic and conservative: a single match resolves, several are ambiguous.

const FILLER_WORDS = new Set([
  'killer', 'kebab', 'the', 'our', 'a', 'an', 'of', 'for', 'and', 'to', 'in', 'at', 'on',
  'project', 'team', 'new', 'first', 'last', 'next',
])

/** Lower-case, strip diacritics/punctuation, fold the c/k spelling variant (catering ≈ katering). */
function fold(word: string): string {
  return word
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9æøå]/gi, '')
    .toLowerCase()
    .replace(/c/g, 'k')
}

function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || FILLER_WORDS.has(raw)) continue
    const f = fold(raw)
    if (f.length >= 3) out.add(f)
  }
  return out
}

function matchesInformally(entry: PoolEntry, hintTokens: Set<string>): boolean {
  if (hintTokens.size === 0) return false
  for (const name of [entry.display_name, entry.alt_name]) {
    if (!name) continue
    const nameTokens = distinctiveTokens(name)
    if (nameTokens.size === 0) continue
    // Every distinctive word of the title appears in the hint ("the catering delivery" ⊇ {katering})…
    if ([...nameTokens].every(t => hintTokens.has(t))) return true
    // …or every distinctive word of the hint appears in the title ("airport" ⊆ {kph, airport, ssp}).
    if ([...hintTokens].every(t => nameTokens.has(t))) return true
  }
  return false
}

// ─── Public ───────────────────────────────────────────────────────────────────

export function resolveEntityRef(
  ref: CandidateEntityRef,
  projects:  { id: string; title: string }[],
  employees: { id: string; name: string }[],
  locations: { id: string; name: string; short_name: string | null }[],
): EnrichedEntityRef {
  const pool = buildPool(ref.entity_type, projects, employees, locations)
  const hint = norm(ref.name_hint)

  const exact = pool.filter(e => matchesExact(e, hint))
  if (exact.length === 1) {
    return {
      entity_type:  ref.entity_type,
      name_hint:    ref.name_hint,
      status:       'resolved',
      entity_id:    exact[0].entity_id,
      display_name: exact[0].display_name,
      match_kind:   'exact',
    }
  }
  if (exact.length > 1) {
    return {
      entity_type: ref.entity_type,
      name_hint:   ref.name_hint,
      status:      'ambiguous',
      candidates:  exact.map(e => ({ entity_id: e.entity_id, display_name: e.display_name })),
    }
  }

  // Substring matches, plus (projects/locations only) informal word matches such as
  // "catering" → "Killer Katering". Merged so a hint that fits two entities is ambiguous
  // rather than silently resolving to whichever one happened to contain the substring.
  const partial = pool.filter(e => matchesPartial(e, hint))
  const hintTokens = ref.entity_type === 'employee' ? new Set<string>() : distinctiveTokens(ref.name_hint)
  const informal = ref.entity_type === 'employee' ? [] : pool.filter(e => matchesInformally(e, hintTokens))
  const matches = [...new Map([...partial, ...informal].map(e => [e.entity_id, e])).values()]

  if (matches.length === 1) {
    return {
      entity_type:  ref.entity_type,
      name_hint:    ref.name_hint,
      status:       'resolved',
      entity_id:    matches[0].entity_id,
      display_name: matches[0].display_name,
      match_kind:   'partial',
    }
  }
  if (matches.length > 1) {
    return {
      entity_type: ref.entity_type,
      name_hint:   ref.name_hint,
      status:      'ambiguous',
      candidates:  matches.map(e => ({ entity_id: e.entity_id, display_name: e.display_name })),
    }
  }

  return {
    entity_type: ref.entity_type,
    name_hint:   ref.name_hint,
    status:      'not_found',
  }
}
