import gsap from 'gsap'

import { motionEnabled } from '@/renderer/shared/lib/motion'

const active = new WeakMap<HTMLElement, () => void>()
const INTERRUPTIONS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const

function clampScroll(viewport: HTMLElement, value: number): number {
  return Math.min(Math.max(0, viewport.scrollHeight - viewport.clientHeight), Math.max(0, value))
}

/** Duration grows gently with distance so short hops feel snappy and long jumps stay readable. */
export function scrollTweenDuration(distance: number): number {
  return Math.min(0.85, 0.32 + Math.abs(distance) / 6000)
}

/**
 * Glides a scroll container to a target that may move while it travels (virtualized rows are measured as they
 * render). The target is re-read every frame and the tween eases toward it, so late measurements are absorbed
 * instead of snapping at the end. Any reader input cancels the glide. Resolves true when it arrives.
 */
export function glideScroll(viewport: HTMLElement, target: () => number | null): Promise<boolean> {
  active.get(viewport)?.()
  const initial = target()
  if (initial === null) return Promise.resolve(false)
  if (!motionEnabled()) {
    viewport.scrollTop = clampScroll(viewport, initial)
    return Promise.resolve(true)
  }
  return new Promise(resolve => {
    const start = viewport.scrollTop
    const progress = { t: 0 }
    let last = initial
    const finish = (arrived: boolean) => {
      tween.kill()
      INTERRUPTIONS.forEach(type => viewport.removeEventListener(type, interrupt))
      if (active.get(viewport) === cancel) active.delete(viewport)
      resolve(arrived)
    }
    const interrupt = () => finish(false)
    const cancel = () => finish(false)
    const tween = gsap.to(progress, {
      t: 1,
      duration: scrollTweenDuration(initial - start),
      ease: 'power3.out',
      onUpdate: () => {
        last = target() ?? last
        viewport.scrollTop = clampScroll(viewport, start + (last - start) * progress.t)
      },
      onComplete: () => finish(true),
    })
    INTERRUPTIONS.forEach(type => viewport.addEventListener(type, interrupt, { passive: true }))
    active.set(viewport, cancel)
  })
}
