import type { WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

import { configOptionsForModel, configValuesForOptions, needsNativeChoiceControl } from '../config-values.js'
import { type CatalogView, connectionEffort, effortFor, effortTitleFor, knownModels } from './catalog.js'
import { ConfigOptionsColumn } from './config-options-column.js'
import { EffortColumn } from './effort-column.js'

export function PreviewOptionsColumn({
  view,
  inspection,
  modelId,
  modeId,
  configValues,
  onModeChange,
  onConfigValueChange,
  onLeave,
}: {
  readonly view: CatalogView
  readonly inspection: WorkspaceConnectionInspection | null
  readonly modelId: string
  readonly modeId: string
  readonly configValues: Readonly<Record<string, string>>
  readonly onModeChange: (modeId: string) => void
  readonly onConfigValueChange: (id: string, value: string) => void
  readonly onLeave: () => void
}): React.JSX.Element {
  const models = knownModels(view)
  const connectionModes = connectionEffort(inspection)
  const effortOptions = effortFor({ models, connectionEffort: connectionModes, modelId })
  const model = models?.find(candidate => candidate.id === modelId)
  const modelLabel = model?.label ?? (modelId || 'Default model')
  const effortTitle = effortTitleFor(effortOptions)
  const configOptions = configOptionsForModel(inspection?.capabilities.configOptions ?? [], model)
  const validConfigValues = configValuesForOptions(configOptions, configValues)

  if (configOptions.length > 0) {
    return (
      <ConfigOptionsColumn
        options={configOptions}
        values={validConfigValues}
        effort={
          effortOptions?.length && needsNativeChoiceControl(effortTitle, configOptions)
            ? { title: effortTitle, modelLabel, options: effortOptions, value: modeId, onPick: onModeChange }
            : undefined
        }
        onPick={onConfigValueChange}
        onLeave={onLeave}
      />
    )
  }

  return (
    <EffortColumn
      title={effortTitle}
      modelLabel={modelLabel}
      options={effortOptions}
      value={modeId}
      onPick={onModeChange}
      onLeave={onLeave}
    />
  )
}
