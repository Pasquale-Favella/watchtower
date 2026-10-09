import { useMemo, useState } from 'react'

import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Input } from '@/shared/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip'
import { HarnessIcon } from './harness-icon'
import { HarnessSetup } from './harness-setup'
import { HarnessStatusDot, harnessTooltip } from './harness-status'
import { harnessBadge } from './lib'
import type { CoachHarnessRow, CoachModelInfo } from '../../../../shared/schemas/agents.js'
import type { CoachKindCache } from './store'

/** One selectable model row: the agent-declared model, plus a synthetic
 *  "default" row (value null) that resets the pick to the agent's own choice. */
type ModelOption = {
  id: string
  value: string | null
  label: string
  description?: string | null
}

/** The harness whose models the list currently shows — the rail preview
 *  target. Starts on the active harness every time the picker opens. */
function modelsForKind(
  kind: string | null,
  harnessKind: string | null,
  sessionModels: CoachModelInfo[],
  modelsByKind: Record<string, CoachKindCache>,
): CoachModelInfo[] {
  if (!kind) return []
  if (kind === harnessKind) {
    // The live set wins for the active harness; the cache is the fallback so
    // the list never blanks while a fresh probe is in flight.
    if (sessionModels.length > 0) return sessionModels
    return modelsByKind[kind]?.models?.availableModels ?? []
  }
  return modelsByKind[kind]?.models?.availableModels ?? []
}

/** The check mark target for a rail harness: the live pick for the active
 *  harness, the remembered pick for a cached one. */
function checkedModelForKind(
  kind: string,
  harnessKind: string | null,
  modelId: string | null,
  modelsByKind: Record<string, CoachKindCache>,
): string | null {
  if (kind === harnessKind) return modelId
  return modelsByKind[kind]?.modelId ?? null
}

/** The unified harness + model picker follows this app's Coach & Skills
 *  rules: ONE trigger (harness
 *  badge + model label) opens a popover with a harness rail on the left and
 *  a searchable agent-declared model list on the right. Browsing the rail
 *  only previews; clicking a model row commits harness + model atomically
 *  via `onInstanceModelChange` (the parent still gates mid-conversation
 *  harness switches behind its confirmation dialog).
 *
 *  Selection stays PROGRESSIVE (ADR 0018): only the agent's own
 *  handshake-declared models are offered, plus the "Model: default" row
 *  (value null). Probing stays LAZY + cached per harness kind: focusing a
 *  rail item fires `onInspect` (the store's probe, guarded against
 *  re-spawns), and `inspectingKind` drives the loading row. The lists are a
 *  handful of agent-declared models, so filtering is a plain substring
 *  match. Built on the app's shared Popover/Input/Button, the same
 *  primitives as the rest of the composer. */
