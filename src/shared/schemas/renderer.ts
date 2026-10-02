import type { Hotkey } from '@tanstack/react-hotkeys'
import type { ComponentType } from 'react'

import type { ModelReportRow } from './models.js'
import type { SessionRow } from './views.js'

/** Renderer-local UI shapes have no IPC wire counterpart and no parse site. */
export interface DateRange {
  since: string
  until: string
}

export interface SplashProviderProgress {
  provider: string
  processed?: number
  total?: number
  done: boolean
}

export type Section =
  'overview' | 'sessions' | 'pullRequests' | 'spend' | 'optimize' | 'models' | 'compare' | 'coachSkills' | 'settings'

export type ShortcutAction = Section | 'refresh' | 'toggleSidebar' | 'commandPalette'

export type Platform = 'mac' | 'windows' | 'linux'

export interface ShortcutDef {
  action: ShortcutAction
  hotkey: Hotkey
  label: string
}

export interface OnboardingStep {
  id: string
  title: string
  body: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
}

export interface ModelTaskGroup {
  provider: string
  model: string
  modelDisplayName: string
  rows: ModelReportRow[]
}

export type SessionSort = 'cost' | 'recent' | 'turns' | 'tokens'

export interface SessionGroup {
  provider: string
  count: number
  cost: number
  rows: SessionRow[]
}

export interface ProviderOption {
  value: string
  label: string
}

export type Theme = 'light' | 'dark' | 'system'

export type SpendRow = Record<string, string | number> & { date: string }

export interface SankeyNodeData {
  name: string
  kind: 'model' | 'project'
}

export interface SankeyLinkData {
  source: number
  target: number
  value: number
}
