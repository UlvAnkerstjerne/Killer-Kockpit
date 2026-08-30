'use client'

import { useState } from 'react'
import { updateAppUserRole, setAppUserActive } from '@/lib/actions/users'
import type { KKRole } from '@/lib/types'

type TargetUser = {
  id: string
  display_name: string
  email: string
  role: string
  active: boolean
  google_subject_id: string | null
}

export default function UserManagementRow({
  targetUser,
  currentUserId,
}: {
  targetUser: TargetUser
  currentUserId: string
}) {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const isSelf = targetUser.id === currentUserId

  async function handleRoleChange(newRole: KKRole) {
    setLoading(true)
    setError(null)
    const result = await updateAppUserRole(targetUser.id, newRole)
    if (result.error) setError(result.error)
    setLoading(false)
  }

  async function handleToggleActive() {
    setLoading(true)
    setError(null)
    const result = await setAppUserActive(targetUser.id, !targetUser.active)
    if (result.error) setError(result.error)
    setLoading(false)
  }

  return (
    <div className="grid grid-cols-[1fr_120px_120px_100px_48px] items-center hover:bg-kk-soft transition-colors">
      <div className="px-5 py-4">
        <div className="text-sm font-medium text-kk-ink">{targetUser.display_name}</div>
        <div className="text-xs text-kk-muted">{targetUser.email}</div>
        {error && <div className="text-xs text-kk-bad mt-1">{error}</div>}
      </div>

      <div className="px-3 py-4">
        <select
          value={targetUser.role}
          onChange={(e) => handleRoleChange(e.target.value as KKRole)}
          disabled={loading || isSelf}
          className="text-xs border border-kk-line rounded-lg px-2 py-1 bg-white text-kk-ink focus:outline-none focus:border-kk-ink disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="SUPER_ADMIN">SUPER_ADMIN</option>
          <option value="UM">UM</option>
          <option value="MEMBER">MEMBER</option>
        </select>
      </div>

      <div className="px-3 py-4">
        <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${
          targetUser.active ? 'bg-kk-good-bg text-kk-good' : 'bg-kk-soft text-kk-muted'
        }`}>
          {targetUser.active ? 'Active' : 'Inactive'}
        </span>
      </div>

      <div className="px-3 py-4">
        {targetUser.google_subject_id ? (
          <span className="text-xs text-kk-good">Google linked</span>
        ) : (
          <span className="text-xs text-kk-muted">Pending login</span>
        )}
      </div>

      <div className="px-3 py-4">
        {!isSelf && (
          <button
            onClick={handleToggleActive}
            disabled={loading}
            className="text-xs text-kk-muted hover:text-kk-ink transition-colors disabled:opacity-50"
            title={targetUser.active ? 'Deactivate' : 'Activate'}
          >
            {targetUser.active ? 'Deact.' : 'Act.'}
          </button>
        )}
      </div>
    </div>
  )
}
