import { Box, Terminal } from 'lucide-react'

import { WorkspaceFileIcon } from './WorkspaceFileIcon.js'

export type PromptReferenceKind = 'file' | 'skill' | 'command'

const CHIP_CLASSES =
  'group/prompt-reference relative inline-flex max-w-full items-baseline gap-[0.2em] rounded-sm align-baseline font-medium leading-normal'

const KIND_CLASSES: Readonly<Record<PromptReferenceKind, string>> = {
  file: 'text-[oklch(0.62_0.11_215)]',
  skill: 'text-[oklch(0.62_0.16_322)]',
  command: 'text-[oklch(0.62_0.16_322)]',
}

export function promptReferenceChipClass(kind: PromptReferenceKind): string {
  return `${CHIP_CLASSES} ${KIND_CLASSES[kind]}`
}

export function PromptReferenceChip({
  kind,
  label,
  path,
}: {
  readonly kind: PromptReferenceKind
  readonly label: string
  readonly path?: string
}): React.JSX.Element {
  let icon: React.JSX.Element
  let title: string | undefined
  switch (kind) {
    case 'file':
      icon = <WorkspaceFileIcon path={path ?? label} />
      title = path
      break
    case 'skill':
      icon = <Box />
      title = `$${label}`
      break
    case 'command':
      icon = <Terminal />
      title = `/${label}`
      break
  }
  return (
    <span className={promptReferenceChipClass(kind)} title={title}>
      <span aria-hidden="true" className="inline-flex shrink-0 self-center [&_svg]:size-[1em]">
        {icon}
      </span>
      <span className="min-w-0 truncate whitespace-nowrap underline decoration-transparent underline-offset-[0.2em] transition-colors group-hover/prompt-reference:decoration-current">
        {label}
      </span>
    </span>
  )
}
