import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useRef } from 'react'
import { GenIcon, type IconBaseProps, type IconTree } from 'react-icons'

import greeting from '@/renderer/assets/images/watchtower-greeting.json'
import { motionEnabled } from '@/renderer/shared/lib/motion'

const iconTree = greeting as IconTree
const GreetingIcon = GenIcon(iconTree)

/** The greeting artwork uses the same icon tree and theme color as the brand mark. */
export function WatchtowerGreeting(props: IconBaseProps): React.JSX.Element {
  const root = useRef<HTMLSpanElement>(null)
  useGSAP(
    () => {
      if (!motionEnabled()) return
      const q = gsap.utils.selector(root)
      const defaults = { duration: 3.5, repeat: -1, ease: 'none' }
      gsap.to(q('[data-greeting=mascot]'), {
        ...defaults,
        svgOrigin: '675 1010',
        keyframes: {
          '0%': { x: 0, y: 0, rotation: 0 },
          '12%': { x: 0, y: -5, rotation: -2 },
          '25%': { x: -3, y: -11, rotation: -5 },
          '39%': { x: 0, y: -5, rotation: 4 },
          '51%': { x: 0, y: -10, rotation: -4 },
          '68%': { x: 0, y: 0, rotation: 1 },
          '100%': { x: 0, y: 0, rotation: 0 },
          easeEach: 'sine.inOut',
        },
      })
      gsap.to(q('[data-greeting=head]'), {
        ...defaults,
        svgOrigin: '680 575',
        keyframes: {
          '0%': { x: 0, y: 0, rotation: 0 },
          '12%': { x: -12, y: -10, rotation: -8 },
          '25%': { x: -18, y: -13, rotation: -13 },
          '39%': { x: 6, y: 0, rotation: 7 },
          '51%': { x: -15, y: -10, rotation: -11 },
          '68%': { x: 0, y: 0, rotation: 0 },
          '100%': { x: 0, y: 0, rotation: 0 },
          easeEach: 'sine.inOut',
        },
      })
      gsap.to(q('[data-greeting=base]'), {
        ...defaults,
        svgOrigin: '675 1010',
        keyframes: {
          '0%': { y: 0, scaleX: 1, scaleY: 1 },
          '15%': { y: 7, scaleX: 1.02, scaleY: 0.984 },
          '31%': { y: -5, scaleX: 0.988, scaleY: 1.009 },
          '51%': { y: 2, scaleX: 1.012, scaleY: 0.992 },
          '100%': { y: 0, scaleX: 1, scaleY: 1 },
          easeEach: 'sine.inOut',
        },
      })
      gsap.to(q('[data-greeting=eyes]'), {
        ...defaults,
        keyframes: {
          '0%': { x: 0, y: 0 },
          '15%': { x: -10, y: 1 },
          '32%': { x: 5, y: 0 },
          '49%': { x: -7, y: 0 },
          '68%': { x: 0, y: 0 },
          '100%': { x: 0, y: 0 },
          easeEach: 'sine.inOut',
        },
      })
      gsap.to(q('[data-greeting=leftEye]'), {
        ...defaults,
        svgOrigin: '655 403',
        keyframes: {
          '0%': { scaleY: 1 },
          '26%': { scaleY: 1 },
          '30.5%': { scaleY: 0.09 },
          '36%': { scaleY: 1 },
          '54%': { scaleY: 1 },
          '58%': { scaleY: 0.1 },
          '63%': { scaleY: 1 },
          '100%': { scaleY: 1 },
          easeEach: 'none',
        },
      })
      gsap.to(q('[data-greeting=rightEye]'), {
        ...defaults,
        svgOrigin: '796 405',
        keyframes: {
          '0%': { scaleY: 1 },
          '54%': { scaleY: 1 },
          '58%': { scaleY: 0.1 },
          '63%': { scaleY: 1 },
          '100%': { scaleY: 1 },
          easeEach: 'none',
        },
      })
    },
    { scope: root },
  )

  return (
    <span ref={root} className="inline-flex shrink-0">
      <GreetingIcon {...props} />
    </span>
  )
}
