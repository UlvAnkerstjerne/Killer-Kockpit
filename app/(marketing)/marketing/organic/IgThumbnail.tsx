'use client'

import { useState } from 'react'

/**
 * Fills whatever container wraps it (w-full h-full).
 * Falls back to a neutral placeholder if src is null or the image fails to load.
 */
export default function IgThumbnail({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <span className="text-[10px] text-center leading-tight px-1 text-kk-muted">No preview</span>
      </div>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className="w-full h-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}
