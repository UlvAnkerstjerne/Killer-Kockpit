'use client'

/**
 * components/people/EmployeeLocationsSection.tsx
 *
 * Displays and manages the canonical Employee↔Location assignments for one
 * employee.  Management users (SUPER_ADMIN + UM) may add and remove locations.
 * The relationship is soft-deactivated on remove — never deleted.
 *
 * Exports getAvailableLocations() for unit testing.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  addEmployeeLocation,
  removeEmployeeLocation,
} from '@/lib/actions/employee-locations'
import type { LocationForEmployee } from '@/lib/actions/employee-locations'

export interface AllLocation {
  id:         string
  name:       string
  short_name: string
}

interface Props {
  employeeId:       string
  initialLocations: LocationForEmployee[]
  allLocations:     AllLocation[]   // all active canonical locations for the selector
  canManage:        boolean
}

/**
 * Returns the subset of allLocations not already actively assigned.
 * Pure function — exported for unit testing.
 */
export function getAvailableLocations(
  allLocations: AllLocation[],
  assignedIds: string[],
): AllLocation[] {
  const assigned = new Set(assignedIds)
  return allLocations.filter((l) => !assigned.has(l.id))
}

export default function EmployeeLocationsSection({
  employeeId,
  initialLocations,
  allLocations,
  canManage,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [isSelectorOpen, setIsSelectorOpen] = useState(false)
  const [selectedId,     setSelectedId]     = useState('')
  const [addError,       setAddError]       = useState<string | null>(null)
  const [removeError,    setRemoveError]    = useState<string | null>(null)

  const assignedIds = initialLocations.map((l) => l.location_id)
  const available   = getAvailableLocations(allLocations, assignedIds)

  function openSelector() {
    setSelectedId(available[0]?.id ?? '')
    setAddError(null)
    setIsSelectorOpen(true)
  }

  function closeSelector() {
    setIsSelectorOpen(false)
    setAddError(null)
  }

  function handleAdd() {
    if (!selectedId || isPending) return
    setAddError(null)

    startTransition(async () => {
      const result = await addEmployeeLocation(employeeId, selectedId)
      if (result.error) {
        setAddError(result.error)
        return
      }
      setIsSelectorOpen(false)
      router.refresh()
    })
  }

  function handleRemove(locationId: string) {
    if (isPending) return
    setRemoveError(null)

    startTransition(async () => {
      const result = await removeEmployeeLocation(employeeId, locationId)
      if (result.error) {
        setRemoveError(result.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="bg-kk-panel border border-kk-line rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-kk-line">
        <h2 className="text-sm font-semibold text-kk-ink">Locations</h2>
        {canManage && !isSelectorOpen && available.length > 0 && (
          <button
            type="button"
            onClick={openSelector}
            disabled={isPending}
            className="text-xs px-3 py-1.5 bg-kk-soft border border-kk-line rounded-lg text-kk-ink hover:bg-kk-line transition-colors disabled:opacity-40"
          >
            + Add location
          </button>
        )}
      </div>

      {/* Current assignments */}
      <div>
        {initialLocations.length === 0 && !isSelectorOpen && (
          <div className="px-5 py-4">
            <p className="text-sm text-kk-muted">No locations assigned.</p>
            {canManage && available.length > 0 && (
              <button
                type="button"
                onClick={openSelector}
                disabled={isPending}
                className="mt-2 text-xs text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-40"
              >
                + Add location
              </button>
            )}
          </div>
        )}

        {initialLocations.map((loc) => (
          <div
            key={loc.location_id}
            className="flex items-center justify-between px-5 py-3 border-b border-kk-line last:border-b-0"
          >
            <div>
              <span className="text-sm text-kk-ink">{loc.name}</span>
              <span className="ml-2 text-xs text-kk-muted">{loc.short_name}</span>
            </div>
            {canManage && (
              <button
                type="button"
                onClick={() => handleRemove(loc.location_id)}
                disabled={isPending}
                aria-label={`Remove ${loc.name}`}
                className="text-xs text-kk-muted hover:text-kk-bad transition-colors disabled:opacity-40 ml-4 shrink-0"
              >
                ×
              </button>
            )}
          </div>
        ))}

        {/* Remove error */}
        {removeError && (
          <div className="px-5 py-3 border-t border-kk-line">
            <p className="text-xs text-kk-bad">{removeError}</p>
          </div>
        )}
      </div>

      {/* Add selector — inline */}
      {isSelectorOpen && (
        <div className="px-5 py-4 border-t border-kk-line space-y-3">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            disabled={isPending}
            className="w-full text-sm px-3 py-2 bg-kk-soft border border-kk-line rounded-xl focus:outline-none focus:ring-2 focus:ring-kk-ink/20 disabled:opacity-60"
          >
            {available.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.short_name})
              </option>
            ))}
          </select>

          {addError && (
            <p className="text-xs text-kk-bad">{addError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAdd}
              disabled={isPending || !selectedId}
              className="text-xs px-3 py-1.5 bg-kk-ink text-kk-panel rounded-lg hover:opacity-80 transition-opacity disabled:opacity-40"
            >
              {isPending ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={closeSelector}
              disabled={isPending}
              className="text-xs px-3 py-1.5 border border-kk-line text-kk-muted rounded-lg hover:border-kk-ink hover:text-kk-ink transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
