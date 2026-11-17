import {
  Check,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FolderOpen,
  FolderTree,
  MoreHorizontal,
  Save,
  WrapText,
} from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { CheckoutEditor } from '@/shared/rpc/checkout-navigation.js'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

import { useCheckoutNavigation } from '../checkout-navigation/use-checkout-navigation.js'
import { useMarkdownImageLoader } from '../markdown-navigation-hooks.js'
import type { WorkspaceImageContext } from '../WorkspaceImageAnnotation.js'
import { ExplorerPane } from './ExplorerPane.js'
import { renderedFileKind } from './file-preview-kind.js'
import { extendedFilePreviewKind } from './file-previews/preview-types.js'
import { FileBreadcrumbs } from './FileBreadcrumbs.js'
import { FileExplorer } from './FileExplorer.js'
import { ImageFilePreview, MediaFilePreview, RenderedTextPreview } from './FilePreviews.js'
import { InspectionNotice } from './inspection-ui.js'
import { ReviewCodeSurface } from './ReviewCodeSurface.js'
import { useCheckoutFileContent } from './use-checkout-inspection.js'
import { useFileEditSession } from './use-file-edit-session.js'
import { usePanelBoolean } from './use-panel-preference.js'

const ExtendedFilePreview = lazy(() =>
  import('./file-previews/ExtendedFilePreview.js').then(module => ({ default: module.ExtendedFilePreview })),
)

const EDITORS: readonly { readonly value: CheckoutEditor; readonly label: string }[] = [
  { value: 'vscode', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'vscodium', label: 'VSCodium' },
  { value: 'system', label: 'Default app' },
]

export interface FilesTabProps {
  readonly scope: CheckoutScope
  readonly revision: number
  readonly onReferencePath: (path: string) => void
  readonly onOpenFile?: ((path: string) => void) | undefined
  readonly selectedPath?: string | null | undefined
  readonly onAddImage?: ((image: WorkspaceImageContext) => Promise<void>) | undefined
}

interface FilePanelProps extends FilesTabProps {
  readonly path: string | null
  readonly revealLine?: number | null | undefined
}

export function FilesTab(props: FilesTabProps): React.JSX.Element {
  return <FilePanel {...props} path={null} />
}

export function FilePanel(props: FilePanelProps): React.JSX.Element {
  const [localPath, setLocalPath] = useState<string | null>(props.path)
  const [folder, setFolder] = useState<string | null>(props.path === null ? '' : null)
  const [explorer, setExplorer] = usePanelBoolean('watchtower.workspace.file-explorer-open.v1', true)
  const path = props.onOpenFile ? props.path : localPath
  const viewingFolder = folder !== null || path === null
  function openFile(next: string): void {
    setFolder(null)
    setLocalPath(next)
    props.onOpenFile?.(next)
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FileViewer
        {...props}
        path={path}
        folder={folder}
        onNavigateFolder={setFolder}
        onOpenFile={openFile}
        explorer={explorer}
        onToggleExplorer={() => setExplorer(!explorer)}
        renderContent={content => (
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {!viewingFolder && content}
            <ExplorerPane fullWidth={viewingFolder} visible={viewingFolder || explorer}>
              <FileExplorer
                key={JSON.stringify([props.scope.projectId, props.scope.checkoutId ?? null])}
                {...props}
                root={folder ?? ''}
                selectedPath={viewingFolder ? null : path}
                onOpenFile={openFile}
              />
            </ExplorerPane>
          </div>
        )}
      />
    </div>
  )
}

interface ViewerProps extends FilePanelProps {
  readonly folder?: string | null | undefined
  readonly onNavigateFolder?: ((path: string) => void) | undefined
  readonly explorer?: boolean | undefined
  readonly onToggleExplorer?: (() => void) | undefined
  readonly renderContent?: ((content: React.ReactNode) => React.ReactNode) | undefined
}

