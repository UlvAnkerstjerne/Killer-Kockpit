'use client'

/**
 * Thin wrapper kept for backwards compatibility with the project detail page.
 * All rendering is handled by EntityUpdatesSection.
 */

import EntityUpdatesSection from './EntityUpdatesSection'
import type { UpdateRow } from '@/lib/types'

interface Props {
  projectId:      string
  initialUpdates: UpdateRow[]
  canAddUpdate:   boolean
}

export default function ProjectUpdatesSection({ projectId, initialUpdates, canAddUpdate }: Props) {
  return (
    <EntityUpdatesSection
      entityType="project"
      entityId={projectId}
      initialUpdates={initialUpdates}
      canAddUpdate={canAddUpdate}
    />
  )
}
