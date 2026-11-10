import { File, Folder } from 'lucide-react'

import { ensureFileIconSprite, resolveFileIcon } from './file-icons/file-icons.js'

const ICON_TONES: Readonly<Record<string, string>> = {
  typescript: 'text-blue-600 dark:text-blue-400',
  javascript: 'text-yellow-600 dark:text-yellow-400',
  react: 'text-cyan-600 dark:text-cyan-400',
  vue: 'text-emerald-600 dark:text-emerald-400',
  css: 'text-violet-600 dark:text-violet-400',
  html: 'text-orange-600 dark:text-orange-400',
  json: 'text-amber-600 dark:text-amber-400',
  markdown: 'text-sky-600 dark:text-sky-400',
  python: 'text-blue-600 dark:text-blue-400',
  git: 'text-orange-600 dark:text-orange-400',
  npm: 'text-red-600 dark:text-red-400',
  image: 'text-pink-600 dark:text-pink-400',
}

ensureFileIconSprite()

export function WorkspaceFileIcon({ path }: { readonly path: string }): React.JSX.Element {
  if (path.endsWith('/')) return <Folder aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
  const icon = resolveFileIcon(path)
  if (!icon) return <File aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
  const tone = ICON_TONES[icon.token ?? 'default'] ?? 'text-muted-foreground'
  return (
    <svg aria-hidden="true" data-file-icon={icon.name} className={`size-4 shrink-0 ${tone}`} viewBox="0 0 16 16">
      <use href={`#${icon.name}`} />
    </svg>
  )
}