/** Breadcrumbs and file actions share the subheader, leaving the code the full content height. */
export function FileViewer(props: ViewerProps): React.JSX.Element {
  const { scope, path, revision } = props
  const viewingFolder = (props.folder !== null && props.folder !== undefined) || path === null
  const file = useCheckoutFileContent(scope, viewingFolder ? null : path, revision)
  const edit = useFileEditSession(scope, path, file.data)
  const loadImage = useMarkdownImageLoader(scope)
  const navigation = useCheckoutNavigation(scope, path)
  const [wrap, setWrap] = usePanelBoolean('watchtower.workspace.file-wrap.v1', false)
  const renderedKind = path ? renderedFileKind(path) : null
  const [rendered, setRendered] = usePanelBoolean(
    `watchtower.workspace.file-rendered-${renderedKind ?? 'source'}.v1`,
    true,
  )
  const [dismissedReveal, setDismissedReveal] = useState<number | null>(null)
  const revealLine = props.revealLine === dismissedReveal ? null : props.revealLine
  const showRendered = rendered && revealLine == null

  async function download(): Promise<void> {
    if (!path) return
    if (edit.dirty && !(await edit.save())) return
    await navigation.download()
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-file-panel={path ?? ''}
      onKeyDownCapture={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !viewingFolder) {
          event.preventDefault()
          event.stopPropagation()
          void edit.save()
        }
      }}
    >
      <div className="border-border flex h-9 shrink-0 items-center gap-0.5 border-b px-2">
        <FileBreadcrumbs
          scope={scope}
          revision={revision}
          path={props.folder ?? path ?? ''}
          folder={viewingFolder}
          onNavigateFolder={props.onNavigateFolder ?? (() => {})}
          onOpenFile={props.onOpenFile ?? (() => {})}
        />
        {!viewingFolder && path && (
          <>
            <span
              role="status"
              aria-label={
                edit.error
                  ? 'File not saved'
                  : edit.saving
                    ? 'Saving file'
                    : edit.dirty
                      ? 'Unsaved changes'
                      : 'File saved'
              }
              className={`mx-1 size-1.5 shrink-0 rounded-full ${edit.dirty ? 'bg-warning' : 'bg-transparent'}`}
            />
            <FileAction
              label={`Open file in ${EDITORS.find(item => item.value === navigation.editor)?.label ?? 'editor'}`}
              disabled={navigation.pending}
              onClick={() => {
                void navigation.open()
              }}
            >
              <ExternalLink />
            </FileAction>
            {renderedKind && (
              <FileAction
                label={showRendered ? 'Show source' : 'Show rendered preview'}
                pressed={showRendered}
                onClick={() => {
                  setRendered(!showRendered)
                  setDismissedReveal(props.revealLine ?? null)
                }}
              >
                {showRendered ? <Code2 /> : <Eye />}
              </FileAction>
            )}
            {(!renderedKind || !showRendered) && !file.data?.binary && (
              <FileAction label="Wrap file lines" pressed={wrap} onClick={() => setWrap(!wrap)}>
                <WrapText />
              </FileAction>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="File actions" />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {EDITORS.map(editor => (
                  <DropdownMenuItem
                    key={editor.value}
                    onClick={() => {
                      void navigation.open(editor.value)
                    }}
                  >
                    <span className="size-4">{navigation.editor === editor.value && <Check />}</span>Open in{' '}
                    {editor.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    void navigation.reveal()
                  }}
                >
                  <FolderOpen />
                  Reveal in file manager
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void navigator.clipboard.writeText(path)
                  }}
                >
                  <Copy />
                  Copy file path
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => props.onReferencePath(path)}>Add to chat</DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void download()
                  }}
                  disabled={navigation.pending}
                >
                  <Download />
                  Download file
                </DropdownMenuItem>
                {edit.writable && (
                  <DropdownMenuItem
                    onClick={() => {
                      void edit.save()
                    }}
                  >
                    <Save />
                    Save file
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {props.onToggleExplorer && (
              <FileAction
                label={props.explorer ? 'Hide file tree' : 'Show file tree'}
                pressed={props.explorer}
                onClick={props.onToggleExplorer}
              >
                <FolderTree />
              </FileAction>
            )}
          </>
        )}
      </div>
      {navigation.error && <InspectionNotice tone="error">{navigation.error}</InspectionNotice>}
      {props.renderContent ? (
        props.renderContent(
          <FileContentView
            {...props}
            file={file}
            edit={edit}
            loadImage={loadImage}
            wrap={wrap}
            rendered={showRendered}
            revealLine={revealLine}
          />,
        )
      ) : (
        <FileContentView
          {...props}
          file={file}
          edit={edit}
          loadImage={loadImage}
          wrap={wrap}
          rendered={showRendered}
          revealLine={revealLine}
        />
      )}
    </div>
  )
}

