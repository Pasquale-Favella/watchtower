import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { cn } from '@/shared/lib/utils'
import { Panel } from '@/shared/components/Panel'
import { SegTabs } from '@/shared/components/SegTabs'
import { motionClass } from '@/shared/lib/motion'
import { providerOptionsFromDetected } from '@/shared/lib/shell'
import { formatUsd } from '@/shared/lib/models'
import { describeCandidate } from '../../../../shared/lib/skills-draft.js'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useCoachSkillsStore, saveDraftCard, type ChatMessage } from '@/features/coach-skills/store'
import { selectScope, useScopeStore } from '@/app/stores/scope-store'
import { useScanStore } from '@/app/stores/scan-store'
import type { CoachMode } from '../../../../shared/schemas/agents.js'
import type { SkillCandidate } from '../../../../shared/schemas/skills.js'

const DISMISS_REASONS = ['not-a-skill', 'one-off', 'too-specific', 'other'] as const

const MODE_LABEL: Record<CoachMode, string> = {
  coach: 'Coach',
  'build-skill': 'Build skill',
}

const MODE_HINT: Record<CoachMode, string> = {
  coach: 'Ask the harness for guidance on your workflow.',
  'build-skill': 'Turn a detected pattern into a SKILL.md draft.',
}

/** One thread message (ADR 0017): a user bubble, a streaming assistant turn
 *  with tool notices, or — when a build-skill run completes — a draft card
 *  with the harness markdown and the review actions. */
