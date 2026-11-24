import type { IconBaseProps } from 'react-icons'

import { motionEnabled } from '@/renderer/shared/lib/motion'

import { mascotArt, mascotViewBox, staticMascotArt } from './mascot-art.js'
import { useMascotMotion } from './use-mascot-motion.js'

/**
 * What the mascot is acting out. Sidebar rows map a Task's runtime state onto a mood;
 * the chat timeline uses `thinking` and `working` for live reasoning and tool activity.
 */
export type MascotMood =
  | 'idle'
  | 'queued'
  | 'starting'
  | 'working'
  | 'thinking'
  | 'stopping'
  | 'approval'
  | 'question'
  | 'alert'
  | 'delegating'
  | 'done'

export interface WatchtowerMascotProps extends Omit<IconBaseProps, 'title'> {
  readonly mood: MascotMood
  /** Accessible name; omit to render the mascot as decoration (aria-hidden). */
  readonly title?: string
}

function MoodMark({ mood }: { mood: MascotMood }): React.JSX.Element | null {
  switch (mood) {
    case 'thinking':
      return (
        <g data-mascot-mark="">
          <circle cx="929" cy="280" r="28" />
          <circle cx="1000" cy="208" r="36" />
          <circle cx="1080" cy="116" r="47" />
        </g>
      )
    case 'working':
      return <path data-mascot-mark="" d="m1030 490 25 83 79 29 -79 26 -25 83 -26 -83 -79 -26 79 -29z" />
    case 'question':
    case 'alert':
      return (
        <text data-mascot-mark="" x="917" y="282" fontSize="350" fontFamily="system-ui, sans-serif" fontWeight="800">
          {mood === 'question' ? '?' : '!'}
        </text>
      )
    case 'delegating':
      return <circle data-mascot-mark="" cx="1050" cy="180" r="52" />
    default:
      return null
  }
}

export function WatchtowerMascot({ mood, title, size = '1em', ...props }: WatchtowerMascotProps): React.JSX.Element {
  const root = useMascotMotion(mood)
  return (
    <svg
      ref={root}
      viewBox={mascotViewBox}
      width={size}
      height={size}
      fill="currentColor"
      {...props}
      data-mascot-mood={mood}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {motionEnabled() ? mascotArt : staticMascotArt[mood]}
      <MoodMark mood={mood} />
    </svg>
  )
}
