'use client'

export default function IgThumbnail({ src }: { src: string | null }) {
  if (!src) {
    return (
      <div className="w-14 h-14 rounded-lg bg-kk-soft flex items-center justify-center shrink-0">
        <span className="text-kk-muted text-[10px] text-center leading-tight px-1">No preview</span>
      </div>
    )
  }

  return (
    <div className="w-14 h-14 rounded-lg overflow-hidden bg-kk-soft shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        width={56}
        height={56}
        className="w-full h-full object-cover"
        onError={(e) => {
          const wrapper = (e.currentTarget as HTMLImageElement).closest('div')
          if (wrapper) {
            wrapper.innerHTML = '<span class="text-[10px] text-center leading-tight px-1 text-gray-400" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%">No preview</span>'
          }
        }}
      />
    </div>
  )
}
