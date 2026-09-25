'use client'

import { useState, useRef, useEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'

export default function BrainButton() {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const router = useRouter()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Focus textarea when popover opens
  useEffect(() => {
    if (open) {
      // Small delay to let the popover render
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const trimmed = question.trim()
      if (!trimmed) return
      setOpen(false)
      setQuestion('')
      router.push(`/brain?q=${encodeURIComponent(trimmed)}`)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-[#B7A486]/25 transition-colors"
        aria-label="Ask Kockpit Brain"
        title="Ask Kockpit Brain"
      >
        <Image
          src="/kk-mascot.png"
          alt="Ask Brain"
          width={28}
          height={32}
          className="mix-blend-multiply"
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-72 md:w-80 bg-white border border-kk-line rounded-xl shadow-lg p-3">
          <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-kk-muted mb-2">
            Ask Kockpit Brain
          </p>
          <textarea
            ref={textareaRef}
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What's going on with…?"
            rows={3}
            className="w-full border border-kk-line rounded-lg px-3 py-2 text-sm text-kk-ink placeholder:text-kk-muted/70 resize-none focus:outline-none focus:ring-2 focus:ring-kk-ink/15 focus:border-kk-ink/40 bg-white"
          />
          <p className="text-[10px] text-kk-muted mt-1.5">
            Enter to ask · Shift+Enter for new line
          </p>
        </div>
      )}
    </div>
  )
}
