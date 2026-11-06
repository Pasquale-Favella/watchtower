import { createContext } from 'react'

export interface MarkdownNavigation {
  readonly workspacePath?: string | undefined
  readonly openFile?: ((path: string) => void) | undefined
  readonly loadImage?: ((path: string) => Promise<string | null>) | undefined
}

export const MarkdownNavigationContext = createContext<MarkdownNavigation>({})
