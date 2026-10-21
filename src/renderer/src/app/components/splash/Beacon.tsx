import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'

import { cn } from '@/shared/lib/utils'
import { motionClass, motionEnabled } from '@/shared/lib/motion'
import { WatchtowerIcon } from '@/app/components/WatchtowerIcon'

import type { SplashProviderProgress } from '../../../../../shared/schemas/renderer.js'
import { SourceNode } from './SourceNode'

/** The radar: guide rings, a rotating beam, slow outward pulses, the logo at
 * the center, and every detected source as a labelled node scattered inside
 * the ring. */
export function Beacon({ providers, error }: { providers: SplashProviderProgress[]; error: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const beam = useRef<HTMLDivElement>(null)

  // Idle on a failed scan: with `error` set, no loop starts and the previous
  // run's tweens are reverted, leaving the radar at rest.
  useGSAP(
    () => {
      if (error || !motionEnabled()) return
      const q = gsap.utils.selector(root)
      gsap.to(beam.current, { rotate: 360, duration: 3.6, ease: 'none', repeat: -1 })
      gsap.fromTo(
        q('[data-radar=pulse]'),
        { scale: 0.35, opacity: 0.4 },
        { scale: 1.2, opacity: 0, duration: 6.5, ease: 'sine.out', repeat: -1, stagger: { each: 2.2, repeat: -1 } },
      )
      gsap.to(q('[data-radar=logo]'), { scale: 1.05, duration: 2.4, ease: 'sine.inOut', yoyo: true, repeat: -1 })
    },
    { scope: root, dependencies: [error], revertOnUpdate: true },
  )

  return (
    <div ref={root} data-splash="beacon" aria-hidden className="relative size-64">
      <div className="border-border/70 absolute inset-0 rounded-full border" />
      <div className="border-border/50 absolute inset-[22%] rounded-full border border-dashed" />
      <div
        ref={beam}
        className={cn(
          'absolute inset-0 rounded-full',
          motionClass('', 'transition-opacity duration-500'),
          '[background:conic-gradient(from_0deg,transparent_0deg,transparent_290deg,color-mix(in_oklab,var(--primary)_32%,transparent)_360deg)]',
          error && 'opacity-0',
        )}
      />
      {!error &&
        [0, 1, 2].map(i => (
          <div
            key={i}
            data-radar="pulse"
            className="border-primary/40 absolute inset-0 rounded-full border opacity-0"
          />
        ))}
      {providers.map((p, i) => (
        <SourceNode key={p.provider} progress={p} index={i} />
      ))}
      <div className="absolute inset-0 grid place-items-center">
        <div className="bg-background ring-border grid size-18 place-items-center rounded-full ring-1">
          <span data-radar="logo" className="grid place-items-center">
            <WatchtowerIcon className={cn('size-10', error ? 'text-destructive' : 'text-primary')} />
          </span>
        </div>
      </div>
    </div>
  )
}
