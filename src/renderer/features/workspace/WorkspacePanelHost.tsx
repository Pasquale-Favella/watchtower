import { type ReactNode, useEffect, useRef, useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog'
import type { DraftTerminalTarget, TerminalTarget } from '@/shared/schemas/terminal.js'
import type { ConversationId, ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'
import type { WorkspacePreviewShortcut } from '@/shared/schemas/workspace-preview.js'

import { WorkspaceBrowserPreview } from './browser-preview/WorkspaceBrowserPreview.js'
import { WorkspaceDevicePanel } from './devices/WorkspaceDevicePanel.js'
import { WorkspacePullRequestsPanel } from './pull-requests/WorkspacePullRequestsPanel.js'
import { type RightPanelSurface, surfaceKind, surfaceLabel, surfaceResource } from './right-panel/right-panel-state.js'
import type { RightPanelControls } from './right-panel/use-right-panel.js'
import { WorkspaceRightPanel } from './right-panel/WorkspaceRightPanel.js'
import { useCreateSideChat, useSideChats } from './side-chat/hooks.js'
import { SideChatPane } from './side-chat/SideChatPane.js'
import { useTerminalGroupActions } from './terminal/use-terminal-group-actions.js'
import { useTerminalGroupContext } from './terminal/use-terminal-group-context.js'
import { type TerminalExcerpt, WorkspaceTerminalPanel } from './terminal/WorkspaceTerminalDrawer.js'
import type { useWorkspacePanelResources } from './use-workspace-panel-resources.js'
import type { WorkspaceImageContext } from './WorkspaceImageAnnotation.js'

interface Props {
  readonly projectId?: ProjectId | undefined
  readonly checkoutId?: WorkspaceCheckoutId | undefined
  readonly panel: RightPanelControls
  readonly resources: ReturnType<typeof useWorkspacePanelResources>
  readonly ownerKey: string
  readonly reviewOwnerKey?: string | undefined
  readonly terminalTarget: TerminalTarget
  readonly retainedTerminalTarget?: DraftTerminalTarget | undefined
  readonly refreshKey: number
  readonly onReferencePath: (path: string) => void
  readonly onAddToChat?: ((excerpt: TerminalExcerpt & { readonly label: string }) => void) | undefined
  readonly onToggleTerminal: () => void
  readonly onAddImage?: ((image: WorkspaceImageContext) => Promise<void>) | undefined
  readonly parent?: { readonly taskId: TaskId; readonly conversationId: ConversationId } | undefined
  readonly onOpenTask?: ((taskId: TaskId, conversationId: ConversationId) => void) | undefined
  readonly onReferenceText?: ((text: string) => void) | undefined
}

export function WorkspacePanelHost(props: Props): React.JSX.Element {
  const terminal = useTerminalGroupActions()
  const groupContext = useTerminalGroupContext(props.terminalTarget, props.retainedTerminalTarget)
  const sideChat = useCreateSideChat()
  const sideChatHistory = useSideChats(props.parent?.taskId ?? null)
  const [resourceError, setResourceError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const decision = useRef<((confirmed: boolean) => void) | null>(null)
  useEffect(
    () => () => {
      decision.current?.(false)
    },
    [],
  )
  function settle(confirmed: boolean): void {
    decision.current?.(confirmed)
    decision.current = null
    setConfirming(false)
  }
  async function beforeClose(surface: RightPanelSurface): Promise<boolean> {
    if (surfaceKind(surface) !== 'terminal') return true
    const context = groupContext(surfaceResource(surface))
    if (!(await terminal.hasRunning(context.target, context.groupId))) return true
    return new Promise(resolve => {
      decision.current = resolve
      setConfirming(true)
    })
  }
  async function close(surface: RightPanelSurface): Promise<void> {
    if (surfaceKind(surface) === 'terminal') {
      const context = groupContext(surfaceResource(surface))
      await terminal.closeGroup(context.target, context.groupId)
    } else await props.resources.closeBrowser(surface)
  }
  function openSideChat(): void {
    const parent = props.parent
    if (!parent) return
    void sideChat
      .create({
        parentTaskId: parent.taskId,
        parentConversationId: parent.conversationId,
        ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
      })
      .then(binding => {
        if (!binding) return
        const surface = props.panel.addSurface('side-chat', binding.id)
        props.resources.setTitle(surface, binding.title)
      })
      .catch(() => undefined)
  }
  function titleForSurface(surface: RightPanelSurface): string {
    if (surfaceKind(surface) === 'terminal' && groupContext(surfaceResource(surface)).previousCheckout)
      return 'Terminal (previous checkout)'
    return props.resources.titles[surface] ?? surfaceLabel(surface)
  }
  function handleBrowserShortcut(
    surface: RightPanelSurface,
    action: Exclude<WorkspacePreviewShortcut, 'address'>,
  ): void {
    switch (action) {
      case 'new-tab':
        props.resources.openBrowser()
        break
      case 'toggle-panel':
        props.panel.toggle()
        break
      case 'toggle-terminal':
        props.onToggleTerminal()
        break
      case 'close-tab':
        void close(surface)
          .then(() => props.panel.closeSurface(surface))
          .catch(() => setResourceError('Could not close the browser tab. Try again.'))
        break
      case 'next-tab':
      case 'previous-tab': {
        const surfaces = props.panel.surfaces
        const index = surfaces.indexOf(surface)
        const next = surfaces[(index + (action === 'next-tab' ? 1 : -1) + surfaces.length) % surfaces.length]
        if (next) props.panel.activate(next)
        break
      }
    }
  }
  function renderSurface(surface: RightPanelSurface, visible: boolean): ReactNode {
    const resource = surfaceResource(surface)
    const kind = surfaceKind(surface)
    switch (kind) {
      case 'browser':
        return (
          <WorkspaceBrowserPreview
            ownerKey={props.ownerKey}
            tabId={resource}
            initialUrl={props.resources.urls[surface]}
            visible={visible}
            onTitleChange={title => props.resources.setTitle(surface, title)}
            onNewTab={url => props.resources.openBrowser(url)}
            onAddToChat={props.onAddImage}
            onShortcut={action => handleBrowserShortcut(surface, action)}
          />
        )
      case 'terminal': {
        const context = groupContext(resource)
        return (
          <WorkspaceTerminalPanel
            target={context.target}
            groupId={context.groupId}
            onNewTerminal={context.previousCheckout ? () => props.panel.addSurface('terminal') : undefined}
            visible={visible}
            onOpenLink={url => props.resources.openBrowser(url)}
            onAddToChat={props.onAddToChat}
          />
        )
      }
      case 'device':
        return (
          <WorkspaceDevicePanel
            ownerKey={props.ownerKey}
            tabId={resource}
            visible={visible}
            onTitleChange={title => props.resources.setTitle(surface, title)}
            onAddToChat={props.onAddImage}
          />
        )
      case 'side-chat':
        return (
          <SideChatPane
            id={resource}
            visible={visible}
            onOpenAsChat={binding => props.onOpenTask?.(binding.taskId, binding.conversationId)}
            onClose={() => props.panel.closeSurface(surface)}
            onOpenFile={props.panel.openFile}
            fileCheckoutId={props.checkoutId}
          />
        )
      case 'pull-requests':
      case 'pull-request':
        if (!props.projectId) return null
        return (
          <WorkspacePullRequestsPanel
            scope={{ projectId: props.projectId, ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}) }}
            number={kind === 'pull-request' ? Number(resource) : undefined}
            ownerKey={props.ownerKey}
            visible={visible}
            onOpenPullRequest={number => props.panel.addSurface('pull-request', String(number))}
            onReferenceText={props.onReferenceText}
          />
        )
      default:
        return null
    }
  }
  return (
    <>
      <WorkspaceRightPanel
        reviewOwnerKey={props.reviewOwnerKey ?? props.parent?.conversationId ?? props.ownerKey}
        projectId={props.projectId}
        checkoutId={props.checkoutId}
        controls={props.panel}
        refreshKey={props.refreshKey}
        onReferencePath={props.onReferencePath}
        onAddImage={props.onAddImage}
        onAddBrowser={() => props.resources.openBrowser()}
        onAddTerminal={() => props.panel.addSurface('terminal')}
        onAddDevice={() => props.panel.addSurface('device')}
        sideChatHistory={sideChatHistory.items}
        onOpenSideChat={id => props.panel.addSurface('side-chat', id)}
        onAddPullRequests={props.projectId ? () => props.panel.openSurface('pull-requests') : undefined}
        onAddSideChat={props.parent ? openSideChat : undefined}
        notice={sideChat.error ?? resourceError}
        titleForSurface={titleForSurface}
        beforeCloseSurface={beforeClose}
        onCloseSurface={close}
        renderSurface={renderSurface}
      />
      <AlertDialog
        open={confirming}
        onOpenChange={open => {
          if (!open) settle(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close running terminals?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the running processes in this tab and clears their history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => settle(true)}>
              Close terminals
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
