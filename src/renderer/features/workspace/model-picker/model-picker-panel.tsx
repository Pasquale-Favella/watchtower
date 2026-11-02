import { useRef, useState } from 'react'

import type { WorkspaceConnection } from '@/shared/schemas/workspace-connections.js'

import type { AgentChoice } from '../agent-preferences.js'
import { useWorkspaceConnectionCatalog, type WorkspaceConnectionCatalog } from '../connection-hooks.js'
import { catalogView, connectionStatus, type ModelChoice } from './catalog.js'
import { ConnectionRail } from './connection-rail.js'
import { ModelList } from './model-list.js'

/** Body of the agent picker popover. Preview, search and highlight are local to one opening. */
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
}: {
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
}) {
  const [draftId, setDraftId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
    <div className="flex h-[320px] overflow-hidden">
      <ConnectionRail
        railRef={railRef}
        connections={connections}
        previewId={previewId}
        lockedId={lockedConnectionId}
        statusOf={connectionId => {
          if (connectionId === previewId) return connectionStatus(catalog)
          if (connectionId === activeConnectionId) return connectionStatus(activeCatalog)
          return 'ready'
        }}
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
        onClose={onClose}
        onLeaveSearch={() => railRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()}
      />
    </div>
  )
}
