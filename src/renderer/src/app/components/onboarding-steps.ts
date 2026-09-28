import {
  ArrowLeftRight,
  BarChart3,
  Flame,
  GitPullRequestArrow,
  LayoutDashboard,
  Layers,
  Lightbulb,
  PanelsTopLeft,
  Settings,
  Sparkles,
} from 'lucide-react'
import type { OnboardingStep } from '../../../../shared/schemas/renderer.js'
export type { OnboardingStep }

export const ONBOARDING_KEY = 'watchtower:onboarded'

/**
 * First-launch walkthrough steps (ADR 0012): a welcome screen, then one step
 * per app section. Data-driven so the walkthrough tracks the real nav without
 * code changes — it covers the 8 sections that exist today (Plans was
 * removed). Deliberately has NO telemetry-consent step: there is no telemetry.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'welcome',
    title: 'Every agent. One dashboard.',
    body: 'Claude Code, Codex, Cursor, Copilot and 30+ more: cost, sessions, models and efficiency, side by side — read entirely from files already on this machine.',
    icon: Flame,
  },
  {
    id: 'overview',
    title: 'Overview',
    body: 'Cost, calls and session KPIs at a glance, with a daily chart, top models and activities, and efficiency signals like cache hits and retry tax.',
    icon: LayoutDashboard,
  },
  {
    id: 'sessions',
    title: 'Sessions',
    body: 'Every working session, searchable and filterable by project, provider and model. Click any row to drill into its full turn-by-turn timeline.',
    icon: PanelsTopLeft,
  },
  {
    id: 'pullRequests',
    title: 'Pull requests',
    body: 'Spend attributed to each PR, turn by turn from real git history — so the cost of shipped work is trustworthy.',
    icon: GitPullRequestArrow,
  },
  {
    id: 'spend',
    title: 'Spend',
    body: 'Daily spend stacked by model and project, plus a Sankey flow showing where money moves from models to projects.',
    icon: BarChart3,
  },
  {
    id: 'optimize',
    title: 'Optimize',
    body: 'Waste, reverts, abandoned work and fixes — an A–F setup-health grade with copy-paste fixes for the worst offenders. Read-only by design.',
    icon: Lightbulb,
  },
  {
    id: 'models',
    title: 'Models',
    body: 'Cost, tokens and calls per model, broken down by task and audited down to the token. Unpriced models get an inline quick-add pricing affordance.',
    icon: Layers,
  },
  {
    id: 'compare',
    title: 'Compare',
    body: 'Pick two models and see one-shot rate, retry rate, cost per call and cache-hit rate side by side.',
    icon: ArrowLeftRight,
  },
  {
    id: 'coachSkills',
    title: 'Coach & Skills',
    body: 'Chat with the coding agents already on your machine. Ask for guidance on your workflow, or have one author a SKILL.md for you conversationally — grounded in your real usage through the in-app ledger.',
    icon: Sparkles,
  },
  {
    id: 'settings',
    title: 'Settings',
    body: 'Themes, refresh cadence, providers, aliases, pricing, export and privacy. Check for updates lives here — manually, only when you ask.',
    icon: Settings,
  },
]

/** True once the user has completed (or skipped) the first-launch walkthrough. */
export function isOnboarded(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  if (!storage) return false
  try {
    return storage.getItem(ONBOARDING_KEY) === '1'
  } catch {
    return false
  }
}

/** Persists completion so the walkthrough only ever shows on first launch. */
export function markOnboarded(storage: Pick<Storage, 'setItem'> | null | undefined): void {
  if (!storage) return
  try {
    storage.setItem(ONBOARDING_KEY, '1')
  } catch {
    // storage can be unavailable in hardened contexts — the walkthrough simply
    // returns next launch, still non-gating
  }
}
