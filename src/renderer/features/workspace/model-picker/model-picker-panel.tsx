import { type ReactNode, type RefObject, useRef, useState } from 'react'

import type { WorkspaceConnection } from '@/shared/schemas/workspace-connections.js'

import type { AgentChoice } from '../agent-preferences.js'
import { useWorkspaceConnectionCatalog, type WorkspaceConnectionCatalog } from '../connection-hooks.js'
import { catalogView, connectionDetail, connectionStatus, type ModelChoice } from './catalog.js'
import { ConnectionRail } from './connection-rail.js'
import { ModelList } from './model-list.js'

/** Body of the agent picker popover. Preview, search and highlight are local to one opening. The effort column and
 *  footer are rendered by the owner, since they describe the committed choice rather than the previewed agent. */
export function ModelPickerPanel({
  connections,
  activeConnectionId,
  activeCatalog,
  activeChoice,
  sessionModels,
  lockedConnectionId,
  rememberedFor,
  onCommit,
  onClose,
  searchRef,
  effortColumn,
  footer,
  initialQuery = '',
}: {
  readonly initialQuery?: string
  readonly connections: readonly WorkspaceConnection[]
  readonly activeConnectionId: string
  /** The selected connection's catalog, already merged with any parent-held session facts. */
  readonly activeCatalog: WorkspaceConnectionCatalog
  readonly activeChoice: AgentChoice
  readonly sessionModels: readonly ModelChoice[] | undefined
  readonly lockedConnectionId: string | undefined
  readonly rememberedFor: (connectionId: string) => AgentChoice | undefined
  readonly onCommit: (connectionId: string, modelId: string) => void
  readonly onClose: () => void
  readonly searchRef?: RefObject<HTMLInputElement | null>
  readonly effortColumn?: ReactNode
  readonly footer?: ReactNode
}) {
  const [draftId, setDraftId] = useState<string | null>(null)
  const [query, setQuery] = useState(initialQuery)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const ownInputRef = useRef<HTMLInputElement>(null)
  const inputRef = searchRef ?? ownInputRef

  const previewId = draftId ?? activeConnectionId
  const previewIsActive = previewId === activeConnectionId
  // Only a previewed connection is inspected here, and only while this popover is open.
  const previewed = useWorkspaceConnectionCatalog(previewId)
  const catalog = previewIsActive ? activeCatalog : previewed
  const view = catalogView({
    inspection: catalog.inspection,
    failed: catalog.failed,
    sessionModels: previewIsActive ? sessionModels : undefined,
  })
  const checkedId = previewIsActive ? activeChoice.modelId : (rememberedFor(previewId)?.modelId ?? '')

  function previewConnection(connectionId: string) {
    setDraftId(connectionId)
    setQuery('')
    setHighlightedId(null)
  }

  return (
    <div className="flex max-h-(--available-height) flex-col">
      <div className="flex h-[320px] min-h-0 overflow-hidden">
        <ConnectionRail
          railRef={railRef}
          connections={connections}
          previewId={previewId}
          lockedId={lockedConnectionId}
          readingOf={connectionId => (connectionId === activeConnectionId ? activeCatalog : undefined)}
          onPreview={previewConnection}
          onLeaveRail={() => inputRef.current?.focus()}
        />
        <ModelList
          inputRef={inputRef}
          view={view}
          query={query}
          onQueryChange={value => {
            setQuery(value)
            setHighlightedId(null)
          }}
          checkedId={checkedId}
          highlightedId={highlightedId}
          onHighlight={setHighlightedId}
          onPick={modelId => onCommit(previewId, modelId)}
          onRetry={catalog.retry}
          notice={
            connectionStatus(catalog) === 'pending'
              ? null
              : {
                  tone: connectionStatus(catalog) === 'ready' ? 'info' : 'attention',
                  text: connectionDetail(catalog),
                }
          }
          onClose={onClose}
          onLeaveSearch={() => railRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()}
        />
        {effortColumn}
      </div>
      {footer}
    </div>
  )
}