interface ContentViewProps extends FilePanelProps {
  readonly file: ReturnType<typeof useCheckoutFileContent>
  readonly edit: ReturnType<typeof useFileEditSession>
  readonly wrap: boolean
  readonly rendered: boolean
  readonly loadImage: ReturnType<typeof useMarkdownImageLoader>
}

function FileContentView(props: ContentViewProps): React.JSX.Element {
  const { scope, path, file, edit, wrap, rendered } = props
  const renderedKind = path ? renderedFileKind(path) : null
  const source = path ? (
    <ReviewCodeSurface
      key={path}
      path={path}
      contents={edit.content}
      wrap={wrap}
      editable={edit.writable || edit.dirty}
      onChange={edit.change}
      sectionId={JSON.stringify([scope.projectId, scope.checkoutId ?? null, 'file', path])}
      revealLine={props.revealLine}
    />
  ) : null
  let body: React.ReactNode
  if (edit.dirty && path && (file.error || !file.data)) body = source
  else if (file.error) body = <InspectionNotice tone="error">{file.error.message}</InspectionNotice>
  else if (!file.data || !path) body = <InspectionNotice>Loading file…</InspectionNotice>
  else if (extendedFilePreviewKind(path))
    body = (
      <Suspense fallback={<InspectionNotice>Loading preview…</InspectionNotice>}>
        <ExtendedFilePreview path={path} dataUrl={file.data.previewDataUrl} content={file.data.content} />
      </Suspense>
    )
  else if (file.data.previewDataUrl?.startsWith('data:image/'))
    body = (
      <ImageFilePreview
        key={`${path}:${file.data.revision ?? file.data.previewDataUrl.length}`}
        path={path}
        dataUrl={file.data.previewDataUrl}
        onAddImage={props.onAddImage}
      />
    )
  else if (file.data.previewDataUrl) body = <MediaFilePreview path={path} dataUrl={file.data.previewDataUrl} />
  else if (file.data.content === null)
    body = (
      <InspectionNotice>
        Preview unavailable for this file type. Download the file or open it in an editor.
      </InspectionNotice>
    )
  else if (renderedKind && rendered && props.revealLine == null)
    body = (
      <RenderedTextPreview
        key={path}
        path={path}
        content={edit.content}
        onChange={edit.writable ? edit.change : undefined}
        onOpenFile={props.onOpenFile}
        loadImage={props.loadImage}
      />
    )
  else body = source
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {file.error && edit.dirty && (
        <InspectionNotice tone="error">{file.error.message} Your draft remains editable.</InspectionNotice>
      )}
      {edit.error && (
        <div role="alert" className="border-destructive/30 text-destructive border-b px-3 py-2 text-xs">
          <p>{edit.error}</p>
          <div className="mt-1 flex gap-2">
            <Button
              variant="outline"
              size="xs"
              disabled={edit.saving}
              onClick={() => {
                void edit.save()
              }}
            >
              Retry save
            </Button>
            <Button variant="ghost" size="xs" disabled={edit.saving} onClick={edit.reload}>
              Reload from disk
            </Button>
          </div>
        </div>
      )}
      {file.data?.truncated && (
        <InspectionNotice>Preview is limited. Open the complete file in an editor to edit it.</InspectionNotice>
      )}
      {body}
    </div>
  )
}

function FileAction({
  label,
  onClick,
  children,
  pressed,
  disabled,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly children: React.ReactNode
  readonly pressed?: boolean | undefined
  readonly disabled?: boolean | undefined
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