function MessageBubble({ message, onSave }: {
  message: ChatMessage
  onSave: (path: string | null) => void
}) {
  const dismiss = useCoachSkillsStore(s => s.dismiss)

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-br-sm border border-border bg-primary/10 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="rounded bg-primary/15 px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-primary">
              {MODE_LABEL[message.mode]}
            </span>
            <span className="text-[11.5px] text-foreground">{message.content}</span>
          </div>
        </div>
      </div>
    )
  }

  // The draft card is the FINISHED result of a build-skill run — while the
  // turn streams, show the live text bubble instead (the card's actions make
  // no sense on a half-written draft).
  const hasDraft = !!message.draft && !message.streaming

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-border bg-card">
        {hasDraft && message.draft ? (
          <DraftCard message={message} onSave={onSave} dismiss={dismiss} />
        ) : (
          <div className="px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="rounded bg-accent px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                {MODE_LABEL[message.mode]}
              </span>
              {message.streaming && <span className="text-[10px] text-muted-foreground">running…</span>}
              {message.error && <span className="text-[10px] text-destructive">{message.error}</span>}
            </div>
            {message.tools.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {message.tools.map((tool, index) => (
                  <span key={`${tool}-${index}`} className="rounded bg-accent px-1.5 py-[1px] font-mono text-[9.5px] text-muted-foreground">
                    {tool}
                  </span>
                ))}
              </div>
            )}
            {message.content ? (
              <p className="mt-1.5 text-[11.5px] leading-relaxed whitespace-pre-wrap text-foreground">{message.content}</p>
            ) : (
              !message.error && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {message.mode === 'build-skill' ? 'Drafting SKILL.md from the detected evidence…' : 'Waiting for the harness…'}
                </p>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** The build-skill completion card: candidate evidence + the harness-authored
 *  SKILL.md, with Copy / Save… / Dismiss (not-a-skill store) actions. */
function DraftCard({ message, onSave, dismiss }: {
  message: ChatMessage
  onSave: (path: string | null) => void
  dismiss: (source: SkillCandidate['source'], name: string, reason: string) => Promise<void>
}) {
  const candidate = message.draft!.candidate
  const markdown = message.draft!.markdown
  const [copied, setCopied] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState<(typeof DISMISS_REASONS)[number]>('not-a-skill')
  const [feedback, setFeedback] = useState<string | null>(null)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown)
    } catch {
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  const save = async (): Promise<void> => {
    const feedbackText = await saveDraftCard(candidate.name, markdown)
    setFeedback(feedbackText ?? 'Saved')
    onSave(feedbackText)
  }

  const confirmDismiss = async (): Promise<void> => {
    await dismiss(candidate.source, candidate.name, reason)
    setDismissing(false)
  }

  return (
    <div className="w-[520px] max-w-full">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] font-medium text-foreground">{candidate.name}</span>
          <span className="text-[10px] text-muted-foreground">· {describeCandidate(candidate)}</span>
        </div>
        <p className="mt-0.5 text-[10.5px] tabular-nums text-muted-foreground">
          ×{candidate.frequency} · {candidate.spreadSessions} session{candidate.spreadSessions === 1 ? '' : 's'} / {candidate.spreadProjects} project{candidate.spreadProjects === 1 ? '' : 's'} · {formatUsd(candidate.costUSD)}
        </p>
      </div>
      <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap border-b border-border p-3 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
        <code>{markdown}</code>
      </pre>
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        <CardAction onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</CardAction>
        <CardAction onClick={() => void save()}>Save…</CardAction>
        <CardAction onClick={() => setDismissing(current => !current)}>{dismissing ? 'Cancel' : 'Dismiss'}</CardAction>
        {feedback && <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{feedback}</span>}
      </div>
      {dismissing && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <select
            value={reason}
            onChange={e => setReason(e.target.value as (typeof DISMISS_REASONS)[number])}
            className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground focus:outline-none"
          >
            {DISMISS_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <CardAction onClick={() => void confirmDismiss()}>Not a skill — hide</CardAction>
        </div>
      )}
    </div>
  )
}

function CardAction({ onClick, disabled, children }: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-border bg-background px-2 py-[3px] text-[10.5px] text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/** Empty-state hint shown before the first run. */
function EmptyThread({ mode, hasHarness, hasWorkspace }: {
  mode: CoachMode
  hasHarness: boolean
  hasWorkspace: boolean
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="text-[12px] font-medium text-foreground">Coach &amp; Skills</span>
      <p className="max-w-sm text-[11px] text-muted-foreground">{MODE_HINT[mode]}</p>
      {!hasHarness && <p className="text-[10.5px] text-muted-foreground">No coding-agent harness detected on this machine — install Claude Code, OpenCode, Codex or another ACP harness to get started.</p>}
      {!hasWorkspace && <p className="text-[10.5px] text-muted-foreground">Pick a workspace above to give the harness a place to work.</p>}
    </div>
  )
}

/** The unified Coach & Skills section (ADR 0017): a chat surface where every
 *  harness run is tagged Coach (free-form guidance) or Build skill (a detected
 *  pattern becomes a draft SKILL.md, shown as an interactive card in the
 *  thread with copy / save / dismiss). No consent gate — the harnesses are the
 *  machine's own, and runs are user-initiated. */
export function CoachSkillsView(): React.JSX.Element {
  const scope = useScopeStore(useShallow(selectScope))
  const provider = useScopeStore(s => s.provider)
  const setProvider = useScopeStore(s => s.setProvider)
  const detectedProviders = useScanStore(s => s.detectedProviders)

  const harnesses = useCoachSkillsStore(s => s.harnesses)
  const harnessKind = useCoachSkillsStore(s => s.harnessKind)
  const workspacePath = useCoachSkillsStore(s => s.workspacePath)
  const mode = useCoachSkillsStore(s => s.mode)
  const messages = useCoachSkillsStore(s => s.messages)
  const running = useCoachSkillsStore(s => s.running)
  const error = useCoachSkillsStore(s => s.error)
  const detection = useCoachSkillsStore(s => s.detection)
  const loadHarnesses = useCoachSkillsStore(s => s.loadHarnesses)
  const setHarness = useCoachSkillsStore(s => s.setHarness)
  const pickWorkspace = useCoachSkillsStore(s => s.pickWorkspace)
  const setMode = useCoachSkillsStore(s => s.setMode)
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
  const drafts = detection.data?.drafts ?? []
  // Composite candidate key: the same name can come from different sources
  // (skill vs bash), so the picker value must be source\0name.
  const candidateKey = (d: SkillCandidate): string => `${d.source}\0${d.name}`
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

  return (
    <div className={cn('w-full max-w-[1180px]', motionClass('flex flex-col gap-3', 'section-fade'))}>
      {providerOptions.length > 1 && (
        <div className="flex justify-center">
          <SegTabs options={providerOptions} value={provider} onChange={setProvider} />
        </div>
      )}

      {/* Control strip: harness + workspace + mode tag. */}
      <Panel className="flex flex-col gap-2 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <SegTabs
            options={[
              { value: 'coach', label: 'Coach' },
              { value: 'build-skill', label: 'Build skill' },
            ]}
            value={mode}
            onChange={value => setMode(value as CoachMode)}
          />
          <span className="mx-1 hidden h-4 w-px bg-border sm:block" />
          <select
            value={harnessKind ?? ''}
            onChange={e => setHarness(e.target.value)}
            className="h-7 rounded-md border border-border bg-card px-2 text-[11.5px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="Harness"
          >
            {harnesses.length === 0 && <option value="">No harness detected</option>}
            {harnesses.map(h => (
              <option key={h.kind} value={h.kind}>
                {h.displayName}{h.authStatus === 'configured' ? ' · configured' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void pickWorkspace()}
            className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border border-border bg-card px-2 text-[11px] text-muted-foreground hover:text-foreground"
            title="Choose the workspace the harness runs in"
          >
            <span className="shrink-0 font-medium text-foreground">Workspace</span>
            <span className="truncate">{workspacePath ?? 'pick a directory…'}</span>
          </button>
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
              <span className="text-[10.5px] text-muted-foreground">
                No draft skills detected in this scope yet — run a scan or widen the period.
              </span>
            ) : (
              <>
                <select
                  value={selectedCandidate}
                  onChange={e => setSelectedCandidate(e.target.value)}
                  className="h-7 min-w-[220px] max-w-[420px] flex-1 rounded-md border border-border bg-card px-2 text-[11.5px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label="Candidate"
                >
                  <option value="">Choose a detected pattern…</option>
                  {drafts.map(d => (
                    <option key={candidateKey(d)} value={candidateKey(d)}>
                      {d.name} · ×{d.frequency} · {formatUsd(d.costUSD)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void detection.reload()}
                  className="h-7 rounded-md border border-border bg-card px-2 text-[10.5px] text-muted-foreground hover:text-foreground"
                >
                  Refresh
                </button>
              </>
            )}
          </div>
        )}
      </Panel>

      {/* The thread. */}
      <Panel className="min-h-[300px] flex-1 overflow-hidden">
        {messages.length === 0 ? (
          <div className="h-[300px]">
            <EmptyThread mode={mode} hasHarness={harnesses.length > 0} hasWorkspace={!!workspacePath} />
          </div>
        ) : (
          <div className="flex max-h-[50vh] flex-col gap-2.5 overflow-y-auto p-3.5">
            {messages.map(message => (
              <MessageBubble key={message.id} message={message} onSave={setSaveNotice} />
            ))}
            {saveNotice && <div className="text-center text-[10px] text-muted-foreground">{saveNotice}</div>}
            <div ref={threadEndRef} />
          </div>
        )}
      </Panel>

      {/* Composer. */}
      <Panel className="px-3.5 py-2.5">
        {mode === 'coach' ? (
          <div className="flex items-end gap-2">
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              rows={2}
              placeholder="Ask the harness anything about your workflow…"
              className="min-w-0 flex-1 resize-none rounded-md border border-border bg-background p-2.5 text-[12px] leading-relaxed text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              onClick={send}
              disabled={running || !prompt.trim() || !harnessKind || !workspacePath}
              className="h-9 shrink-0 rounded-md bg-primary px-3.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              Send
            </button>
            {running && (
              <button
                type="button"
                onClick={cancel}
                className="h-9 shrink-0 rounded-md border border-border bg-card px-3 text-[12px] text-muted-foreground hover:text-foreground"
              >
                Stop
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={send}
              disabled={running || !selectedDraft || !harnessKind || !workspacePath}
              className="h-9 shrink-0 rounded-md bg-primary px-3.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              {selectedDraft ? `Build skill: ${selectedDraft.name}` : 'Build skill'}
            </button>
            {running && (
              <button
                type="button"
                onClick={cancel}
                className="h-9 shrink-0 rounded-md border border-border bg-card px-3 text-[12px] text-muted-foreground hover:text-foreground"
              >
                Stop
              </button>
            )}
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
              {selectedDraft ? `×${selectedDraft.frequency} · ${selectedDraft.spreadSessions}s / ${selectedDraft.spreadProjects}p · ${formatUsd(selectedDraft.costUSD)}` : 'Choose a detected pattern above, then build its draft.'}
            </span>
          </div>
        )}
      </Panel>

      {/* Session controls. */}
      {messages.length > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={resetSession}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-[10.5px] text-muted-foreground hover:text-foreground"
          >
            New conversation
          </button>
        </div>
      )}

      {detection.error && <ErrorPanel message={detection.error} />}
    </div>
  )
}
