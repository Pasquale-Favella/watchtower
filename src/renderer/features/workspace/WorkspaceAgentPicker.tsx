import { ChevronDown, LoaderCircle } from 'lucide-react'
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import type { WorkspaceConnection, WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

import { useRememberedAgentChoices } from './agent-preferences.js'
import { useWorkspaceConnectionCatalog } from './connection-hooks.js'
import { catalogView, connectionEffort, effortFor, knownModels, type ModelChoice } from './model-picker/catalog.js'
import { EffortControl } from './model-picker/effort-control.js'
import { ModelPickerPanel } from './model-picker/model-picker-panel.js'
import { normalizationFor, resolveAgentChoice } from './model-picker/selection.js'

export interface WorkspaceAgentPickerControl {
  readonly open: () => void
  /** Opens the effort menu. It does nothing while the selected model offers no effort choices. */
  readonly openEffort?: () => void
}

type Props = {
  readonly controlRef?: Ref<WorkspaceAgentPickerControl>
  readonly connections: readonly WorkspaceConnection[]
  readonly connectionId: string
  readonly modelId: string
  readonly modeId: string
  /** Parent-held inspection. It wins while it describes the selected connection, since it can carry session facts. */
  readonly inspection?: WorkspaceConnectionInspection | null
  /** Parent-held loading flag. Only shown while no inspection is available for the selected connection. */
  readonly pending?: boolean
  /** Models observed in the Conversation's native session. Used when the agent's catalog is session-scoped. */
  readonly sessionModels?: readonly ModelChoice[]
  /** Set for a Conversation bound to a native session. Other agents are then disabled. */
  readonly lockedConnectionId?: string
  readonly onConnectionChange: (id: string) => void
  readonly onModelChange: (id: string) => void
  readonly onModeChange: (id: string) => void
  /** Commits a connection and model pick together. Without it the two callbacks above are used in turn. */
  readonly onAgentChange?: (choice: {
    readonly connectionId: string
    readonly modelId: string
    readonly modeId: string
  }) => void
}

/** Agent and model picker in the Coach & Skills style. One trigger opens a popover with the agent rail on the left
 *  and the searchable model list on the right. The selected agent's catalog is inspected as soon as the picker
 *  mounts and cached per connection for the session. Remembered choices and the Conversation's own choice are
 *  resolved here, and the parent is kept in step with the choice that is shown. */
export function WorkspaceAgentPicker(props: Props): React.JSX.Element {
  const { connectionId, onModelChange, onModeChange } = props
  const [open, setOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  useImperativeHandle(
    props.controlRef,
    () => ({ open: () => setOpen(true), openEffort: () => setEffortOpen(true) }),
    [],
  )

  const remembered = useRememberedAgentChoices()
  const selectedConnection = props.connections.find(connection => connection.connectionId === connectionId) ?? null
  const own = useWorkspaceConnectionCatalog(connectionId)
  const parentInspection = props.inspection && props.inspection.connectionId === connectionId ? props.inspection : null
  const inspection = parentInspection ?? own.inspection
  const activeCatalog = {
    ...own,
    inspection,
    pending: own.pending || (props.pending === true && inspection === null),
  }

  const view = catalogView({ inspection, failed: own.failed, sessionModels: props.sessionModels })
  const models = knownModels(view)
  const resolved = resolveAgentChoice({
    conversation: { modelId: props.modelId, modeId: props.modeId },
    remembered: remembered.choiceFor(connectionId),
    models,
    connectionEffort: connectionEffort(inspection),
  }).choice
  const effortOptions = effortFor({ models, connectionEffort: connectionEffort(inspection), modelId: resolved.modelId })

  // Keep the parent's stored choice equal to the one shown, so a submission uses what the user sees. A key guards
  // against repeated updates while the parent still holds a different value.
  const normalization = normalizationFor({ modelId: props.modelId, modeId: props.modeId }, resolved)
  const normalizeModel = normalization?.modelId
  const normalizeMode = normalization?.modeId
  const normalizing = normalization !== null
  const normalizationKey = `${connectionId}\u0000${resolved.modelId}\u0000${resolved.modeId}`
  const syncedKey = useRef('')
  useEffect(() => {
    if (!normalizing) {
      syncedKey.current = ''
      return
    }
    if (syncedKey.current === normalizationKey) return
    syncedKey.current = normalizationKey
    if (normalizeModel !== undefined) onModelChange(normalizeModel)
    if (normalizeMode !== undefined) onModeChange(normalizeMode)
  }, [normalizing, normalizationKey, normalizeModel, normalizeMode, onModelChange, onModeChange])

  function commit(targetConnectionId: string, modelId: string) {
    remembered.remember(targetConnectionId, { modelId, modeId: '' })
    if (props.onAgentChange) {
      props.onAgentChange({ connectionId: targetConnectionId, modelId, modeId: '' })
    } else {
      if (targetConnectionId !== connectionId) props.onConnectionChange(targetConnectionId)
      onModelChange(modelId)
    }
    setEffortOpen(false)
    setOpen(false)
  }

  function chooseEffort(modeId: string) {
    remembered.remember(connectionId, { modelId: resolved.modelId, modeId })
    onModeChange(modeId)
    setEffortOpen(false)
  }

  const listed = view.kind === 'listed' || view.kind === 'session' ? view.models : []
  const modelName = resolved.modelId
    ? (listed.find(model => model.id === resolved.modelId)?.label ?? resolved.modelId)
    : 'default'
  let triggerLabel = 'Choose an agent'
  if (selectedConnection) triggerLabel = `${selectedConnection.label} · ${modelName}`
  else if (props.connections.length === 0) triggerLabel = 'No agent detected'

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Agent and model"
              title={triggerLabel}
              disabled={props.connections.length === 0}
              className="border-border h-7 max-w-56 min-w-0 gap-1.5 pr-1.5 text-[11.5px] font-normal"
            />
          }
        >
          {selectedConnection && <HarnessIcon kind={selectedConnection.harnessKind} className="size-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
          {activeCatalog.pending ? (
            <LoaderCircle className="text-muted-foreground size-3 shrink-0 animate-spin" />
          ) : (
            <ChevronDown className="text-muted-foreground size-3.5 shrink-0 opacity-50" />
          )}
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[380px] max-w-[calc(100vw-2rem)] p-0"
          aria-label="Choose agent and model"
        >
          <ModelPickerPanel
            connections={props.connections}
            activeConnectionId={connectionId}
            activeCatalog={activeCatalog}
            activeChoice={resolved}
            sessionModels={props.sessionModels}
            lockedConnectionId={props.lockedConnectionId}
            rememberedFor={remembered.choiceFor}
            onCommit={commit}
            onClose={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
      {effortOptions && effortOptions.length > 0 && (
        <EffortControl
          options={effortOptions}
          value={resolved.modeId}
          open={effortOpen}
          onOpenChange={setEffortOpen}
          onChange={chooseEffort}
        />
      )}
    </>
  )
}
