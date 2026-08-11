import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { Panel } from '@/shared/components/Panel'
import { SegTabs } from '@/shared/components/SegTabs'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { PERIOD_LABELS } from '@/shared/lib/settings-constants'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Button } from '@/shared/components/ui/button'
import { useCoachSkillsStore } from '@/features/coach-skills/store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { useScanStore } from '@/app/stores/scan-store'
import type { CoachMode } from '../../../../shared/schemas/agents.js'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'
import { candidateKey } from './lib'
import { ControlStrip } from './control-strip'
import { Composer } from './composer'
import { EmptyThread, Thread } from './thread'

/** The unified Coach & Skills section (ADR 0017, component split by map 47
 *  ticket 52): a chat surface where every harness run is tagged Coach
 *  (free-form guidance) or Build skill (a detected pattern becomes a draft
 *  SKILL.md, shown as an interactive card in the thread with copy / save /
 *  dismiss). No consent gate — the harnesses are the machine's own, and runs
 *  are user-initiated. The view is a thin composition root: the control
 *  strip, thread, and composer live as colocated components (elements.ai-sdk.dev
 *  -inspired), all built on the shared shadcn primitives. */
export function CoachSkillsView(): React.JSX.Element {
  const scope = useScopeStore(useShallow(selectScope))
  const provider = useScopeStore(s => s.provider)
  const setProvider = useScopeStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)

  const harnesses = useCoachSkillsStore(s => s.harnesses)
  const harnessKind = useCoachSkillsStore(s => s.harnessKind)
  const mode = useCoachSkillsStore(s => s.mode)
  const messages = useCoachSkillsStore(s => s.messages)
  const running = useCoachSkillsStore(s => s.running)
  const error = useCoachSkillsStore(s => s.error)
  const detection = useCoachSkillsStore(s => s.detection)
  const sessionModels = useCoachSkillsStore(s => s.sessionModels)
  const sessionModes = useCoachSkillsStore(s => s.sessionModes)
  const modelId = useCoachSkillsStore(s => s.modelId)
  const modeId = useCoachSkillsStore(s => s.modeId)
  const loadHarnesses = useCoachSkillsStore(s => s.loadHarnesses)
  const setHarness = useCoachSkillsStore(s => s.setHarness)
  const setMode = useCoachSkillsStore(s => s.setMode)
  const setModelId = useCoachSkillsStore(s => s.setModelId)
  const setModeId = useCoachSkillsStore(s => s.setModeId)
  const sendCoach = useCoachSkillsStore(s => s.sendCoach)
  const sendBuildSkill = useCoachSkillsStore(s => s.sendBuildSkill)
  const cancel = useCoachSkillsStore(s => s.cancel)
  const resetSession = useCoachSkillsStore(s => s.resetSession)

  const [prompt, setPrompt] = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState<string>('')
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)

  // Hydrate: detection on scope change, harnesses once.
  useEffect(() => {
    void detection.load(scope)
  }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void loadHarnesses()
  }, [loadHarnesses])

  // Keep the thread scrolled to the newest message while streaming.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, running])

  const providerOptions = useMemo(() => providerOptionsFromDetected(detectedProviders), [detectedProviders])
  // The data window the harness sees (map 53): the current UI scope, phrased
  // as a caption on the control strip. Runs read this scope read-only through
  // the in-app ledger MCP server.
  const scopeCaption = useMemo(() => {
    const periodLabel = PERIOD_LABELS[scope.period] ?? scope.period
    const providerLabel = scope.provider
      ? (providerOptions.find(p => p.value === scope.provider)?.label ?? scope.provider)
      : 'all providers'
    return `${periodLabel} · ${providerLabel}`
  }, [scope, providerOptions])
  const drafts = detection.data?.drafts ?? []
  const selectedDraft = drafts.find(d => candidateKey(d) === selectedCandidate) ?? null

  const send = (): void => {
    setSaveNotice(null)
    if (mode === 'coach') {
      const content = prompt
      if (!content.trim()) return
      setPrompt('')
      void sendCoach(content)
    } else {
      if (!selectedDraft) return
      void sendBuildSkill(selectedDraft)
    }
  }

  const canSend = !!harnessKind && !running

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}

      {/* Control strip: harness + data-context caption + mode tag +
          progressive model/mode pickers + build-skill candidate pool. */}
      <Panel>
        <ControlStrip
          mode={mode}
          setMode={setMode}
          harnesses={harnesses}
          harnessKind={harnessKind}
          setHarness={setHarness}
          scopeCaption={scopeCaption}
          running={running}
          error={error}
          sessionModels={sessionModels}
          sessionModes={sessionModes}
          modelId={modelId}
          modeId={modeId}
          setModelId={setModelId}
          setModeId={setModeId}
          detection={detection}
          selectedCandidate={selectedCandidate}
          setSelectedCandidate={setSelectedCandidate}
          onRefreshCandidates={() => void detection.reload()}
        />
      </Panel>

      {/* The thread. */}
      <Panel className="min-h-[300px] flex-1 overflow-hidden">
        {messages.length === 0 ? (
          <div className="h-[300px]">
            <EmptyThread mode={mode} hasHarness={harnesses.length > 0} />
          </div>
        ) : (
          <Thread
            messages={messages}
            saveNotice={saveNotice}
            onSave={setSaveNotice}
            threadEndRef={threadEndRef}
          />
        )}
      </Panel>

      {/* Composer. */}
      <Panel>
        <Composer
          mode={mode}
          prompt={prompt}
          setPrompt={setPrompt}
          running={running}
          canSend={canSend}
          selectedDraft={selectedDraft}
          onSend={send}
          onStop={cancel}
        />
      </Panel>

      {/* Session controls. */}
      {messages.length > 0 && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="xs" onClick={resetSession} className="text-[10.5px] text-muted-foreground">
            New conversation
          </Button>
        </div>
      )}

      {detection.error && <ErrorPanel message={detection.error} />}
    </div>
  )
}
