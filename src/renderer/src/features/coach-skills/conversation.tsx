import { useRef, useState } from 'react'

import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/components/ui/alert-dialog'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip'
import { InfoTip } from '@/shared/components/InfoTip'
import { formatUsd } from '@/shared/lib/models'
import { useCoachSkillsStore } from '@/features/coach-skills/store'
import { useSettingsStore } from '@/features/settings/store'
import { candidateKey, craftSkillPrompt } from '@/features/coach-skills/lib'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'
import { HarnessModelPicker } from './harness-model-picker'
import { Thread } from './thread'

/** Claude sign-in hint + API-key passthrough toggle, shown as a floating pill
 *  above the composer, almost as wide as the textarea card (slightly inset
 *  on both sides so it still reads as a floating element) and slightly
 *  tucked behind it (the card overlaps its bottom edge), only while Claude
 *  Code is the selected harness. Setup/re-check for every harness lives in
 *  the model picker; this pill only carries the passthrough toggle (an
 *  env-key sign-in is invisible to the CLI's login probe). Off by default
 *  (ADR 0012). */
function ClaudeAuthHint() {
  const harnessKind = useCoachSkillsStore(s => s.harnessKind)
  const active = useCoachSkillsStore(s => s.harnesses.find(h => h.instanceId === harnessKind))
  const allowApiKeyEnv = useSettingsStore(s => s.allowHarnessApiKeyEnv)
  const setAllowHarnessApiKeyEnv = useSettingsStore(s => s.setAllowHarnessApiKeyEnv)
  if (active?.kind !== 'claude') return null
  const signedOut = active.auth.status !== 'configured'
  const infoText = allowApiKeyEnv
    ? 'Passthrough is On: Coach runs inherit ANTHROPIC_API_KEY from the app environment instead of Claude Code’s stored login. Make sure you launched the app from a terminal where ANTHROPIC_API_KEY is set, or runs will fail authentication.'
    : 'Passthrough is Off: Coach runs use Claude Code’s stored login. Make sure sign-in is detected — otherwise run `claude auth login` in a terminal and retry. Turn passthrough On only if you sign in via ANTHROPIC_API_KEY in your terminal.'
  const promptText = signedOut
    ? 'Or, if you sign in with ANTHROPIC_API_KEY in your terminal:'
    : 'On an API key instead of stored login?'
  const toggleLabel = `API-key passthrough: ${allowApiKeyEnv ? 'On' : 'Off'}`
  const togglePassthrough = (): void => {
    setAllowHarnessApiKeyEnv(!allowApiKeyEnv)
  }
  // Pill radius follows the golden ratio from the card's rounded-xl (12px):
  // 12 × φ ≈ 19px on the top corners only (the bottom edge hides behind
  // the card). -mb-2 pulls the card up over the pill's bottom edge; pb-3
  // compensates so the visible padding stays balanced (top pt-1 == visible
  // bottom).
  return (
    <div className="-mb-2 px-5">
      <div className="flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-t-[19px] border border-border bg-card px-4 pb-3 pt-1 text-center text-[11px] leading-relaxed text-muted-foreground shadow-sm">
        <InfoTip label="How Claude authentication works" text={infoText} />
        {signedOut && (
          <span>
            Claude Code sign-in not detected — run{' '}
            <code className="rounded bg-muted px-1 font-mono text-[10.5px]">claude auth login</code>{' '}
            in a terminal, then retry.
          </span>
        )}
        <span>{promptText}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={togglePassthrough}
          title="When on, Coach runs inherit API keys (e.g. ANTHROPIC_API_KEY) from the app's environment instead of using each harness's stored login. The key itself is never stored by the app."
          className="h-6 px-1.5 text-[11px] font-medium text-primary hover:text-primary"
        >
          {toggleLabel}
        </Button>
      </div>
    </div>
  )
}

/** Sample coach prompts shown on the courtesy screen — each starts a normal
 *  coach run, so they work exactly like typing the prompt. The skill-crafting
 *  examples are ordinary sentences: skills are authored conversationally by
 *  asking the harness directly, not via a separate detected-pattern flow. */
