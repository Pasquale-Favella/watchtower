import { useRef, useState } from 'react'

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
import { useCoachSkillsStore } from '@/features/coach-skills/store'
import { candidateKey } from '@/features/coach-skills/lib'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'
import { ModelSelector } from './model-selector'
import { Thread } from './thread'

/** Sample coach prompts shown on the courtesy screen — each starts a normal
 *  coach run, so they work exactly like typing the prompt. */
const SAMPLE_PROMPTS = [
  'Where am I wasting tokens?',
  'Summarise my last 30 days of work',
  'What patterns should I turn into skills?',
]

/** Clickable chips for the detected patterns in scope — the conversational
 *  skill side's "living reference": the user clicks one to START a build-skill
 *  run ("craft a SKILL.md for <name>"). The run is part of the conversation
 *  (resumes the session) and lands a mid-thread draft card from the candidate's
 *  NORMALIZED evidence; the MCP briefing lets the harness pull more grounding
 *  from ledger_skills / ledger_calls. A hover tooltip shows the evidence. */
export function PatternChips({ onCraft, disabled = false }: {
  onCraft: (draft: SkillCandidate) => void
  disabled?: boolean
}) {
  const detection = useCoachSkillsStore(s => s.detection)
  const drafts = detection.data?.drafts ?? []

  if (detection.status === 'loading' && detection.data === null) {
    return <Skeleton className="h-6 w-64" />
  }
  if (drafts.length === 0) {
    return (
      <p className="text-[10.5px] text-muted-foreground">
        No patterns detected in this window yet — ask the coach and it can discover them through its ledger tools.
      </p>
    )
  }
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      {drafts.slice(0, 8).map(draft => (
        <Tooltip key={candidateKey(draft)}>
          <TooltipTrigger
            render={
              <button
                type="button"
                disabled={disabled}
                onClick={() => onCraft(draft)}
                className="group flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-foreground hover:shadow-sm disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="font-medium text-foreground">{draft.name}</span>
                <span className="tabular-nums">×{draft.frequency}</span>
                <span className="hidden text-[9.5px] sm:inline">{formatUsd(draft.costUSD)}</span>
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

/** The courtesy empty state — fills the whole chat surface before the first
 *  message: a centered welcome (title, hint, sample prompts), the craft-a-skill
 *  chips, and the no-harness note. No card of its own: the page IS the surface. */
export function ConversationWelcome({ onCraft, onSend, canSend }: {
  onCraft: (draft: SkillCandidate) => void
  onSend: (text: string) => void
  canSend: boolean
}) {
  const harnessKind = useCoachSkillsStore(s => s.harnessKind)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="text-[16px] font-semibold tracking-tight text-foreground">Coach</span>
        <p className="max-w-md text-[11.5px] leading-relaxed text-muted-foreground">
          Ask the harness for guidance on your workflow — or craft a skill together, step by step. Every run reads
          your platform data live through the in-app ledger, so answers are grounded in your real usage.
        </p>
      </div>

      <div className="flex max-w-xl flex-wrap items-center justify-center gap-1.5">
        {SAMPLE_PROMPTS.map(prompt => (
          <button
            key={prompt}
            type="button"
            disabled={!canSend}
            onClick={() => onSend(prompt)}
            className="rounded-full border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-foreground hover:shadow-sm disabled:pointer-events-none disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>

      <div className="w-full max-w-xl border-t border-border pt-4">
        <p className="mb-2 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Craft a skill from a detected pattern
        </p>
        <PatternChips onCraft={onCraft} disabled={!canSend} />
      </div>

      {!harnessKind && (
        <p className="text-[10.5px] text-muted-foreground">
          No coding-agent harness detected — install Claude Code, OpenCode or Codex to get started.
        </p>
      )}
    </div>
  )
}

/** The scrollable conversation — thread only, no card chrome: the page is the
 *  surface, and the bubbles float on it. The prompt bar lives separately
 *  (ConversationComposer) so the same input stays pinned below both the empty
 *  state and an active conversation, ChatGPT-style. The thread is a shadcn
 *  MessageScroller (height-constrained; the scroller fills the flex-1 slot). */
export function ConversationThread({ saveNotice, onSave }: {
  saveNotice: string | null
  onSave: (path: string | null) => void
}) {
  const messages = useCoachSkillsStore(s => s.messages)

  return (
    <div className="min-h-0 flex-1">
      <Thread
        messages={messages}
        saveNotice={saveNotice}
        onSave={onSave}
      />
    </div>
  )
}

/** The prompt bar — an elements.ai-sdk.dev PromptInput-inspired input that
 *  stays pinned at the bottom of the chat surface: an auto-growing textarea up
 *  top, a footer with the provider (harness) picker, the agent-declared
 *  model/mode pickers, and Send/Stop. The coach reads the full lifetime
 *  ledger (no data-window chip — the agent filters per question). The
 *  craft-a-skill chips live on the courtesy screen only — once a conversation
 *  starts, the input is the surface. */
export function ConversationComposer({ running, canSend, onSend, onStop }: {
  running: boolean
  canSend: boolean
  onSend: (text: string) => void
  onStop: () => void
}) {
  const harnesses = useCoachSkillsStore(s => s.harnesses)
  const harnessKind = useCoachSkillsStore(s => s.harnessKind)
  const setHarness = useCoachSkillsStore(s => s.setHarness)
  const inspectHarness = useCoachSkillsStore(s => s.inspectHarness)
  const sessionModels = useCoachSkillsStore(s => s.sessionModels)
  const sessionModes = useCoachSkillsStore(s => s.sessionModes)
  const inspectingKind = useCoachSkillsStore(s => s.inspectingKind)
  const modelId = useCoachSkillsStore(s => s.modelId)
  const modeId = useCoachSkillsStore(s => s.modeId)
  const setModelId = useCoachSkillsStore(s => s.setModelId)
  const setModeId = useCoachSkillsStore(s => s.setModeId)

  const [prompt, setPrompt] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const selectedMode = sessionModes?.availableModes.find(m => m.id === modeId) ?? null

  /** Auto-grow the textarea with its content, capped so the input never
   *  swallows the transcript above it. */
  const resize = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }

  const submit = (): void => {
    if (!prompt.trim() || running) return
    onSend(prompt)
    setPrompt('')
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      requestAnimationFrame(() => el.focus())
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[var(--card-shadow)] transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={event => {
          setPrompt(event.target.value)
          resize()
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        rows={1}
        placeholder="Ask anything — or say “craft a skill for …”"
        className="max-h-[168px] w-full resize-none overflow-y-auto bg-transparent p-3.5 text-[12px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
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
          {/* The agent-declared model picker (map 47 ticket 50) — LAZY: the
              trigger always renders once a harness is selected, and opening
              it probes the agent's handshake. Tradeoff: the probe ALSO warms
              a session the first run resumes, so that optimization only
              materializes for users who actually open the picker (a user who
              never does cold-starts the first run, exactly as before the
              probe existed). A run's session event refreshes the set after
              the first message. `loading` is scoped to THIS harness — a
              stale probe for a switched-away harness must not show a spinner
              for the current one. */}
          {harnessKind && (
            <ModelSelector
              models={sessionModels?.availableModels ?? []}
              loading={inspectingKind === harnessKind && !sessionModels}
              value={modelId}
              onSelect={setModelId}
              onOpen={() => { void inspectHarness(harnessKind) }}
            />
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
  )
}

/** The Coach conversation view (ADR 0017 + the picked conversation prototype,
 *  map 58). One surface, no Coach/Skills room switch and no separated cards:
 *  the empty state is a centered welcome filling the chat (with the
 *  craft-a-skill chips and sample prompts), an active conversation is a slim
 *  header over a MessageScroller transcript, and the prompt bar stays PINNED
 *  at the bottom in both states. Runs read the FULL lifetime ledger through
 *  the in-app MCP server; the current UI scope rides the briefing as the
 *  suggested default window for the agent's queries. */
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

  const isEmpty = messages.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isEmpty ? (
        <ConversationWelcome
          canSend={!!harnessKind}
          onCraft={draft => craft(draft)}
          onSend={text => start(text)}
        />
      ) : (
        <>
          {/* Slim conversation header: just the reset action — the page keeps
              the section title in the TopBar above, so no in-chat label. */}
          <div className="flex justify-end px-0.5 pb-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={resetSession} className="text-[10.5px] text-muted-foreground">
              New conversation
            </Button>
          </div>
          <ConversationThread saveNotice={saveNotice} onSave={setSaveNotice} />
        </>
      )}

      {/* Pinned prompt bar — always visible, in both states. */}
      <ConversationComposer
        running={running}
        canSend={!!harnessKind}
        onSend={text => start(text)}
        onStop={cancel}
      />

      {error && <p className="px-0.5 pt-1 text-[10.5px] text-destructive">{error}</p>}
    </div>
  )
}
