import { z } from 'zod'
import type { ComponentType } from 'react'
import type { Hotkey } from '@tanstack/react-hotkeys'

import { modelReportRowSchema } from './models.js'
import { sessionRowSchema } from './views.js'

/** Renderer-local UI shapes (ADR 0005): schemas for shapes that have no IPC
 * wire counterpart — date ranges, splash progress, shortcut definitions,
 * onboarding steps, sankey nodes/links, session groups, and the like. Their
 * inferred types are the only thing consumed (they have no parse site by
 * definition). */

export const dateRangeSchema = z.object({
  since: z.string(),
  until: z.string(),
})
export type DateRange = z.infer<typeof dateRangeSchema>

export const splashProviderProgressSchema = z.object({
  provider: z.string(),
  processed: z.number().optional(),
  total: z.number().optional(),
  done: z.boolean(),
})
export type SplashProviderProgress = z.infer<typeof splashProviderProgressSchema>

export const sectionSchema = z.enum([
  'overview', 'sessions', 'pullRequests', 'spend', 'optimize', 'models', 'compare', 'settings',
])
export type Section = z.infer<typeof sectionSchema>

export const shortcutActionSchema = sectionSchema.or(z.enum(['refresh', 'toggleSidebar']))
export type ShortcutAction = z.infer<typeof shortcutActionSchema>

export const platformSchema = z.enum(['mac', 'windows', 'linux'])
export type Platform = z.infer<typeof platformSchema>

export const shortcutDefSchema = z.object({
  action: shortcutActionSchema,
  hotkey: z.custom<Hotkey>(),
  label: z.string(),
})
export type ShortcutDef = z.infer<typeof shortcutDefSchema>

export const onboardingStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  icon: z.custom<ComponentType<{ className?: string; strokeWidth?: number }>>(),
})
export type OnboardingStep = z.infer<typeof onboardingStepSchema>

export const modelTaskGroupSchema = z.object({
  provider: z.string(),
  model: z.string(),
  modelDisplayName: z.string(),
  rows: z.array(modelReportRowSchema),
})
export type ModelTaskGroup = z.infer<typeof modelTaskGroupSchema>

export const sessionSortSchema = z.enum(['cost', 'recent', 'turns', 'tokens'])
export type SessionSort = z.infer<typeof sessionSortSchema>

export const sessionGroupSchema = z.object({
  provider: z.string(),
  count: z.number(),
  cost: z.number(),
  rows: z.array(sessionRowSchema),
})
export type SessionGroup = z.infer<typeof sessionGroupSchema>

export const providerOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
})
export type ProviderOption = z.infer<typeof providerOptionSchema>

export const themeSchema = z.enum(['light', 'dark', 'system'])
export type Theme = z.infer<typeof themeSchema>

export const spendRowSchema = z
  .record(z.string(), z.union([z.string(), z.number()]))
  .and(z.object({ date: z.string() }))
export type SpendRow = z.infer<typeof spendRowSchema>

export const sankeyNodeDataSchema = z.object({
  name: z.string(),
  kind: z.enum(['model', 'project']),
})
export type SankeyNodeData = z.infer<typeof sankeyNodeDataSchema>

export const sankeyLinkDataSchema = z.object({
  source: z.number(),
  target: z.number(),
  value: z.number(),
})
export type SankeyLinkData = z.infer<typeof sankeyLinkDataSchema>
