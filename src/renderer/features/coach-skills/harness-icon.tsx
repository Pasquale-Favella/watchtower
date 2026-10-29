import type { ComponentType } from 'react'
import { Bot } from 'lucide-react'
import { GenIcon, type IconBaseProps, type IconTree } from 'react-icons'
import {
  SiClaudecode,
  SiCline,
  SiCursor,
  SiGithubcopilot,
  SiGooglegemini,
  SiMoonshotai,
  SiOpencode,
  SiQwen,
  SiX,
} from 'react-icons/si'
import CodexLogo from '@/assets/images/harness-codex.json'
import DroidLogo from '@/assets/images/harness-droid.json'
import PiLogo from '@/assets/images/harness-pi.json'

/** Vendored brand marks, rendered through react-icons' `GenIcon` from raw
 *  icon-tree JSONs in `assets/images` — the same pattern as the Watchtower
 *  brand mark (`WatchtowerIcon`). No new dependency, same monochrome
 *  `currentColor` rendering as the Simple Icons glyphs below:
 *  - codex: the OpenAI "blossom" (CC0 path from Simple Icons v11 — the mark
 *    was retired upstream, so the last published geometry is vendored here).
 *  - droid: Factory's mark, reduced from the official favicon (background +
 *    fixed fills stripped so it inherits the theme color).
 *  - pi: Pi Coding Agent's badge, reduced from the official favicon
 *    (background + fixed fills stripped so it inherits the theme color). */
const codexTree: IconTree = {
  ...CodexLogo,
  attr: { ...CodexLogo.attr, viewBox: '0 0 24 24' },
}
const droidTree: IconTree = {
  ...DroidLogo,
  attr: { ...DroidLogo.attr, viewBox: '0 0 508 508' },
}
const piTree: IconTree = {
  ...PiLogo,
  // The official badge includes a large dark square background. Crop to the
  // mark so it fills the same compact rail slot as the other harness icons.
  attr: { ...PiLogo.attr, viewBox: '145 145 510 510' },
}
const CodexIcon = (props: IconBaseProps) => GenIcon(codexTree)(props)
const DroidIcon = (props: IconBaseProps) => GenIcon(droidTree)(props)
const PiIcon = (props: IconBaseProps) => GenIcon(piTree)(props)

/** Brand glyph per harness kind (Simple Icons via react-icons, the same
 *  dependency the Watchtower brand mark already uses, plus three vendored
 *  marks above). Kinds without an obtainable monochrome brand glyph — goose
 *  (only a full-color illustration exists upstream), kilo-code (PNG only) —
 *  and any future kind from a new
 *  registry spec file fall back to the neutral lucide `Bot`: the harness
 *  registry is data-driven (ADR 0016), so an unknown kind must still render
 *  instead of breaking the rail. A wrong brand mark would be worse than the
 *  fallback, so additions need a verified source (see the JSON comments). */
const HARNESS_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  claude: SiClaudecode,
  cline: SiCline,
  codex: CodexIcon,
  copilot: SiGithubcopilot,
  cursor: SiCursor,
  droid: DroidIcon,
  gemini: SiGooglegemini,
  grok: SiX,
  kimi: SiMoonshotai,
  opencode: SiOpencode,
  pi: PiIcon,
  qwen: SiQwen,
}

/** The harness glyph — brand icon where one exists, neutral bot otherwise.
 *  Inherits `currentColor`; size it with a `size-*` class like any lucide
 *  icon. */
export function HarnessIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = HARNESS_ICONS[kind] ?? Bot
  return <Icon className={className} aria-hidden />
}
