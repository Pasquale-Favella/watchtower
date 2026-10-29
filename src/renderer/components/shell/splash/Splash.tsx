import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef } from 'react'

import { useScanStore } from '@/renderer/stores/hooks/use-scan-store'
import { Button } from '@/renderer/components/ui/button'
import { motionClass, motionEnabled } from '@/renderer/shared/lib/motion'
import { cn } from '@/renderer/shared/lib/utils'

import { Beacon } from '@/renderer/components/shell/splash/Beacon'
import { Ellipsis } from '@/renderer/components/shell/splash/Ellipsis'
import { statusMessage, stepIndex } from '@/renderer/components/shell/splash/progress'
import { Tally } from '@/renderer/components/shell/splash/Tally'

/**
 * First-launch/first-hydrate splash: shown until the store has a report to
 * read. A radar sweeps while the scan runs; each provider the main process's
 * `scan:progress` events report lands as a labelled node on the radar ring,
 * woken by the beam with a live file count, while a status line narrates the
 * current phase (prices → sessions → dashboard). If the initial scan fails,
 * shows an error message and a manual retry button instead of leaving the user
 * stuck indefinitely.
 * Store-driven (ADR 0011): progress, stage, error, and retry come from the
 * scan store.
 */
export function Splash() {
  const { progress: providers, stage, scanError: error, refreshScan: refresh } = useScanStore()

  const root = useRef<HTMLDivElement>(null)

  const step = stepIndex(stage, providers)
  const message = statusMessage(step, providers)
  const totalFiles = providers.reduce((n, p) => n + (p.processed ?? 0), 0)

  // Entrance + the idle radar loops.
  useGSAP(
    () => {
      if (!motionEnabled()) return
      const q = gsap.utils.selector(root)

      gsap
        .timeline({ defaults: { ease: 'power3.out' } })
        .from(q('[data-splash=beacon]'), { scale: 0.6, opacity: 0, duration: 0.7, ease: 'back.out(1.6)' })
        .from(q('[data-splash=fade]'), { y: 6, opacity: 0, duration: 0.4, stagger: 0.08 }, '-=0.25')
    },
    { scope: root },
  )

  // Status line: each new message rises in.
  useGSAP(
    () => {
      if (!motionEnabled()) return
      gsap.from('[data-splash=status]', { y: 8, opacity: 0, filter: 'blur(3px)', duration: 0.35, ease: 'power2.out' })
    },
    { scope: root, dependencies: [message] },
  )

  return (
    <div
      ref={root}
      role="status"
      aria-live="polite"
      aria-busy={!error}
      className="bg-background text-foreground fixed inset-0 z-100 flex flex-col items-center justify-center overflow-hidden"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background:radial-gradient(circle_at_50%_34%,color-mix(in_oklab,var(--primary)_9%,transparent),transparent_60%)]"
      />

      <div className="relative flex w-80 flex-col items-center">
        <Beacon providers={providers} error={Boolean(error)} />

        <h1 className="mt-6 text-lg font-bold tracking-tight">Watchtower</h1>

        <div data-splash="fade" className="mt-1 h-5 overflow-hidden text-center">
          {!error && (
            <span key={message} data-splash="status" className="text-muted-foreground inline-block text-[12.5px]">
              {message}
              <Ellipsis />
            </span>
          )}
        </div>

        {!error && <Tally sources={providers.length} files={totalFiles} />}

        {error && (
          <div
            className={cn(
              'border-border bg-card mt-5 flex w-full flex-col items-center gap-2 rounded-md border px-3 py-2.5 text-center',
              motionClass('', 'animate-in fade-in slide-in-from-bottom-1'),
            )}
          >
            <span className="text-destructive text-[11.5px]">{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => refresh(undefined)}>
              Retry
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
