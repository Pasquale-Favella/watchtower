import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { Check } from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { motionEnabled } from '@/shared/lib/motion'

import type { SplashProviderProgress } from '../../../../../shared/schemas/renderer.js'
import { Counter } from './Counter'
import { nodeAngle, nodeRadius, providerName } from './progress'

/**
 * One detected source on the radar: a dot scattered inside the ring with its
 * label beside it. It eases in when detected and settles with a check once its
 * files are read.
 */
export function SourceNode({ progress, index }: { progress: SplashProviderProgress; index: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const { provider, done, processed = 0 } = progress

  const rad = (nodeAngle(index) * Math.PI) / 180
  const radius = nodeRadius(provider)
  const sin = Math.sin(rad)
  const onRight = sin >= 0
  const x = 50 + sin * radius * 50
  const y = 50 - Math.cos(rad) * radius * 50

  useGSAP(
    () => {
      if (!motionEnabled()) return
      gsap
        .timeline({ defaults: { ease: 'power2.out' } })
        .from('[data-node=dot]', { scale: 0, opacity: 0, duration: 0.6 })
        .from('[data-node=label]', { opacity: 0, x: onRight ? 6 : -6, duration: 0.6 }, 0.1)
    },
    { scope: ref },
  )

  useGSAP(
    () => {
      if (!done || !motionEnabled()) return
      gsap.from('[data-node=check]', { scale: 0, duration: 0.4, ease: 'back.out(2.5)' })
    },
    { scope: ref, dependencies: [done] },
  )

  return (
    <div ref={ref}>
      <div className="absolute size-0" style={{ left: `${x}%`, top: `${y}%` }}>
        <span
          data-node="dot"
          className={cn(
            'absolute -top-0.75 -left-0.75 size-1.5 rounded-full transition-colors duration-500',
            done ? 'bg-primary' : 'bg-primary/60',
          )}
        />
        <div
          className={cn(
            'absolute top-0 -translate-y-1/2 whitespace-nowrap',
            onRight ? 'left-3 text-left' : 'right-3 text-right',
          )}
        >
          <div
            data-node="label"
            className="leading-tight [text-shadow:0_0_6px_var(--background),0_0_6px_var(--background)]"
          >
            <div className="text-foreground text-[11.5px] font-medium">{providerName(provider)}</div>
            <div
              className={cn(
                'text-muted-foreground flex items-center gap-1 text-[10.5px] tabular-nums',
                onRight ? 'justify-start' : 'justify-end',
              )}
            >
              <span>
                <Counter value={processed} /> {processed === 1 ? 'file' : 'files'}
              </span>
              {done && <Check data-node="check" className="text-primary size-2.5" strokeWidth={3} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
