import { LoaderCircle } from 'lucide-react'
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import { cn } from '@/renderer/shared/lib/utils'
import type { AgentAccessMode } from '@/shared/schemas/execution.js'
import type { WorkspaceConnection, WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

import { useRememberedAgentChoices } from './agent-preferences.js'
import { useWorkspaceConnectionCatalog } from './connection-hooks.js'
import {
  configOptionsForModel,
  configValueForOption,
  configValuesForOptions,
  needsNativeChoiceControl,
} from './config-values.js'
import type { AccessModeOption } from './model-picker/access-mode.js'
import {
  catalogView,
  connectionEffort,
  effortFor,
  effortTitleFor,
  knownModels,
  type ModelChoice,
} from './model-picker/catalog.js'
import { composerControlClass } from './model-picker/composer-control.js'
import { ConfigOptionsColumn } from './model-picker/config-options-column.js'
import { EffortColumn } from './model-picker/effort-column.js'
import { ModelPickerPanel } from './model-picker/model-picker-panel.js'
import { PermissionsFooter } from './model-picker/permissions.js'
import { normalizationFor, resolveAgentChoice } from './model-picker/selection.js'

export interface WorkspaceAgentPickerControl {
  readonly open: (query?: string) => void
  /** Opens the picker with focus on the effort column. */
  readonly openEffort?: () => void
}

type Props = {
  readonly controlRef?: Ref<WorkspaceAgentPickerControl>
  readonly connections: readonly WorkspaceConnection[]
  readonly connectionId: string
  readonly modelId: string
  readonly modeId: string
  readonly configValues?: Readonly<Record<string, string>>
  /** Parent-held inspection. It wins while it describes the selected connection, since it can carry session facts. */
  readonly inspection?: WorkspaceConnectionInspection | null
  /** Parent-held loading flag. Only shown while no inspection is available for the selected connection. */
  readonly pending?: boolean
  /** Models observed in the Conversation's native session. Used when the agent's catalog is session-scoped. */
  readonly sessionModels?: readonly ModelChoice[]
  /** Set for a Conversation bound to a native session. Other agents are then disabled. */
  readonly lockedConnectionId?: string
  /** Permissions the next message uses. The picker's footer offers them when given. */
  readonly access?: {
    readonly mode: AgentAccessMode
    readonly options: readonly AccessModeOption[]
    readonly onChange: (mode: AgentAccessMode) => void
  }
  readonly onConnectionChange: (id: string) => void
  readonly onModelChange: (id: string) => void
  readonly onModeChange: (id: string) => void
  readonly onConfigValueChange?: (id: string, value: string) => void
  /** Commits a connection and model pick together. Without it the two callbacks above are used in turn. */
  readonly onAgentChange?: (choice: {
    readonly connectionId: string
    readonly modelId: string
    readonly modeId: string
  }) => void
}

function focusEffort(popup: HTMLElement | null) {
  const column = popup?.querySelector('[data-effort-column]')
  const row =
    column?.querySelector<HTMLElement>(
      '[data-effort-row][aria-checked="true"], [data-config-option-row][aria-checked="true"]',
    ) ??
    column?.querySelector<HTMLElement>('[data-config-option-row]') ??
    column?.querySelector<HTMLElement>('[data-effort-row]')
  row?.focus({ preventScroll: true })
  return row != null
}

/** The composer's model picker: one trigger names the model and its effort. Its popover holds the
 *  agent rail, the searchable models, the effort column of the chosen model and the permissions footer. The selected
 *  agent's catalog is inspected as soon as the picker mounts and cached per connection for the session. Remembered
 *  choices and the Conversation's own choice are resolved here, and the parent is kept in step with what is shown. */
export function WorkspaceAgentPicker(props: Props): React.JSX.Element {
  const { connectionId, onModelChange, onModeChange } = props
  const [open, setOpen] = useState(false)
  const [initialQuery, setInitialQuery] = useState('')
  const openTarget = useRef<'effort' | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useImperativeHandle(
    props.controlRef,
    () => ({
      open: (query = '') => {
        setInitialQuery(query)
        setOpen(true)
      },
      openEffort: () => {
        openTarget.current = 'effort'
        setOpen(true)
      },
    }),
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
  const baseConfigOptions = inspection?.capabilities.configOptions ?? []
  const selectedModel = models?.find(model => model.id === resolved.modelId)
  const configOptions = configOptionsForModel(baseConfigOptions, selectedModel)
  const configValues = configValuesForOptions(configOptions, props.configValues ?? {})

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
    // A model pick leaves the picker open on the new model's effort levels.
    requestAnimationFrame(() => {
      if (!focusEffort(popupRef.current)) setOpen(false)
    })
  }

  function chooseEffort(modeId: string) {
    remembered.remember(connectionId, { modelId: resolved.modelId, modeId })
    onModeChange(modeId)
  }

  function chooseConfigValue(id: string, value: string): void {
    const rememberedConfigValues = remembered.choiceFor(connectionId)?.configValues ?? {}
    remembered.remember(connectionId, {
      configValues: { ...rememberedConfigValues, ...(props.configValues ?? {}), [id]: value },
    })
    props.onConfigValueChange?.(id, value)
  }

  const listed = view.kind === 'listed' || view.kind === 'session' ? view.models : []
  const modelName = resolved.modelId
    ? (listed.find(model => model.id === resolved.modelId)?.label ?? resolved.modelId)
    : 'Default model'
  const effortTitle = effortTitleFor(effortOptions)
  const fallbackEffort =
    effortOptions?.length && needsNativeChoiceControl(effortTitle, configOptions)
      ? {
          title: effortTitle,
          modelLabel: modelName,
          options: effortOptions,
          value: resolved.modeId,
          onPick: chooseEffort,
        }
      : undefined
  const effortLabel = resolved.modeId
    ? (effortOptions?.find(option => option.id === resolved.modeId)?.label ?? resolved.modeId)
    : null
  const configSummary = configOptions
    .map(option => {
      const value = configValueForOption(option, configValues)
      const label = option.options.find(choice => choice.id === value)?.label ?? value
      return `${option.label}: ${label}`
    })
    .join(' · ')
  const choiceSummary = [
    fallbackEffort ? effortLabel : null,
    configOptions.length > 0 ? configSummary : fallbackEffort ? null : effortLabel,
  ]
  let triggerLabel = modelName
  if (props.connections.length === 0) triggerLabel = 'No agent detected'
  else if (!selectedConnection) triggerLabel = 'Choose an agent'
  const triggerTitle = selectedConnection
    ? [selectedConnection.label, modelName, ...choiceSummary].filter(Boolean).join(' · ')
    : triggerLabel

  return (
    <Popover
      open={open}
      onOpenChange={value => {
        if (value) setInitialQuery('')
        setOpen(value)
      }}
      onOpenChangeComplete={isOpen => {
        if (isOpen && openTarget.current === 'effort') focusEffort(popupRef.current)
        openTarget.current = null
      }}
    >
      <PopoverTrigger
        aria-label="Agent and model"
        title={triggerTitle}
        disabled={props.connections.length === 0}
        className={composerControlClass('max-w-64 min-w-0 shrink justify-start')}
      >
        {selectedConnection && <HarnessIcon kind={selectedConnection.harnessKind} className="size-4 shrink-0" />}
        <span className="min-w-0 truncate">{triggerLabel}</span>
        {configOptions.length > 0 ? (
          <>
            {fallbackEffort && effortLabel && (
              <span className="text-muted-foreground max-w-20 shrink-0 truncate font-normal">{effortLabel}</span>
            )}
            {configSummary && (
              <span className="text-muted-foreground max-w-40 shrink-0 truncate font-normal">{configSummary}</span>
            )}
          </>
        ) : effortLabel ? (
          <span className="text-muted-foreground max-w-24 shrink-0 truncate font-normal">{effortLabel}</span>
        ) : null}
        {activeCatalog.pending && (
          <LoaderCircle aria-hidden className={cn('text-muted-foreground size-3 shrink-0 animate-spin')} />
        )}
      </PopoverTrigger>
      <PopoverContent
        ref={popupRef}
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={searchRef}
        className="w-[556px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0"
        aria-label="Choose agent and model"
      >
        <ModelPickerPanel
          initialQuery={initialQuery}
          connections={props.connections}
          activeConnectionId={connectionId}
          activeCatalog={activeCatalog}
          activeChoice={resolved}
          sessionModels={props.sessionModels}
          lockedConnectionId={props.lockedConnectionId}
          rememberedFor={remembered.choiceFor}
          onCommit={commit}
          onClose={() => setOpen(false)}
          searchRef={searchRef}
          effortColumn={
            configOptions.length > 0 ? (
              <ConfigOptionsColumn
                options={configOptions}
                values={props.configValues ?? {}}
                effort={fallbackEffort}
                onPick={chooseConfigValue}
                onLeave={() => searchRef.current?.focus()}
              />
            ) : (
              <EffortColumn
                title={effortTitle}
                modelLabel={modelName}
                options={effortOptions}
                value={resolved.modeId}
                onPick={chooseEffort}
                onLeave={() => searchRef.current?.focus()}
              />
            )
          }
          footer={props.access ? <PermissionsFooter {...props.access} /> : undefined}
        />
      </PopoverContent>
    </Popover>
  )
}
