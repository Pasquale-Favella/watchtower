import { useGSAP } from '@gsap/react'
import { useRef } from 'react'

import { motionEnabled } from '@/renderer/shared/lib/motion'

import { mascotTimeline } from './mascot-timeline.js'
import type { MascotMood } from './WatchtowerMascot.js'

export function useMascotMotion(mood: MascotMood) {
  const root = useRef<SVGSVGElement>(null)
  useGSAP(
    () => {
      if (!motionEnabled() || !root.current) return
      const timeline = mascotTimeline(mood)
      let visible = typeof IntersectionObserver === 'undefined'
      const sync = () => {
        timeline.paused(document.hidden || !visible)
      }
      const observer = visible
        ? undefined
        : new IntersectionObserver(entries => {
            for (const entry of entries) visible = entry.isIntersecting
            sync()
          })
      observer?.observe(root.current)
      document.addEventListener('visibilitychange', sync)
      sync()
      return () => {
        observer?.disconnect()
        document.removeEventListener('visibilitychange', sync)
      }
    },
    { scope: root, dependencies: [mood], revertOnUpdate: true },
  )
  return root
}
