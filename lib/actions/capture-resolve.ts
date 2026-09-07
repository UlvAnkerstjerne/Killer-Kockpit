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

  const partial = pool.filter(e => matchesPartial(e, hint))
  if (partial.length === 1) {
    return {
      entity_type:  ref.entity_type,
      name_hint:    ref.name_hint,
      status:       'resolved',
      entity_id:    partial[0].entity_id,
      display_name: partial[0].display_name,
      match_kind:   'partial',
    }
  }
  if (partial.length > 1) {
    return {
      entity_type: ref.entity_type,
      name_hint:   ref.name_hint,
      status:      'ambiguous',
      candidates:  partial.map(e => ({ entity_id: e.entity_id, display_name: e.display_name })),
    }
  }

  return {
    entity_type: ref.entity_type,
    name_hint:   ref.name_hint,
    status:      'not_found',
  }
}
