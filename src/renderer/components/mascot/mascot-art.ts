import { createElement, type ReactNode } from 'react'
import type { IconTree } from 'react-icons'

import greeting from '@/renderer/assets/images/watchtower-greeting.json'

import type { MascotMood } from './WatchtowerMascot.js'

const tree = greeting as IconTree
export const mascotViewBox = tree.attr.viewBox
export const origins = { body: '675 1010', head: '680 575', leftEye: '655 403', rightEye: '796 405' } as const

type Pose = { body?: string; head?: string; eyes?: string; lids?: number }
const poses: Record<MascotMood, Pose> = {
  idle: {},
  queued: { body: 'rotate(-4 675 1010)', eyes: 'translate(-34 0)' },
  starting: { body: 'translate(0 -42)', lids: 1.15 },
  working: { head: 'translate(0 48) rotate(13 680 575)' },
  thinking: { head: 'rotate(-11 680 575)', eyes: 'translate(25 -24)' },
  stopping: { body: 'translate(0 162) scale(1 .84)', lids: 0.48 },
  approval: { body: 'translate(0 -40)', head: 'rotate(8 680 575)' },
  question: { head: 'rotate(-14 680 575)', lids: 1.22 },
  alert: { body: 'rotate(-6 675 1010)', lids: 1.16 },
  delegating: { head: 'rotate(9 680 575)', eyes: 'translate(32 0)' },
  done: { lids: 0.45 },
}

function artwork(pose: Pose): ReactNode {
  const transforms: Record<string, string | undefined> = {
    mascot: pose.body,
    head: pose.head,
    eyes: pose.eyes,
  }
  if (pose.lids !== undefined) {
    for (const eye of ['leftEye', 'rightEye'] as const) {
      const y = Number(origins[eye].split(' ')[1])
      transforms[eye] = `translate(0 ${y * (1 - pose.lids)}) scale(1 ${pose.lids})`
    }
  }
  function draw(node: IconTree, key: number): ReactNode {
    return createElement(
      node.tag,
      { key, ...node.attr, transform: transforms[node.attr['data-greeting'] ?? ''] },
      node.child?.map(draw),
    )
  }
  return tree.child.map(draw)
}

export const mascotArt = artwork({})
export const staticMascotArt = Object.fromEntries(
  Object.entries(poses).map(([mood, pose]) => [mood, artwork(pose)]),
) as Record<MascotMood, ReactNode>
