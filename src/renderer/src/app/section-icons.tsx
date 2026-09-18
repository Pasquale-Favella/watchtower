import type { ReactNode } from 'react'

import {
  LayoutDashboard, PanelsTopLeft, GitPullRequestArrow, BarChart3, Lightbulb,
  Layers, ArrowLeftRight, Sparkles, Settings,
} from 'lucide-react'

import type { Section } from '../../../shared/schemas/renderer.js'

/** Section icons — one source of truth shared by the sidebar and the command
 * palette. Leaf module (lucide + a type-only import) so headless tests can
 * import it without the router-bound sidebar tree. */
export const SECTION_ICONS: Record<Section, ReactNode> = {
  overview: <LayoutDashboard />,
  sessions: <PanelsTopLeft />,
  pullRequests: <GitPullRequestArrow />,
  spend: <BarChart3 />,
  optimize: <Lightbulb />,
  models: <Layers />,
  compare: <ArrowLeftRight />,
  coachSkills: <Sparkles />,
  settings: <Settings />,
}
