import { createContext } from 'react'

import type { PromptAttachment } from '@/shared/schemas/prompt-context.js'

export const PromptMessageAttachmentsContext = createContext<readonly PromptAttachment[]>([])