export function HarnessModelPicker({
  harnesses,
  harnessKind,
  modelId,
  sessionModels,
  modelsByKind,
  inspectingKind,
  onInspect,
  onInstanceModelChange,
  disabled = false,
}: {
  harnesses: CoachHarnessRow[]
  harnessKind: string | null
  modelId: string | null
  sessionModels: CoachModelInfo[]
  modelsByKind: Record<string, CoachKindCache>
  inspectingKind: string | null
  /** Fired when a rail harness needs its agent-declared set (lazy probe). */
  onInspect: (kind: string) => void
  /** Commits a model row click: the previewed harness + the picked model. */
  onInstanceModelChange: (kind: string, modelId: string | null) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draftKind, setDraftKind] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const activeHarness = harnesses.find(h => h.instanceId === harnessKind) ?? null
  const previewKind = draftKind ?? harnessKind
  const previewHarness = harnesses.find(h => h.instanceId === previewKind) ?? null
  const previewModels = modelsForKind(previewKind, harnessKind, sessionModels, modelsByKind)
  const loading = !!previewKind && inspectingKind === previewKind && previewModels.length === 0

  const activeModelName = useMemo(() => {
    const live =
      harnessKind === null
        ? []
        : sessionModels.length > 0
          ? sessionModels
          : (modelsByKind[harnessKind]?.models?.availableModels ?? [])
    return live.find(m => m.modelId === modelId)?.name ?? null
  }, [harnessKind, modelId, modelsByKind, sessionModels])

  const triggerLabel = activeHarness
    ? `${activeHarness.displayName} · ${activeModelName ?? 'default'}`
    : harnesses.length === 0
      ? 'No harness detected'
      : 'Pick a harness'
  const activeBadge = activeHarness ? harnessBadge(activeHarness) : null

  const options = useMemo<ModelOption[]>(
    () => [
      { id: 'default', value: null, label: 'Model: default', description: 'Let the agent choose' },
      ...previewModels.map(model => ({
        id: model.modelId,
        value: model.modelId,
        label: model.name,
        description: model.description,
      })),
    ],
    [previewModels],
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter(
      option =>
        option.label.toLowerCase().includes(needle) || (option.description ?? '').toLowerCase().includes(needle),
    )
  }, [options, query])

  const checkedValue = previewKind ? checkedModelForKind(previewKind, harnessKind, modelId, modelsByKind) : null

  const handleOpenChange = (next: boolean): void => {
    if (disabled) return
    setOpen(next)
    if (next) {
      // Every open restarts the preview on the active harness with a clean
      // query; opening also warms the active harness's probe (the same warm
      // start the old standalone model picker had).
      setDraftKind(harnessKind)
      setQuery('')
      if (harnessKind && activeHarness?.status !== 'error') onInspect(harnessKind)
    } else {
      setDraftKind(null)
    }
  }

  const previewRail = (kind: string): void => {
    setDraftKind(kind)
    setQuery('')
    if (harnesses.find(harness => harness.instanceId === kind)?.status !== 'error') onInspect(kind)
  }

  const commit = (kind: string, value: string | null): void => {
    onInstanceModelChange(kind, value)
    setOpen(false)
    setDraftKind(null)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Harness and model"
            title={triggerLabel}
            disabled={disabled || harnesses.length === 0}
            className="border-border h-7 max-w-56 min-w-0 gap-1.5 pr-1.5 text-[11.5px] font-normal"
          >
            {activeHarness && <HarnessIcon kind={activeHarness.kind} className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
            {activeBadge && (
              <Badge variant="secondary" className="shrink-0 px-1 text-[9px] font-medium">
                {activeBadge}
              </Badge>
            )}
            <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
          </Button>
        }
      />
      <PopoverContent className="w-[380px] p-0" align="start" side="top" sideOffset={8}>
        <div className="flex h-[320px] overflow-hidden">
          {/* Harness rail: one icon per detected
              harness; browsing previews its models, committing happens only
              through a model-row click. */}
          <div className="bg-muted/30 w-11 shrink-0 overflow-y-auto p-1">
            <div className="relative flex min-h-full flex-col gap-1">
              {harnesses.map(harness => {
                const selected = previewKind === harness.instanceId
                const tooltip = harnessTooltip(harness)
                return (
                  <div key={harness.instanceId} className="h-9 w-full shrink-0">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-lg"
                            aria-label={tooltip}
                            onClick={() => previewRail(harness.instanceId)}
                            className={cn(
                              'text-muted-foreground hover:bg-primary/10 hover:text-foreground focus-visible:bg-primary/10 relative isolate w-full rounded-md',
                              selected && 'bg-primary/15 text-primary hover:bg-primary/20',
                            )}
                          >
                            <HarnessIcon kind={harness.kind} className="size-5" />
                            <HarnessStatusDot status={harness.status} className="absolute top-0.5 right-0.5" />
                          </Button>
                        }
                      />
                      <TooltipContent side="right" sideOffset={8} className="max-w-64">
                        {tooltip}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Model list: search header + agent-declared rows for the
              previewed harness. */}
          <div className="bg-muted/40 flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="px-2 pt-2">
              <div className="border-border/70 focus-within:border-ring border-b pb-2.5 transition-colors">
                <Input
                  aria-label="Search models"
                  placeholder="Search models…"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      setOpen(false)
                    }
                    event.stopPropagation()
                  }}
                  autoFocus
                  className="h-7 rounded-none border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0 dark:bg-transparent"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {previewHarness?.status === 'error' ? (
                <div className="flex flex-col gap-2 p-2">
                  <div className="text-muted-foreground flex items-center gap-1.5 text-[12px] font-medium">
                    <HarnessStatusDot status="error" />
                    Unavailable
                  </div>
                  <HarnessSetup row={previewHarness} compact />
                </div>
              ) : (
                <>
                  {previewHarness?.status === 'warning' && <HarnessSetup row={previewHarness} compact />}
                  {loading ? (
                    <p className="text-muted-foreground flex items-center justify-center gap-1.5 py-6 text-[12px]">
                      <Loader2 className="size-3.5 animate-spin" />
                      Loading models…
                    </p>
                  ) : filtered.length === 0 ? (
                    <p className="text-muted-foreground py-6 text-center text-[12px]">
                      {query.trim() ? 'No matching models' : 'No models available'}
                    </p>
                  ) : (
                    filtered.map(option => {
                      const checked = option.value === checkedValue
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => {
                            if (previewKind) commit(previewKind, option.value)
                          }}
                          className={cn(
                            'hover:bg-accent focus-visible:bg-accent relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors outline-none',
                            checked && 'bg-accent/60',
                          )}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span
                              className={cn(
                                'truncate text-[12px] font-medium',
                                option.value === null && 'text-muted-foreground font-normal',
                              )}
                            >
                              {option.label}
                            </span>
                            {option.description && (
                              <span className="text-muted-foreground truncate text-[9.5px]">{option.description}</span>
                            )}
                          </span>
                          {checked && <Check className="text-primary size-4 shrink-0" />}
                        </button>
                      )
                    })
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
