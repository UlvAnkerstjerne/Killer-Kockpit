import { useRef, useState } from 'react'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

/**
 * Manages the saving / saved / error lifecycle for autosave surfaces.
 * "Saved" automatically reverts to "idle" after `savedDuration` ms.
 * Errors stay visible until the next save attempt.
 */
export function useSaveState(savedDuration = 2000) {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function start() {
    if (timerRef.current) clearTimeout(timerRef.current)
    setStatus('saving')
    setErrorMsg(null)
  }

  function ok() {
    if (timerRef.current) clearTimeout(timerRef.current)
    setStatus('saved')
    timerRef.current = setTimeout(() => setStatus('idle'), savedDuration)
  }

  function fail(msg: string) {
    if (timerRef.current) clearTimeout(timerRef.current)
    setStatus('error')
    setErrorMsg(msg)
  }

  return { status, errorMsg, start, ok, fail }
}
