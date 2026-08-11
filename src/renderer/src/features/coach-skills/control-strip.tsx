import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Separator } from '@/shared/components/ui/separator'
import { SegTabs } from '@/shared/components/SegTabs'
import { formatUsd } from '@/shared/lib/models'
import type { ScopedDataSlice } from '../../app/stores/data-store'
import type { CoachMode } from '../../../../shared/schemas/agents.js'
import type { SkillsPayload } from '../../../../shared/schemas/skills.js'
import { candidateKey, MODE_HINT } from './lib'

/** The control strip — the run configuration bar above the thread. A
 *  elements.ai-sdk.dev ModelSelector-inspired row: mode SegTabs, the harness
 *  picker, the data-context caption (the UI scope the in-app ledger MCP
 *  server exposes — map 53), and — when the ACP handshake declared selectable
 *  models/modes (progressive, map 47 ticket 50) — the model/mode pickers. In
 *  build-skill mode it hosts the candidate picker instead. There is NO
 *  workspace chooser: runs happen in a private temp workspace. */
export function ControlStrip({
  mode,
  setMode,
  harnesses,
  harnessKind,
  setHarness,
  scopeCaption,
  running,
  error,
  sessionModels,
  sessionModes,
  modelId,
  modeId,
  setModelId,
  setModeId,
  detection,
  selectedCandidate,
  setSelectedCandidate,
  onRefreshCandidates,
}: {
  mode: CoachMode
  setMode: (mode: CoachMode) => void
  harnesses: Array<{ kind: string; displayName: string; authStatus: 'configured' | 'unknown' }>
  harnessKind: string | null
  setHarness: (kind: string) => void
  scopeCaption: string
  running: boolean
  error: string | null
  sessionModels: { availableModels: Array<{ modelId: string; name: string }>; currentModelId: string } | null
  sessionModes: { availableModes: Array<{ id: string; name: string }>; currentModeId: string } | null
  modelId: string | null
  modeId: string | null
  setModelId: (id: string | null) => void
  setModeId: (id: string | null) => void
  detection: ScopedDataSlice<SkillsPayload>
  selectedCandidate: string
  setSelectedCandidate: (key: string) => void
  onRefreshCandidates: () => void
}) {
  const drafts = detection.data?.drafts ?? []
  const selectedDraft = drafts.find(d => candidateKey(d) === selectedCandidate) ?? null
  const selectedModel = sessionModels?.availableModels.find(m => m.modelId === modelId) ?? null
  const selectedMode = sessionModes?.availableModes.find(m => m.id === modeId) ?? null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SegTabs
          options={[
            { value: 'coach', label: 'Coach' },
            { value: 'build-skill', label: 'Build skill' },
          ]}
          value={mode}
          onChange={value => setMode(value as CoachMode)}
        />
        <Separator orientation="vertical" className="mx-1 hidden h-4 sm:block" />
        <Select value={harnessKind ?? ''} onValueChange={next => { if (next) setHarness(next) }}>
          <SelectTrigger size="sm" aria-label="Harness" className="h-7 border-border text-[11.5px]">
            <SelectValue>{harnesses.length === 0 ? 'No harness detected' : harnesses.find(h => h.kind === harnessKind)?.displayName ?? 'Pick a harness'}</SelectValue>
          </SelectTrigger>
          <SelectContent align="center">
            {harnesses.length === 0 && <SelectItem value="none" disabled>No harness detected</SelectItem>}
            {harnesses.map(h => (
              <SelectItem key={h.kind} value={h.kind}>
                {h.displayName}
                {h.authStatus === 'configured' ? ' · configured' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge
          variant="outline"
          className="h-7 max-w-[320px] gap-1.5 border-border text-[10.5px] font-normal text-muted-foreground"
          title="The harness reads this data window from your platform ledger through the in-app MCP server; runs happen in a private temp workspace."
        >
          <span className="shrink-0 font-medium text-foreground">Data</span>
          <span className="truncate">{scopeCaption}</span>
        </Badge>

        {/* Progressive model/mode pickers (map 47 ticket 50): only when the
            agent's handshake declared selectable options. */}
        {sessionModels && sessionModels.availableModels.length > 0 && (
          <Select value={modelId ?? ''} onValueChange={next => { if (next) setModelId(next) }}>
            <SelectTrigger size="sm" aria-label="Model" className="h-7 border-border text-[11.5px]" title="Agent-declared model">
              <SelectValue>{selectedModel?.name ?? 'Model: default'}</SelectValue>
            </SelectTrigger>
            <SelectContent align="center">
              {sessionModels.availableModels.map(m => (
                <SelectItem key={m.modelId} value={m.modelId}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {sessionModes && sessionModes.availableModes.length > 0 && (
          <Select value={modeId ?? ''} onValueChange={next => { if (next) setModeId(next) }}>
            <SelectTrigger size="sm" aria-label="Mode" className="h-7 border-border text-[11.5px]" title="Agent-declared mode">
              <SelectValue>{selectedMode?.name ?? 'Mode: default'}</SelectValue>
            </SelectTrigger>
            <SelectContent align="center">
              {sessionModes.availableModes.map(m => (
                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <span className="ml-auto text-[10px] text-muted-foreground">
          {running ? 'running…' : (error ?? `${MODE_HINT[mode]}`)}
        </span>
      </div>

      {/* Build-skill candidate picker: the detection pool in the current scope. */}
      {mode === 'build-skill' && (
        <div className="flex flex-wrap items-center gap-2">
          {detection.status === 'loading' && detection.data === null ? (
            <Skeleton className="h-7 w-56" />
          ) : drafts.length === 0 ? (
            <Badge variant="outline" className="text-[10.5px] font-normal text-muted-foreground">
              No draft skills detected in this scope yet — run a scan or widen the period.
            </Badge>
          ) : (
            <>
              <Select value={selectedCandidate} onValueChange={next => { if (next) setSelectedCandidate(next) }}>
                <SelectTrigger size="sm" aria-label="Candidate" className="h-7 min-w-[220px] max-w-[420px] flex-1 border-border text-[11.5px]">
                  <SelectValue>{selectedDraft ? `${selectedDraft.name} · ×${selectedDraft.frequency} · ${formatUsd(selectedDraft.costUSD)}` : 'Choose a detected pattern…'}</SelectValue>
                </SelectTrigger>
                <SelectContent align="center">
                  {drafts.map(d => (
                    <SelectItem key={candidateKey(d)} value={candidateKey(d)}>
                      {d.name} · ×{d.frequency} · {formatUsd(d.costUSD)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" onClick={onRefreshCandidates} className="h-7 text-[10.5px]">
                Refresh
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
