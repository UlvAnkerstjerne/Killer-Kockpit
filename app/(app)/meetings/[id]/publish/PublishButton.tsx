'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { publishMeeting } from '@/lib/actions/meetings'

export default function PublishButton({ meetingId }: { meetingId: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePublish() {
    if (loading) return
    setLoading(true)
    setError(null)

    const result = await publishMeeting(meetingId)
    if (result.error) {
      setError(result.error)
      setLoading(false)
    } else {
      router.push(`/meetings/${meetingId}`)
    }
  }

  return (
    <div>
      <button
        onClick={handlePublish}
        disabled={loading}
        className="w-full py-3 bg-kk-good-bg text-kk-good text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        {loading ? 'Publishing…' : 'Publish minutes & create all outcomes'}
      </button>
      {error && <p className="text-sm text-kk-bad mt-2">{error}</p>}
    </div>
  )
}
