import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'

const resolver = createFileTreeIconResolver({ set: 'complete', colored: true })
const SPRITE_ID = 'watchtower-file-icons'

export function resolveFileIcon(path: string): ReturnType<typeof resolver.resolveIcon> {
  return resolver.resolveIcon('file-tree-icon-file', path)
}

export function ensureFileIconSprite(): void {
  if (typeof document === 'undefined' || !document.body || document.getElementById(SPRITE_ID)) return
  const sprite = document.createElement('div')
  sprite.id = SPRITE_ID
  sprite.setAttribute('aria-hidden', 'true')
  sprite.hidden = true
  sprite.innerHTML = getBuiltInSpriteSheet('complete')
  document.body.prepend(sprite)
}
