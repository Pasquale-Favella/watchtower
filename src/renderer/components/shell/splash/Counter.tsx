import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'

import { motionEnabled } from '@/renderer/shared/lib/motion'

const numberFormat = new Intl.NumberFormat()

/** A number that rolls toward its new value instead of jumping. GSAP owns the
 * text node (React renders the span empty), so the two never fight over it. */
export function Counter({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef({ value: 0 })

  useGSAP(
    () => {
      const el = ref.current
      if (!el) return
      const paint = () => {
        el.textContent = numberFormat.format(Math.round(shown.current.value))
      }
      if (!motionEnabled()) {
        shown.current.value = value
        paint()
        return
      }
      gsap.to(shown.current, { value, duration: 0.6, ease: 'power2.out', onUpdate: paint, overwrite: true })
    },
    { dependencies: [value] },
  )

  return <span ref={ref} className={className} />
}
