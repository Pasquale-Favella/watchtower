import { useWorkerPool } from '@pierre/diffs/react'
import { useEffect, useState, useSyncExternalStore } from 'react'

/** A stalled highlighter becomes plain code; it never moves its full workload to the UI thread. */
export function useCodeWorkerFallback(): boolean {
  const pool = useWorkerPool()
  const [stalled, setStalled] = useState(false)
  const unavailable = useSyncExternalStore(
    listener => pool?.subscribeToStatChanges(() => listener()) ?? (() => {}),
    () => pool !== undefined && !pool.isWorkingPool(),
    () => false,
  )
  useEffect(() => {
    if (!pool) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const release = pool.subscribeToStatChanges(stats => {
      clearTimeout(timer)
      if (!stats.activeTasks && !stats.queuedTasks) return
      timer = setTimeout(() => {
        setStalled(true)
        pool.terminate()
      }, 15_000)
    })
    return () => {
      clearTimeout(timer)
      release()
    }
  }, [pool])
  return stalled || unavailable
}
