import { type ReactNode, type RefObject, useRef, useState } from 'react'

import type { WorkspaceConnection } from '@/shared/schemas/workspace-connections.js'

import type { AgentChoice } from '../agent-preferences.js'
import { useWorkspaceConnectionCatalog, type WorkspaceConnectionCatalog } from '../connection-hooks.js'
import { AgentSetupWelcome } from './agent-setup-welcome.js'
import {
  catalogView,
  connectionDetail,
  connectionEffort,
  connectionStatus,
  knownModels,
  type ModelChoice,
} from './catalog.js'
import { ConnectionRail } from './connection-rail.js'
import { ModelList } from './model-list.js'
import { PreviewOptionsColumn } from './preview-options-column.js'
import { AGENT_DEFAULT, modeForModelCommit, resolveAgentChoice } from './selection.js'

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
  configValues,
  onModeChange,
  onConfigValueChange,
  onClose,
  searchRef,
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
  readonly onCommit: (connectionId: string, modelId: string, modeId: string) => void
  readonly configValues: Readonly<Record<string, string>>
  readonly onModeChange: (connectionId: string, modeId: string) => void
  readonly onConfigValueChange: (connectionId: string, id: string, value: string) => void
  readonly onClose: () => void
  readonly searchRef?: RefObject<HTMLInputElement | null>
  readonly footer?: ReactNode
}) {
  const [draftId, setDraftId] = useState<string | null>(null)
  const [query, setQuery] = useState(initialQuery)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const ownInputRef = useRef<HTMLInputElement>(null)
  const inputRef = searchRef ?? ownInputRef

  const previewId = draftId ?? activeConnectionId
  const previewConnectionInfo = connections.find(connection => connection.connectionId === previewId)
  const previewIsActive = previewId === activeConnectionId
  // Only a previewed connection is inspected here, and only while this popover is open.
  const previewed = useWorkspaceConnectionCatalog(previewId)
  const catalog = previewIsActive ? activeCatalog : previewed
  const view = catalogView({
    inspection: catalog.inspection,
    failed: catalog.failed,
    sessionModels: previewIsActive ? sessionModels : undefined,
  })
  const previewChoice = previewIsActive
    ? activeChoice
    : resolveAgentChoice({
        conversation: AGENT_DEFAULT,
        remembered: rememberedFor(previewId),
        models: knownModels(view),
        connectionEffort: connectionEffort(catalog.inspection),
      }).choice
  const checkedId = previewChoice.modelId
  const previewConfigValues = previewIsActive ? configValues : (rememberedFor(previewId)?.configValues ?? {})

  function previewConnection(connectionId: string) {
    setDraftId(connectionId)
    setQuery('')
    setHighlightedId(null)
  }

  function changeMode(modeId: string): void {
    onModeChange(previewId, modeId)
  }

  function changeConfigValue(id: string, value: string): void {
    onConfigValueChange(previewId, id, value)
  }

  function commitModel(modelId: string): void {
    const modeId = modeForModelCommit({
      previewIsActive,
      modelId,
      modeId: previewChoice.modeId,
      models: knownModels(view),
      connectionEffort: connectionEffort(catalog.inspection),
    })
    onCommit(previewId, modelId, modeId)
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
        {previewConnectionInfo ? (
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
            onPick={commitModel}
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
        ) : (
          <AgentSetupWelcome hasConnections={connections.length > 0} />
        )}
        {previewConnectionInfo && (
          <PreviewOptionsColumn
            view={view}
            inspection={catalog.inspection}
            modelId={previewChoice.modelId}
            modeId={previewChoice.modeId}
            configValues={previewConfigValues}
            onModeChange={changeMode}
            onConfigValueChange={changeConfigValue}
            onLeave={() => inputRef.current?.focus()}
          />
        )}
      </div>
      {previewConnectionInfo && footer}
    </div>
  )
}