const SAMPLE_PROMPTS = [
  'Where am I wasting tokens?',
  'Summarise my last 30 days of work',
  'Craft a SKILL.md for my most common git workflow',
  'What patterns should I turn into skills?',
]

/** Clickable chips for the detected patterns in scope — the suggested-skill
 *  surface on the courtesy screen. Each chip is a CHAT-STARTER: clicking it
 *  sends a normal coach prompt (craftSkillPrompt) that asks the harness to
 *  author a SKILL.md for that pattern — no build-skill mode, no mid-thread
 *  draft card. The run is part of the conversation, and the ledger briefing
 *  lets the harness ground the draft in real usage (ledger_skills /
 *  ledger_calls). A hover tooltip shows the evidence. */
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
      <p className="text-[12px] text-muted-foreground">
        No patterns detected in this window yet — ask the coach and it can discover them through its ledger tools.
      </p>
    )
  }
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {drafts.slice(0, 8).map(draft => (
        <Tooltip key={candidateKey(draft)}>
          <TooltipTrigger
            render={
              <button
                type="button"
                disabled={disabled}
                onClick={() => onCraft(draft)}
                className="group flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-[12px] text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-foreground hover:shadow-sm disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="font-medium text-foreground">{draft.name}</span>
                <span className="tabular-nums">×{draft.frequency}</span>
                <span className="hidden text-[10.5px] sm:inline">{formatUsd(draft.costUSD)}</span>
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
              <span className="mt-0.5 text-[10px] font-medium text-primary">Click to craft a SKILL.md for this pattern</span>
            </div>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/** The courtesy empty state — fills the whole chat surface before the first
 *  message: a centered welcome (title, hint, sample prompts), the
 *  suggested-skill chips, and the no-harness note. No card of its own: the
 *  page IS the surface. */
export function ConversationWelcome({ onCraft, onSend, canSend }: {
  onCraft: (draft: SkillCandidate) => void
  onSend: (text: string) => void
  canSend: boolean
}) {
  const hydrated = useCoachSkillsStore(s => s.hydrated)
  const harnessCount = useCoachSkillsStore(s => s.harnesses.length)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-6 py-12">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="text-[20px] font-semibold tracking-tight text-foreground">Coach & Skills</span>
        <p className="max-w-lg text-[13px] leading-[1.7] text-muted-foreground">
          Ask the harness for guidance on your workflow — or craft a skill together, just by talking: describe
          what you do and ask it to write a SKILL.md. Every run reads your platform data live through the in-app
          ledger, so answers are grounded in your real usage.
        </p>
      </div>

      <div className="flex max-w-2xl flex-wrap items-center justify-center gap-2">
        {SAMPLE_PROMPTS.map(prompt => (
          <button
            key={prompt}
            type="button"
            disabled={!canSend}
            onClick={() => onSend(prompt)}
            className="rounded-full border border-border bg-card px-4 py-2 text-[12px] text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-foreground hover:shadow-sm disabled:pointer-events-none disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>

      <div className="w-full max-w-2xl pt-2">
        <p className="mb-3 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Craft a skill from a detected pattern
        </p>
        <PatternChips onCraft={onCraft} disabled={!canSend} />
      </div>

      {hydrated && harnessCount === 0 && (
        <p className="text-[12px] text-muted-foreground">
          No coding-agent harness detected — install Claude Code, OpenCode or Codex to get started.
        </p>
      )}
    </div>
  )
}

/** The scrollable conversation — thread only, no card chrome: the page is the
 *  surface, and the bubbles float on it. The prompt bar lives separately
 *  (ConversationComposer) so the same input stays pinned below both the empty
 *  state and an active conversation. The thread is a shadcn
 *  MessageScroller (height-constrained; the scroller fills the flex-1 slot). */
export function ConversationThread() {
  const messages = useCoachSkillsStore(s => s.messages)

  return (
    <div className="min-h-0 flex-1">
      <Thread messages={messages} />
    </div>
  )
}

/** The prompt bar — an elements.ai-sdk.dev PromptInput-inspired input that
 *  stays pinned at the bottom of the chat surface: an auto-growing textarea up
 *  top, a footer with the unified harness + model picker (t3code
 *  ProviderModelPicker shape: one trigger, harness rail + searchable
 *  agent-declared model list), the agent-declared mode picker, and a round
 *  send/stop action pinned to the end of the footer.
 *  The coach reads the full lifetime ledger (no data-window chip — the agent
 *  filters per question). */
export function ConversationComposer({ running, canSend, onSend, onStop }: {
  running: boolean
  canSend: boolean
  onSend: (text: string) => void
  onStop: () => void
}) {
  const harnesses = useCoachSkillsStore(s => s.harnesses)
  const harnessKind = useCoachSkillsStore(s => s.harnessKind)
  const setHarness = useCoachSkillsStore(s => s.setHarness)
  const resetSession = useCoachSkillsStore(s => s.resetSession)
  const hasConversation = useCoachSkillsStore(s => s.messages.length > 0)
  const inspectHarness = useCoachSkillsStore(s => s.inspectHarness)
  const sessionModels = useCoachSkillsStore(s => s.sessionModels)
  const sessionModes = useCoachSkillsStore(s => s.sessionModes)
  const modelsByKind = useCoachSkillsStore(s => s.modelsByKind)
  const inspectingKind = useCoachSkillsStore(s => s.inspectingKind)
  const modelId = useCoachSkillsStore(s => s.modelId)
  const modeId = useCoachSkillsStore(s => s.modeId)
  const setModelId = useCoachSkillsStore(s => s.setModelId)
  const setModeId = useCoachSkillsStore(s => s.setModeId)

  const [prompt, setPrompt] = useState('')
  const [pendingSwitch, setPendingSwitch] = useState<{ kind: string; modelId: string | null } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const selectedMode = sessionModes?.availableModes.find(m => m.id === modeId) ?? null

  /** A harness switch in the middle of a conversation would strand the thread
   *  (the resume handle belongs to the OLD harness's session) — gate it behind
   *  a confirmation that starts a NEW conversation on confirm. A model-only
   *  pick on the CURRENT harness goes straight through. On the welcome screen
   *  (no messages yet) any switch is harmless and goes straight through. */
  const onInstanceModelChange = (nextKind: string, nextModelId: string | null): void => {
    if (nextKind === harnessKind) {
      setModelId(nextModelId)
      return
    }
    if (hasConversation) {
      setPendingSwitch({ kind: nextKind, modelId: nextModelId })
      return
    }
    // `setHarness` restores the target harness's cached set + picks (or
    // clears and probes eagerly when uncached); the explicit model row pick
    // then wins over the restored value — including null (agent default).
    // For an uncached harness only the default row is clickable yet, and the
    // pick survives the probe via the store's live-pick-wins rule.
    setHarness(nextKind)
    setModelId(nextModelId)
  }

  /** The confirm path of the switch dialog: pick the new harness first —
   *  `setHarness` snapshots the OUTGOING harness's live model/mode picks
   *  against its cached set (a reset would clobber them back to cached values
   *  first), so switching back later restores what the user actually chose —
   *  then apply the picked model row and reset the conversation. No explicit
   *  cancel() is needed: `resetSession` stops any in-flight run main-side
   *  (coach:reset cancels all active runs, awaits their teardown, then deletes
   *  the old workspace — the Windows EPERM fix) and clears the thread +
   *  resume handle; the new harness's cached models/mode picks restore so the
   *  pickers never go blank. */
  const confirmHarnessSwitch = (): void => {
    if (!pendingSwitch) return
    setHarness(pendingSwitch.kind)
    setModelId(pendingSwitch.modelId)
    resetSession()
    setPendingSwitch(null)
  }

  const pendingName = pendingSwitch
    ? harnesses.find(h => h.instanceId === pendingSwitch.kind)?.displayName ?? pendingSwitch.kind
    : null

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
    <div className="relative z-10 overflow-hidden rounded-xl border border-border bg-card shadow-[var(--card-shadow)] transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
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
        placeholder="Ask anything or say “craft a skill for …”"
        className="max-h-[168px] w-full resize-none overflow-y-auto bg-transparent p-3.5 text-[12px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          {/* The unified harness + model picker (t3code ProviderModelPicker
              shape): one trigger opens the harness rail + searchable
              agent-declared model list. LAZY: opening probes the active
              harness's handshake (which also warms a session the first run
              resumes); browsing the rail probes each previewed harness.
              Results are cached per harness kind, so switching back restores
              the set instantly (no reload, no agent spawn). Committing a
              model row on ANOTHER harness routes through the switch
              confirmation below when a conversation exists. */}
          <HarnessModelPicker
            harnesses={harnesses}
            harnessKind={harnessKind}
            modelId={modelId}
            sessionModels={sessionModels?.availableModels ?? []}
            modelsByKind={modelsByKind}
            inspectingKind={inspectingKind}
            onInspect={kind => { void inspectHarness(kind) }}
            onInstanceModelChange={onInstanceModelChange}
          />
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

        {/* Round send/stop action at the end of the footer: a solid circle
            with an up-arrow sends (muted while the prompt is empty), and the
            same circle swaps to a filled-square stop affordance while a run
            streams. Icon-only, so the state reads from shape + label. */}
        <div className="ml-auto flex items-center">
          {running ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
              className="size-8 rounded-full"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              onClick={submit}
              disabled={!canSend || !prompt.trim()}
              aria-label="Send message"
              title="Send message"
              className="size-8 rounded-full"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {/* AlertDialog confirmation before a mid-conversation harness switch: the
          switch STARTS A NEW CONVERSATION, so the current thread and its
          session would be cleared. Cancel (a Close primitive) keeps the
          current harness untouched; the AlertDialog is not dismissible by
          backdrop/Escape — the user must answer. */}
      <AlertDialog
        open={pendingSwitch !== null}
        onOpenChange={open => { if (!open) setPendingSwitch(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch harness?</AlertDialogTitle>
            <AlertDialogDescription>
              Chatting with <span className="font-medium text-foreground">{pendingName}</span> starts a new
              conversation — the current thread and its session will be cleared.
              {running && ' Any run in progress will be stopped.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmHarnessSwitch}>
              Switch & start new conversation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The Coach conversation view (ADR 0017 + the picked conversation prototype,
 *  map 58). One surface, no Coach/Skills room switch and no separated cards:
 *  the empty state is a centered welcome filling the chat (with sample
 *  prompts and the suggested-skill chips), an active conversation is a slim
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
  const cancel = useCoachSkillsStore(s => s.cancel)
  const resetSession = useCoachSkillsStore(s => s.resetSession)

  const start = (seed: string): void => {
    if (!harnessKind || running) return
    void sendCoach(seed)
  }

  // A suggested-skill chip is a CHAT-STARTER: it sends a normal coach run
  // with a natural-language craft prompt — no build-skill mode, no draft
  // card. The answer streams into the thread like any other.
  const craft = (draft: SkillCandidate): void => start(craftSkillPrompt(draft))

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
          {/* Conversation header: same language as the composer controls
              (HarnessModelPicker + Mode: outline, h-7, 11.5px) — a quiet
              bordered action, not a new pill style. The page keeps the
              section title in the TopBar above, so no in-chat label. */}
          <div className="flex justify-end px-0 pb-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetSession}
              className="h-7 gap-1.5 text-[11.5px] font-medium text-foreground"
            >
              New conversation
            </Button>
          </div>
          <ConversationThread />
        </>
      )}

      {/* Pinned prompt bar — always visible, in both states. The Claude auth
          hint (when present) floats centered above it as a pill slightly
          tucked behind the textarea card. */}
      <div>
        <ClaudeAuthHint />
        <ConversationComposer
          running={running}
          canSend={!!harnessKind}
          onSend={text => start(text)}
          onStop={cancel}
        />
      </div>

      {error && <p className="px-0.5 pt-1 text-[10.5px] text-destructive">{error}</p>}
    </div>
  )
}
