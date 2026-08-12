import type { RefObject } from 'react'

import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

/** True while the vitest suite is running; animations stay off so tests observe
 * the final, settled DOM rather than an in-flight tween. */
function underTest(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env?.VITEST)
}

/** Reads the user's reduced-motion preference. Safe when matchMedia is absent. */
export function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** The single switch every animation path checks first. */
export function motionEnabled(): boolean {
  if (underTest()) return false
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return !reducedMotion()
}

/** Append `animated` to `base` only when motion is on. */
export function motionClass(base: string, animated: string): string {
  return motionEnabled() ? `${base} ${animated}` : base
}

/**
 * Grow bars up from their baseline (scaleY 0 → 1, bottom-anchored) with a short
 * stagger, capped so the whole sweep stays under 400ms regardless of bar count.
 * Runs on mount and when `deps` change, not on data re-renders.
 */
export function useBarGrowIn(scope: RefObject<HTMLElement | null>, selector: string, deps: unknown[]): void {
  useGSAP(() => {
    if (!motionEnabled()) return
    const bars = gsap.utils.toArray<HTMLElement>(selector, scope.current)
    if (!bars.length) return
    const each = Math.min(0.02, 0.26 / Math.max(1, bars.length - 1))
    gsap.from(bars, {
      scaleY: 0,
      transformOrigin: 'bottom',
      duration: 0.14,
      ease: 'power1.out',
      stagger: each,
    })
  }, { scope, dependencies: deps })
}

/**
 * A chat row rises gently into place (opacity 0 → 1, y 6px → 0) when it
 * mounts. Transform + opacity only, so the MessageScroller's positioning work
 * is never fought (see the MessageScroller docs on animating rows). Runs once
 * per mounted row, not on data re-renders — a streamed bubble mounts once and
 * keeps its entrance even as its text grows.
 */
export function useChatRowIn(scope: RefObject<HTMLElement | null>): void {
  useGSAP(() => {
    if (!motionEnabled()) return
    if (!scope.current) return
    gsap.from(scope.current, {
      opacity: 0,
      y: 6,
      duration: 0.2,
      ease: 'power1.out',
    })
  }, { scope })
}
