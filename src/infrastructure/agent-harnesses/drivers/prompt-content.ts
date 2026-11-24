import type { ResolvedPromptAttachment } from '@/shared/schemas/prompt-context.js'

export function attachmentText(attachment: ResolvedPromptAttachment): string {
  const label = JSON.stringify(attachment.name)
  if (attachment.mediaType !== 'text/plain')
    return `Attached file ${label} is available at ${JSON.stringify(attachment.localPath)}. Read this file using your tools when needed.`
  const prefix =
    attachment.source === 'skill' || attachment.source === 'command'
      ? `Apply the user-selected ${attachment.source} ${label}:`
      : `Attached file ${label}:`
  return `${prefix}\n<attached-context>\n${attachment.content}\n</attached-context>`
}
