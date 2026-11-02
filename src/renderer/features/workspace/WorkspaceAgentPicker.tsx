import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { type Ref, useImperativeHandle, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/renderer/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover'
import { HarnessIcon } from '@/renderer/features/coach-skills/harness-icon.js'
import type { WorkspaceConnection, WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

type Props = {
  readonly controlRef?: Ref<{ open: () => void }>
  readonly connections: readonly WorkspaceConnection[]
  readonly connectionId: string
  readonly modelId: string
  readonly modeId: string
  readonly inspection: WorkspaceConnectionInspection | null
  readonly pending: boolean
  readonly onConnectionChange: (id: string) => void
  readonly onModelChange: (id: string) => void
  readonly onModeChange: (id: string) => void
}

/** Uses the workspace's inspected facts, with the same compact controls as Coach & Skills. */
export function WorkspaceAgentPicker(props: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  useImperativeHandle(props.controlRef, () => ({ open: () => setOpen(true) }), [])
  const selected = props.connections.find(connection => connection.connectionId === props.connectionId)
  const models = props.inspection?.capabilities.models.items ?? []
  const modes =
    models.find(model => model.id === props.modelId)?.modes ?? props.inspection?.capabilities.modes.items ?? []
  const modelLabel =
    models.find(model => model.id === props.modelId)?.label ?? (props.modelId || selected?.label || 'Choose an agent')
  let catalogLabel = 'This agent has not reported a model list.'
  if (props.pending) catalogLabel = 'Checking connection…'
  else if (models.length) catalogLabel = 'Agent-reported models'
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 max-w-64 gap-1.5 text-[11.5px]"
              aria-label="Agent and model"
            />
          }
        >
          {selected && <HarnessIcon kind={selected.harnessKind} className="size-3.5 shrink-0" />}
          <span className="truncate">{modelLabel}</span>
          {props.pending ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <ChevronDown className="size-3 opacity-50" />
          )}
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-[min(420px,calc(100vw-2rem))] gap-0 overflow-hidden p-0"
          aria-label="Choose agent and model"
        >
          <div className="flex min-h-52">
            <div className="flex w-32 shrink-0 flex-col gap-1 border-r p-2" aria-label="Harness connections">
              {props.connections.map(connection => (
                <button
                  key={connection.connectionId}
                  type="button"
                  aria-pressed={connection.connectionId === props.connectionId}
                  className={`flex items-center gap-2 rounded-md px-2 py-2 text-left text-xs ${connection.connectionId === props.connectionId ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
                  onClick={() => props.onConnectionChange(connection.connectionId)}
                >
                  <HarnessIcon kind={connection.harnessKind} className="size-4 shrink-0" />
                  <span className="truncate">{connection.label}</span>
                </button>
              ))}
              {!props.connections.length && (
                <p className="text-muted-foreground p-1 text-xs">No installed agents found.</p>
              )}
            </div>
            <Command className="min-w-0 flex-1 rounded-none!">
              <CommandInput placeholder="Search models…" aria-label="Search models" />
              <CommandList className="max-h-64">
                <CommandEmpty>No matching models.</CommandEmpty>
                <CommandItem
                  value="driver default"
                  disabled={!selected}
                  onSelect={() => {
                    props.onModelChange('')
                    setOpen(false)
                  }}
                >
                  <Check className={`size-3.5 ${props.modelId ? 'opacity-0' : ''}`} />
                  <span>Agent default</span>
                </CommandItem>
                {models.map(model => (
                  <CommandItem
                    key={model.id}
                    value={`${model.label} ${model.id}`}
                    onSelect={() => {
                      props.onModelChange(model.id)
                      setOpen(false)
                    }}
                  >
                    <Check className={`size-3.5 ${props.modelId === model.id ? '' : 'opacity-0'}`} />
                    <span className="truncate">{model.label}</span>
                  </CommandItem>
                ))}
              </CommandList>
              <p className="text-muted-foreground mt-auto border-t px-3 py-2 text-[10px]" role="status">
                {catalogLabel}
              </p>
            </Command>
          </div>
        </PopoverContent>
      </Popover>
      {modes.length > 0 && (
        <label className="text-muted-foreground flex min-w-0 items-center text-[11.5px]">
          <span className="sr-only">Effort / mode</span>
          <select
            aria-label="Effort / mode"
            className="bg-card h-7 max-w-40 rounded-md border px-2 text-[11.5px]"
            value={props.modeId}
            onChange={event => props.onModeChange(event.target.value)}
          >
            <option value="">Default effort / mode</option>
            {modes.map(mode => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  )
}
