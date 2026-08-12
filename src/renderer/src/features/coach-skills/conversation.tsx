import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip'
import { formatUsd } from '@/shared/lib/models'
import { PERIOD_LABELS } from '@/shared/lib/settings-constants'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { useCoachSkillsStore } from '@/features/coach-skills/store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { useScanStore } from '@/app/stores/scan-store'
import { candidateKey } from '@/features/coach-skills/lib'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'
import { Thread } from './thread'

/** The data-window caption the harness reads (map 53): the current UI scope,
 *  phrased as it reads on the control strip ("Last 30 days · claude"). */
export function useScopeCaption(): string {
  const scope = useScopeStore(useShallow(selectScope))
  const detectedProviders = useScanStore(s => s.detectedProviders)
  return useMemo(() => {
    const providerOptions = providerOptionsFromDetected(detectedProviders)
    const periodLabel = PERIOD_LABELS[scope.period] ?? scope.period
    const providerLabel = scope.provider
      ? (providerOptions.find(p => p.value === scope.provider)?.label ?? scope.provider)
      : 'all providers'
    return `${periodLabel} · ${providerLabel}`
  }, [scope, detectedProviders])
}

/** Clickable chips for the detected patterns in scope — the conversational
 *  skill side's "living reference": the user clicks one to START a build-skill
 *  run ("craft a SKILL.md for <name>"). The run is part of the conversation
 *  (resumes the session) and lands a mid-thread draft card from the candidate's
 *  NORMALIZED evidence; the MCP briefing lets the harness pull more grounding
 *  from ledger_skills / ledger_calls. A hover tooltip shows the evidence. */
