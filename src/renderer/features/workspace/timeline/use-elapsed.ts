import { useEffect, useState } from 'react'

const TICK_MS = 1000

/** Milliseconds since a durable timestamp, refreshed every second while active; null when inactive or unknown. */
export function useElapsedMs(since: string | null, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, TICK_MS)
    return () => {
      window.clearInterval(id)
    }
  }, [active])
  const started = since ? Date.parse(since) : Number.NaN
  if (!active || !Number.isFinite(started)) return null
  return Math.max(0, now - started)
}
