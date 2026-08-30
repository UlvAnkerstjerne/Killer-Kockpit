'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createAppUser } from '@/lib/actions/users'
import type { KKRole } from '@/lib/types'

export default function NewUserForm() {
  const router = useRouter()
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<KKRole>('MEMBER')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!displayName.trim() || !email.trim() || submitting) return

    setSubmitting(true)
    setError(null)

    const result = await createAppUser({ email, display_name: displayName, role })

    if (result.error) {
      setError(result.error)
      setSubmitting(false)
      return
    }

    router.push('/team/users')
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Full name</label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Jane Smith"
          required
          maxLength={200}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jane@killerkebab.com"
          required
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink placeholder-kk-muted focus:outline-none focus:border-kk-ink transition-colors"
        />
        <p className="mt-1 text-xs text-kk-muted">Must be a @killerkebab.com Google account.</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-kk-ink mb-1.5">Role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as KKRole)}
          disabled={submitting}
          className="w-full px-3 py-2.5 border border-kk-line rounded-xl text-sm text-kk-ink focus:outline-none focus:border-kk-ink transition-colors bg-white"
        >
          <option value="MEMBER">MEMBER — Standard access, own tasks/projects</option>
          <option value="UM">UM — Management view, all tasks/projects</option>
          <option value="SUPER_ADMIN">SUPER_ADMIN — Full access including user management</option>
        </select>
      </div>

      {error && <p className="text-sm text-kk-bad">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={!displayName.trim() || !email.trim() || submitting}
          className="flex-1 py-2.5 bg-kk-ink text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {submitting ? 'Adding…' : 'Add user'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/team/users')}
          className="px-5 py-2.5 border border-kk-line text-sm text-kk-muted rounded-xl hover:bg-kk-soft transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
