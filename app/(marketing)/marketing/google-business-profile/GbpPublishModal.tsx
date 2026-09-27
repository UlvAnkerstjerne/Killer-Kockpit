'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { GbpLocationRow } from '@/lib/actions/marketing/gbp-reviews'
import { publishGbpPost, type GbpPublishResult } from '@/lib/actions/marketing/gbp-publish'

interface Props {
  locations: GbpLocationRow[]
}

type Mode = 'local_post' | 'photo'
type Phase = 'form' | 'publishing' | 'result'

const MAX_CAPTION = 1500
const MAX_IMAGE_MB = 10
const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp'

export default function GbpPublishModal({ locations }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('local_post')
  const [caption, setCaption] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(locations.map(l => l.id)))
  const [phase, setPhase] = useState<Phase>('form')
  const [result, setResult] = useState<GbpPublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const publishingRef = useRef(false)
  const requestIdRef = useRef(crypto.randomUUID())

  const activeLocations = locations.filter(l => l.active)

  const reset = useCallback(() => {
    setMode('local_post')
    setCaption('')
    setImageFile(null)
    setImagePreview(null)
    setSelectedIds(new Set(activeLocations.map(l => l.id)))
    setPhase('form')
    setResult(null)
    setError(null)
    publishingRef.current = false
    requestIdRef.current = crypto.randomUUID()
  }, [activeLocations])

  function handleOpen() {
    reset()
    setOpen(true)
  }

  function handleClose() {
    if (phase === 'publishing') return
    setOpen(false)
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Image must be JPEG, PNG, or WebP.')
      return
    }
    if (file.size > MAX_IMAGE_MB * 1024 * 1024) {
      setError(`Image must be under ${MAX_IMAGE_MB} MB.`)
      return
    }
    setError(null)
    setImageFile(file)
    const url = URL.createObjectURL(file)
    setImagePreview(url)
  }

  function toggleLocation(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (selectedIds.size === activeLocations.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(activeLocations.map(l => l.id)))
    }
  }

  const canSubmit = phase === 'form'
    && imageFile !== null
    && selectedIds.size > 0
    && (mode === 'photo' || caption.trim().length > 0)

  async function handlePublish() {
    if (!canSubmit || publishingRef.current) return
    publishingRef.current = true
    setPhase('publishing')
    setError(null)

    try {
      // Step 1: upload image to server (returns only trusted storage path)
      const formData = new FormData()
      formData.append('image', imageFile!)
      const uploadRes = await fetch('/api/gbp/publish', { method: 'POST', body: formData })
      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({ error: 'Upload failed.' }))
        throw new Error(body.error || 'Image upload failed.')
      }
      const { storagePath } = await uploadRes.json() as { storagePath: string }

      // Step 2: publish to locations (server resolves URL and MIME)
      const publishResult = await publishGbpPost({
        postType: mode,
        caption: mode === 'local_post' ? caption.trim() : undefined,
        imageStoragePath: storagePath,
        requestId: requestIdRef.current,
        locationIds: Array.from(selectedIds),
      })

      setResult(publishResult)
      setPhase('result')

      if (publishResult.succeeded > 0) {
        router.refresh()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publishing failed.')
      setPhase('form')
    } finally {
      publishingRef.current = false
    }
  }

  const selectedCount = selectedIds.size

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        className="inline-flex items-center gap-2 rounded-xl bg-kk-ink text-white px-4 py-2 text-sm font-semibold hover:bg-kk-ink/90 transition-colors cursor-pointer"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add post / photo
      </button>
    )
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={handleClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          <div className="p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-black text-kk-ink">
                {phase === 'result' ? 'Publish results' : 'Add post / photo'}
              </h2>
              <button onClick={handleClose} disabled={phase === 'publishing'} className="text-kk-muted hover:text-kk-ink transition-colors cursor-pointer disabled:cursor-not-allowed" aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>

            {phase === 'result' && result ? (
              /* ── Result view ────────────────────────────────────────────── */
              <div>
                <div className={`text-sm font-semibold mb-3 ${result.succeeded === result.total ? 'text-green-700' : result.succeeded === 0 ? 'text-kk-bad' : 'text-amber-700'}`}>
                  {result.succeeded === result.total
                    ? `Published to all ${result.total} profiles`
                    : result.succeeded === 0
                      ? 'Nothing was published'
                      : `Published to ${result.succeeded} of ${result.total} profiles`}
                  {result.failed > 0 && result.succeeded > 0 && (
                    <span className="block text-xs text-kk-muted font-normal mt-0.5">{result.failed} location{result.failed !== 1 ? 's' : ''} needs attention</span>
                  )}
                </div>
                <div className="space-y-1.5">
                  {result.locations.map(loc => (
                    <div key={loc.locationId} className="flex items-start gap-2 text-sm">
                      <span className={loc.status === 'success' ? 'text-green-600' : 'text-kk-bad'}>
                        {loc.status === 'success' ? '✓' : '✕'}
                      </span>
                      <div>
                        <span className="font-medium text-kk-ink">{loc.locationName}</span>
                        {loc.error && <span className="block text-xs text-kk-muted">{loc.error}</span>}
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => { setOpen(false); reset() }}
                  className="mt-5 w-full rounded-xl bg-kk-ink text-white py-2.5 text-sm font-semibold hover:bg-kk-ink/90 transition-colors cursor-pointer"
                >
                  Done
                </button>
              </div>
            ) : (
              /* ── Form view ──────────────────────────────────────────────── */
              <div className="space-y-5">
                {/* Mode toggle */}
                <div className="flex gap-2">
                  {(['local_post', 'photo'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      disabled={phase === 'publishing'}
                      className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${mode === m ? 'bg-kk-ink text-white' : 'bg-kk-panel text-kk-muted hover:text-kk-ink'}`}
                    >
                      {m === 'local_post' ? 'Post update' : 'Photo only'}
                    </button>
                  ))}
                </div>

                {/* Image upload */}
                <div>
                  <label className="text-xs font-semibold text-kk-muted block mb-1.5">Image</label>
                  {imagePreview ? (
                    <div className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imagePreview} alt="Preview" className="w-full h-48 object-cover rounded-xl border border-kk-line" />
                      <button
                        onClick={() => { setImageFile(null); setImagePreview(null); if (fileRef.current) fileRef.current.value = '' }}
                        disabled={phase === 'publishing'}
                        className="absolute top-2 right-2 bg-white/90 rounded-full p-1 text-kk-muted hover:text-kk-ink transition-colors cursor-pointer"
                        aria-label="Remove image"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={phase === 'publishing'}
                      className="w-full h-32 border-2 border-dashed border-kk-line rounded-xl flex flex-col items-center justify-center gap-1 text-kk-muted hover:border-kk-muted/50 hover:text-kk-ink transition-colors cursor-pointer"
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
                      <span className="text-xs font-medium">Choose image</span>
                    </button>
                  )}
                  <input ref={fileRef} type="file" accept={ACCEPTED_TYPES} onChange={handleImageChange} className="hidden" />
                </div>

                {/* Caption (post mode only) */}
                {mode === 'local_post' && (
                  <div>
                    <label className="text-xs font-semibold text-kk-muted block mb-1.5">Caption</label>
                    <textarea
                      value={caption}
                      onChange={e => setCaption(e.target.value)}
                      disabled={phase === 'publishing'}
                      maxLength={MAX_CAPTION}
                      rows={3}
                      className="w-full rounded-xl border border-kk-line px-3 py-2 text-sm text-kk-ink placeholder:text-kk-muted/50 focus:outline-none focus:ring-2 focus:ring-kk-ink/20 resize-none"
                      placeholder="Write your post..."
                    />
                    <div className="text-[10px] text-kk-muted text-right mt-0.5">{caption.length} / {MAX_CAPTION}</div>
                  </div>
                )}

                {/* Location selector */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-kk-muted">Locations</label>
                    <button onClick={toggleAll} disabled={phase === 'publishing'} className="text-[10px] font-medium text-kk-brand hover:underline cursor-pointer">
                      {selectedIds.size === activeLocations.length ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <div className="border border-kk-line rounded-xl divide-y divide-kk-line max-h-48 overflow-y-auto">
                    {activeLocations.map(loc => (
                      <label key={loc.id} className="flex items-center gap-3 px-3 py-2 hover:bg-kk-panel/50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(loc.id)}
                          onChange={() => toggleLocation(loc.id)}
                          disabled={phase === 'publishing'}
                          className="rounded border-kk-line text-kk-ink focus:ring-kk-ink/20 h-4 w-4 cursor-pointer"
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-kk-ink truncate">{loc.store_name}</div>
                          {loc.address_summary && <div className="text-[10px] text-kk-muted">{loc.address_summary}</div>}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Error */}
                {error && <p className="text-xs text-kk-bad">{error}</p>}

                {/* Submit */}
                <button
                  onClick={handlePublish}
                  disabled={!canSubmit}
                  className="w-full rounded-xl bg-kk-ink text-white py-2.5 text-sm font-semibold hover:bg-kk-ink/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {(phase as Phase) === 'publishing'
                    ? 'Publishing\u2026'
                    : `Publish to ${selectedCount} profile${selectedCount !== 1 ? 's' : ''}`}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
