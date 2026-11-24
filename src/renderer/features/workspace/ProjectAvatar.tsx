import { MessagesSquare } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/renderer/components/ui/avatar'
import { cn } from '@/renderer/shared/lib/utils'

import { projectMonogram, projectMonogramColor } from './project-avatar.js'

/**
 * The square Project avatar. Projects carry no icon yet, so it shows a tinted monogram;
 * chats with no Project get a loose-chat glyph in the surrounding text colour, so it reads on any surface.
 */
export function ProjectAvatar({
  projectId,
  name,
  className,
}: {
  /** Null for chats that belong to no Project. */
  readonly projectId: string | null
  readonly name: string
  readonly className?: string
}): React.JSX.Element {
  return (
    <Avatar aria-hidden="true" className={cn('size-4 rounded-[25%] after:rounded-[25%] after:border-0', className)}>
      <AvatarFallback
        className={cn(
          'rounded-[25%] text-[9px] leading-none font-semibold',
          projectId
            ? cn('bg-[color-mix(in_srgb,currentColor_14%,transparent)]', projectMonogramColor(projectId))
            : 'bg-[color-mix(in_srgb,currentColor_16%,transparent)] text-current',
        )}
      >
        {projectId ? projectMonogram(name) : <MessagesSquare className="size-2.5" strokeWidth={2.5} />}
      </AvatarFallback>
    </Avatar>
  )
}