export function PatternChips({ onCraft }: { onCraft: (draft: SkillCandidate) => void }) {
  const detection = useCoachSkillsStore(s => s.detection)
  const drafts = detection.data?.drafts ?? []

  if (detection.status === 'loading' && detection.data === null) {
    return <Skeleton className="h-6 w-64" />
  }
  if (drafts.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground">
        No patterns detected in this window yet — the agent can discover them itself through its ledger tools.
      </p>
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {drafts.slice(0, 8).map(draft => (
        <Tooltip key={candidateKey(draft)}>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => onCraft(draft)}
                className="group flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
              >
                <span className="font-medium text-foreground">{draft.name}</span>
                <span className="tabular-nums">×{draft.frequency}</span>
                <span className="hidden text-[9px] sm:inline">{formatUsd(draft.costUSD)}</span>
              </button>
            }
          />
          <TooltipContent side="top" align="center" className="max-w-[260px]">
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold">{draft.name}</span>
              <span className="text-[10px] leading-relaxed opacity-80">
                ×{draft.frequency} calls · {draft.spreadSessions} session{draft.spreadSessions === 1 ? '' : 's'} ·{' '}
                {draft.spreadProjects} project{draft.spreadProjects === 1 ? '' : 's'} · {formatUsd(draft.costUSD)} · {draft.turns} turns
              </span>
              <span className="text-[10px] leading-relaxed opacity-80">
                Source: {draft.source} — {draft.sample}
              </span>
              <span className="mt-0.5 text-[10px] font-medium text-primary">Click to draft a SKILL.md for this pattern</span>
            </div>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/** The courtesy empty state — a centered welcome consistent with the rest of
 *  the page's empty thread (title, hint, no-harness note, workspace note).
 *  No card grid: suggestions live under the prompt bar instead. */
export function ConversationWelcome() {
  const harnessKind = useCoachSkillsStore(s => s.harnessKind)
  return (
    <div className="flex h-[300px] flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card px-6 text-center shadow-[var(--card-shadow)]">
      <span className="text-[13px] font-semibold text-foreground">Coach</span>
      <p className="max-w-sm text-[11px] text-muted-foreground">
        Ask the harness for guidance on your workflow — or craft a skill together, step by step. Every run reads your
        platform data live through the in-app ledger, so answers are grounded in your real usage.
      </p>
      {!harnessKind && (
        <p className="text-[10.5px] text-muted-foreground">
          No coding-agent harness detected — install Claude Code, OpenCode or Codex to get started.
        </p>
      )}
      <p className="text-[10.5px] text-muted-foreground">
        Runs happen in a private temp workspace, and the harness reads your platform data live through the in-app
        ledger — no repo picker needed.
      </p>
    </div>
  )
}

/** The scrollable conversation — thread only. The prompt bar lives separately
 *  (ConversationComposer) so the same input stays pinned below both the empty
 *  state and an active conversation, ChatGPT-style. The thread is a shadcn
 *  MessageScroller (height-constrained card; the scroller fills it). */
export function ConversationThread({ saveNotice, onSave }: {
  saveNotice: string | null
  onSave: (path: string | null) => void
}) {
  const messages = useCoachSkillsStore(s => s.messages)

  return (
    <div className="flex max-h-[50vh] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[var(--card-shadow)]">
      <Thread
        messages={messages}
        saveNotice={saveNotice}
        onSave={onSave}
      />
    </div>
  )
}

/** The prompt bar — an elements.ai-sdk.dev PromptInput-inspired card: the
 *  textarea up top, a footer with the provider (harness) picker, the
 *  agent-declared model/mode pickers, the data caption, and Send/Stop. The
 *  detected-pattern pills float UNDER the card — never in a card of their
 *  own. A pill seeds a build-skill run in the conversation. */
export function ConversationComposer({ running, canSend, onSend, onStop, onCraft }: {
  running: boolean
  canSend: boolean
  onSend: (text: string) => void
  onStop: () => void
  onCraft: (draft: SkillCandidate) => void
}) {
  const harnesses = useCoachSkillsStore(s => s.harnesses)
  const harnessKind = useCoachSkillsStore(s => s.harnessKind)
  const setHarness = useCoachSkillsStore(s => s.setHarness)
  const sessionModels = useCoachSkillsStore(s => s.sessionModels)
  const sessionModes = useCoachSkillsStore(s => s.sessionModes)
  const modelId = useCoachSkillsStore(s => s.modelId)
  const modeId = useCoachSkillsStore(s => s.modeId)
  const setModelId = useCoachSkillsStore(s => s.setModelId)
  const setModeId = useCoachSkillsStore(s => s.setModeId)
  const scopeCaption = useScopeCaption()

  const [prompt, setPrompt] = useState('')
  const selectedModel = sessionModels?.availableModels.find(m => m.modelId === modelId) ?? null
  const selectedMode = sessionModes?.availableModes.find(m => m.id === modeId) ?? null

  const submit = (): void => {
    if (!prompt.trim() || running) return
    onSend(prompt)
    setPrompt('')
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* The prompt card: textarea + footer. The ring wraps the CARD on focus
          (focus-within), like the elements.ai-sdk.dev prompt-input examples —
          the textarea itself stays ring-free. */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--card-shadow)] transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <textarea
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          rows={2}
          placeholder="Ask anything — or say “craft a skill for …”"
          className="w-full resize-none bg-transparent p-3.5 text-[12px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Select value={harnessKind ?? ''} onValueChange={next => { if (next) setHarness(next) }}>
            <SelectTrigger size="sm" aria-label="Harness" className="h-7 border-border text-[11.5px]">
              <SelectValue>{harnesses.length === 0 ? 'No harness detected' : harnesses.find(h => h.kind === harnessKind)?.displayName ?? 'Pick a harness'}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              {harnesses.length === 0 && <SelectItem value="none" disabled>No harness detected</SelectItem>}
              {harnesses.map(h => (
                <SelectItem key={h.kind} value={h.kind}>
                  {h.displayName}
                  {h.authStatus === 'configured' ? ' · configured' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {sessionModels && sessionModels.availableModels.length > 0 && (
            <Select value={modelId ?? ''} onValueChange={next => { if (next) setModelId(next) }}>
              <SelectTrigger size="sm" aria-label="Model" className="h-7 border-border text-[11.5px]" title="Agent-declared model">
                <SelectValue>{selectedModel?.name ?? 'Model: default'}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
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
              <SelectContent align="start">
                {sessionModes.availableModes.map(m => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Badge
            variant="outline"
            className="h-7 max-w-[260px] gap-1.5 border-border text-[10.5px] font-normal text-muted-foreground"
            title="The harness reads this data window from your platform ledger through the in-app MCP server; runs happen in a private temp workspace."
          >
            <span className="shrink-0 font-medium text-foreground">Data</span>
            <span className="truncate">{scopeCaption}</span>
          </Badge>

          <div className="ml-auto flex items-center gap-2">
            {running ? (
              <Button type="button" variant="outline" onClick={onStop} className="h-8 shrink-0 text-[12px]">
                Stop
              </Button>
            ) : (
              <Button type="button" onClick={submit} disabled={!canSend || !prompt.trim()} className="h-8 shrink-0 text-[12px] font-medium">
                Send
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Pills float under the card, not in a card. */}
      <div className="flex flex-wrap items-center gap-1.5 px-1">
        <span className="text-[10px] font-medium text-muted-foreground">Craft a skill:</span>
        <PatternChips onCraft={onCraft} />
      </div>
    </div>
  )
}

/** The Coach conversation view (ADR 0017 + the picked conversation prototype,
 *  map 58). One surface, no Coach/Skills room switch: the empty state is a
 *  centered welcome, the prompt bar holds the provider (harness) +
 *  agent-declared model/mode pickers in its footer, detected patterns are
 *  chips floating UNDER the prompt card (each seeds a build-skill run that
 *  lands a mid-thread draft card), and a "New conversation" button resets the
 *  session. Runs read the current UI scope live through the in-app ledger MCP
 *  server. */
export function ConversationView() {
  const harnessKind = useCoachSkillsStore(s => s.harnessKind)
  const messages = useCoachSkillsStore(s => s.messages)
  const running = useCoachSkillsStore(s => s.running)
  const error = useCoachSkillsStore(s => s.error)
  const sendCoach = useCoachSkillsStore(s => s.sendCoach)
  const sendBuildSkill = useCoachSkillsStore(s => s.sendBuildSkill)
  const cancel = useCoachSkillsStore(s => s.cancel)
  const resetSession = useCoachSkillsStore(s => s.resetSession)

  const [saveNotice, setSaveNotice] = useState<string | null>(null)

  const start = (seed: string): void => {
    if (!harnessKind || running) return
    setSaveNotice(null)
    void sendCoach(seed)
  }

  const craft = (draft: SkillCandidate): void => {
    if (!harnessKind || running) return
    setSaveNotice(null)
    void sendBuildSkill(draft)
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.length === 0 ? (
        <ConversationWelcome />
      ) : (
        <ConversationThread saveNotice={saveNotice} onSave={setSaveNotice} />
      )}

      {/* Pinned prompt bar — provider/model pickers + chips under the card. */}
      <ConversationComposer
        running={running}
        canSend={!!harnessKind}
        onSend={text => start(text)}
        onStop={cancel}
        onCraft={draft => craft(draft)}
      />

      {/* Session controls. */}
      {messages.length > 0 && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="xs" onClick={resetSession} className="text-[10.5px] text-muted-foreground">
            New conversation
          </Button>
        </div>
      )}

      {error && <p className="px-1 text-[10.5px] text-destructive">{error}</p>}
    </div>
  )
}
