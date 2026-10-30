import {
  ArrowLeftRight,
  BarChart3,
  FolderKanban,
  GitPullRequestArrow,
  Layers,
  LayoutDashboard,
  Lightbulb,
  PanelsTopLeft,
  Settings,
  Sparkles,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { Section } from '@/shared/schemas/navigation.js'

/** Section icons — one source of truth shared by the sidebar and the command
 * palette. Leaf module (lucide + a type-only import) so headless tests can
 * import it without the router-bound sidebar tree. */
export const SECTION_ICONS: Record<Section, ReactNode> = {
  overview: <LayoutDashboard />,
  workspace: <FolderKanban />,
  sessions: <PanelsTopLeft />,
  pullRequests: <GitPullRequestArrow />,
  spend: <BarChart3 />,
  optimize: <Lightbulb />,
  models: <Layers />,
  compare: <ArrowLeftRight />,
  coachSkills: <Sparkles />,
  settings: <Settings />,
}
