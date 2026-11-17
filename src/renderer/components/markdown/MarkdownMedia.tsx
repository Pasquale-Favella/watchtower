import { ExternalLinkIcon, ImageIcon } from 'lucide-react'
import { type AnchorHTMLAttributes, type ImgHTMLAttributes, useContext, useState } from 'react'
import type { ExtraProps } from 'streamdown'

import { Button } from '@/renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/renderer/components/ui/dialog'
import { useNativeStore } from '@/renderer/shared/hooks/use-native-store'

import { isEmbeddedMarkdownImage, isExternalMarkdownUrl, markdownFilePath, markdownImagePath } from './markdown-url'
import { MarkdownNavigationContext } from './MarkdownNavigation'

export function MarkdownLink({
  children,
  href,
  node: _node,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps): React.JSX.Element {
  void _node
  const { openExternal } = useNativeStore()
  const navigation = useContext(MarkdownNavigationContext)
  const filePath = href ? markdownFilePath(href, navigation.workspacePath) : undefined
  const fileLink = filePath !== undefined && navigation.openFile !== undefined
  if (!href || (!href.startsWith('#') && !isExternalMarkdownUrl(href) && !fileLink)) return <span>{children}</span>

  return (
    <a
      {...props}
      href={href}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        if (fileLink) {
          navigation.openFile?.(filePath)
        } else if (isExternalMarkdownUrl(href)) {
          openExternal(href)
        } else {
          event.currentTarget
            .closest('.watchtower-markdown')
            ?.querySelector(`#${CSS.escape(href.slice(1))}`)
            ?.scrollIntoView({ block: 'nearest' })
        }
      }}
      onAuxClick={event => {
        event.preventDefault()
        event.stopPropagation()
        if (event.button === 1 && isExternalMarkdownUrl(href)) openExternal(href)
        if (event.button === 1 && fileLink) navigation.openFile?.(filePath)
      }}
    >
      {children}
    </a>
  )
}

export function MarkdownImage({
  src,
  alt,
  title,
}: ImgHTMLAttributes<HTMLImageElement> & ExtraProps): React.JSX.Element {
  const { openExternal } = useNativeStore()
  const navigation = useContext(MarkdownNavigationContext)
  const [failedSource, setFailedSource] = useState<string>()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<{
    readonly source: string
    readonly url: string | null
    readonly pending: boolean
    readonly error: boolean
  } | null>(null)
  const label = alt || title || 'Image'
  const source = typeof src === 'string' ? src : ''
  const localPath = markdownImagePath(source, navigation.workspacePath)
  const localPreview = preview?.source === source ? preview : null
  const resolvedSource = localPreview?.url ?? source

  if (!isEmbeddedMarkdownImage(resolvedSource) || failedSource === resolvedSource) {
    const external = isExternalMarkdownUrl(source)
    return (
      <Dialog open={false}>
        <span className="not-typeset bg-muted/30 text-muted-foreground inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <ImageIcon className="size-4 shrink-0" />
          <span className="truncate">{label}</span>
          {localPath && navigation.loadImage && (
            <Button
              variant="ghost"
              size="xs"
              disabled={localPreview?.pending}
              aria-label={`Load ${label} preview`}
              onClick={async () => {
                setPreview({ source, url: null, pending: true, error: false })
                try {
                  const url = await navigation.loadImage?.(localPath)
                  const safe = url && isEmbeddedMarkdownImage(url) ? url : null
                  setPreview({ source, url: safe, pending: false, error: safe === null })
                } catch {
                  setPreview({ source, url: null, pending: false, error: true })
                }
              }}
            >
              {localPreview?.pending ? 'Loading…' : 'Load preview'}
            </Button>
          )}
          {localPreview?.error && <span role="status">Image preview unavailable.</span>}
          {external && (
            <Button
              variant="ghost"
              size="icon-xs"
              title="Open image in browser"
              aria-label={`Open ${label} in browser`}
              onClick={() => openExternal(source)}
            >
              <ExternalLinkIcon />
            </Button>
          )}
        </span>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="not-typeset focus-visible:ring-ring inline-flex min-h-8 max-w-full min-w-8 cursor-zoom-in items-center justify-center rounded-lg outline-none focus-visible:ring-2"
          />
        }
        aria-label={`Preview ${label}`}
        onClick={() => setOpen(true)}
      >
        <img
          src={resolvedSource}
          alt={label}
          title={title}
          loading="lazy"
          decoding="async"
          className="max-h-96 max-w-full rounded-lg object-contain"
          onError={() => setFailedSource(resolvedSource)}
        />
      </DialogTrigger>
      <DialogContent className="sm:max-w-5xl">
        <DialogTitle className="pr-8">{label}</DialogTitle>
        <DialogDescription className="sr-only">Image preview</DialogDescription>
        <img src={resolvedSource} alt={label} className="max-h-[75vh] w-full object-contain" />
      </DialogContent>
    </Dialog>
  )
}
