import gsap from 'gsap'

import { origins } from './mascot-art.js'
import type { MascotMood } from './WatchtowerMascot.js'

/** Targets resolve inside the useGSAP scope for this instance. Distances use logo viewBox units. */
export function mascotTimeline(mood: MascotMood): gsap.core.Timeline {
  const body = '[data-greeting=mascot]'
  const head = '[data-greeting=head]'
  const eyes = '[data-greeting=eyes]'
  const lids = '[data-greeting=leftEye], [data-greeting=rightEye]'
  const mark = '[data-mascot-mark]'
  gsap.set(body, { svgOrigin: origins.body })
  gsap.set(head, { svgOrigin: origins.head })
  gsap.set('[data-greeting=leftEye]', { svgOrigin: origins.leftEye })
  gsap.set('[data-greeting=rightEye]', { svgOrigin: origins.rightEye })
  const t = gsap.timeline({ paused: true, defaults: { ease: 'sine.inOut' } })
  function hop(): void {
    t.to(body, { scaleX: 1.08, scaleY: 0.84, duration: 0.16 })
      .to(body, { scaleX: 0.98, scaleY: 1, y: -70, duration: 0.2, ease: 'power2.out' })
      .to(body, { scaleX: 1.05, scaleY: 0.9, y: 0, duration: 0.18, ease: 'power2.in' })
      .to(body, { scaleX: 1, scaleY: 1, duration: 0.18 })
  }
  switch (mood) {
    case 'idle':
      return t.to(lids, { scaleY: 0.08, duration: 0.2, repeat: 1, yoyo: true }, 4).repeat(-1).repeatDelay(3)
    case 'queued':
      return t
        .to(body, { rotation: -5, y: -36, duration: 0.2, repeat: 3, yoyo: true })
        .to(eyes, { x: -34, duration: 0.25, repeat: 1, repeatDelay: 0.3, yoyo: true }, 0)
        .repeat(-1)
        .repeatDelay(1.6)
    case 'starting':
      gsap.set(lids, { scaleY: 0.05 })
      t.to(lids, { scaleY: 1, duration: 0.32 })
      hop()
      return t
    case 'working':
      return t
        .to(head, { rotation: -11, y: -22, duration: 0.24 })
        .to(head, { rotation: 15, y: 65, duration: 0.13, ease: 'power2.in' })
        .to(body, { scaleY: 0.82, scaleX: 1.08, duration: 0.13 }, '<')
        .fromTo(mark, { opacity: 0, scale: 0.3, transformOrigin: '50% 50%' }, { opacity: 1, scale: 1, duration: 0.09 })
        .to(mark, { opacity: 0, y: -40, duration: 0.22 })
        .to([body, head], { rotation: 0, y: 0, scaleX: 1, scaleY: 1, duration: 0.26 }, '<')
        .repeat(-1)
        .repeatDelay(0.45)
    case 'thinking':
      return t
        .to(head, { rotation: -13, duration: 0.48, repeat: 1, repeatDelay: 0.85, yoyo: true })
        .to(eyes, { x: 24, y: -25, duration: 0.54, repeat: 1, repeatDelay: 0.6, yoyo: true }, 0)
        .fromTo(
          `${mark} circle`,
          { opacity: 0.24 },
          { opacity: 1, duration: 0.36, stagger: 0.18, repeat: 1, yoyo: true },
          0.15,
        )
        .repeat(-1)
        .repeatDelay(0.8)
    case 'stopping':
      return t
        .to(body, { y: -30, duration: 0.16 })
        .to(body, { y: 0, scaleY: 0.84, scaleX: 1.06, duration: 0.92, ease: 'power2.out' })
        .to(lids, { scaleY: 0.48, duration: 0.75 }, '<')
    case 'approval':
      hop()
      return t
        .to(head, { rotation: 10, y: 48, duration: 0.21, repeat: 1, yoyo: true }, 0.48)
        .repeat(-1)
        .repeatDelay(2.8)
    case 'question':
      return t
        .to(head, { rotation: -14, duration: 0.32, repeat: 1, repeatDelay: 0.68, yoyo: true })
        .to(lids, { scaleY: 1.22, duration: 0.24, repeat: 1, repeatDelay: 0.6, yoyo: true }, 0)
        .from(mark, { scale: 0.35, y: 52, transformOrigin: '50% 100%', duration: 0.36, ease: 'back.out(1.7)' }, 0.12)
        .repeat(-1)
        .repeatDelay(2.7)
    case 'alert':
      return t
        .to(body, { rotation: -7, duration: 0.1 })
        .to(body, { rotation: 7, duration: 0.13, repeat: 2, yoyo: true })
        .to(body, { rotation: 0, duration: 0.16 })
        .from(mark, { y: 44, opacity: 0.35, duration: 0.2 }, 0)
        .repeat(-1)
        .repeatDelay(3)
    case 'delegating':
      return t
        .to(head, { rotation: -11, duration: 0.22 })
        .to(head, { rotation: 12, duration: 0.44 })
        .to(head, { rotation: 0, duration: 0.28 })
        .to(eyes, { x: -27, duration: 0.22 }, 0)
        .to(eyes, { x: 27, duration: 0.44 }, 0.22)
        .to(eyes, { x: 0, duration: 0.28 }, 0.66)
        .fromTo(mark, { x: -755, y: 70 }, { x: -370, y: -124, duration: 0.38 }, 0)
        .to(mark, { x: 0, y: 0, duration: 0.42 }, 0.38)
        .repeat(-1)
        .repeatDelay(1.65)
    case 'done':
      hop()
      return t.to(lids, { scaleY: 0.42, duration: 0.2 }, 0.28).to(lids, { scaleY: 0.83, duration: 0.38 }, 0.75)
  }
}
