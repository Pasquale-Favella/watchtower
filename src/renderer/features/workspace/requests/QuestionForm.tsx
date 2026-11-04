import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import { Button } from '@/renderer/components/ui/button'
import { Input } from '@/renderer/components/ui/input'
import { cn } from '@/renderer/shared/lib/utils'
import type { AgentRequest, AgentRequestDecision } from '@/shared/schemas/execution.js'

import { questionAnswerLabels, questionDecision, type ResponseDeliveryState } from '../request-controls.js'
import {
  chooseQuestionOption,
  digitShortcutIndex,
  forgetQuestionDraft,
  questionCustomAnswer,
  questionProgress,
  readQuestionDraft,
  rememberQuestionDraft,
  setQuestionCustomAnswer,
} from '../request-drawer-state.js'

const AUTO_ADVANCE_MS = 200

interface QuestionFormProps {
  readonly request: AgentRequest
  readonly disabled: boolean
  readonly delivery: ResponseDeliveryState | null
  readonly onRespond: (decision: AgentRequestDecision) => void
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

export function QuestionForm({ request, disabled, delivery, onRespond }: QuestionFormProps): React.JSX.Element {
  const [draft, setDraft] = useState(() => readQuestionDraft(request))
  const { answers, index } = draft
  const panelId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const focusNext = useRef(false)
  const advanceTimer = useRef<number | null>(null)
  const progress = questionProgress(request.questions, answers, index)
  const question = progress.question
  const decision = questionDecision(request, answers)

  const clearAdvance = () => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current)
    advanceTimer.current = null
  }
  useEffect(() => clearAdvance, [])
  useEffect(() => rememberQuestionDraft(request, draft), [request, draft])
  useEffect(() => {
    if (delivery === 'accepted') forgetQuestionDraft(request)
  }, [delivery, request])
  useEffect(() => {
    if (!focusNext.current) return
    focusNext.current = false
    headingRef.current?.focus()
  }, [question?.id])

  const goTo = (next: number) => {
    clearAdvance()
    focusNext.current = true
    setDraft(current => ({ ...current, index: Math.min(Math.max(next, 0), Math.max(progress.total - 1, 0)) }))
  }
  const submit = () => {
    clearAdvance()
    if (!disabled && decision) onRespond(decision)
  }
  const choose = (optionId: string) => {
    if (disabled || !question) return
    setDraft(current => ({ ...current, answers: chooseQuestionOption(question, current.answers, optionId) }))
    if (question.multiSelect) return
    clearAdvance()
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null
      if (progress.isLast) submitRef.current?.focus()
      else goTo(progress.index + 1)
    }, AUTO_ADVANCE_MS)
  }
  const shortcutChoose = useEffectEvent(choose)
  const options = question?.options
  useEffect(() => {
    if (disabled || !options?.length) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      const panel = panelRef.current
      if (!panel) return
      const focusedPanel = document.activeElement?.closest('[data-question-panel]')
      if (focusedPanel ? focusedPanel !== panel : document.querySelector('[data-question-panel]') !== panel) return
      const optionIndex = digitShortcutIndex(event, options.length)
      const option = optionIndex === null ? undefined : options[optionIndex]
      if (!option) return
      event.preventDefault()
      shortcutChoose(option.id)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [disabled, options])

  if (!question) {
    return <p className="text-muted-foreground text-xs">This request contains no answerable questions.</p>
  }
  const customAllowed = question.options.length === 0 || question.allowCustomAnswer === true
  const customAnswer = questionCustomAnswer(question, answers)
  const preamble = request.prompt.trim()
  const combinedQuestions = request.questions
    .map(item => item.prompt)
    .join('\n')
    .trim()
  let answerHint = 'Choose one answer'
  if (question.options.length === 0) answerHint = 'Write your answer'
  else if (question.multiSelect) answerHint = 'Choose all that apply'

  return (
    <div ref={panelRef} data-question-panel className="space-y-3">
      {preamble && preamble !== question.prompt.trim() && preamble !== combinedQuestions && (
        <div className="typeset text-muted-foreground text-xs">
          <Markdown>{request.prompt}</Markdown>
        </div>
      )}
      {progress.total > 1 && (
        <nav aria-label="Question navigation" className="flex flex-wrap items-center gap-1">
          {request.questions.map((item, questionIndex) => {
            const answered = questionProgress([item], answers, 0).complete
            return (
              <Button
                key={item.id}
                type="button"
                size="xs"
                variant={questionIndex === progress.index ? 'secondary' : 'ghost'}
                disabled={disabled}
                aria-label={`Question ${questionIndex + 1}${item.header ? `: ${item.header}` : ''}`}
                aria-current={questionIndex === progress.index ? 'step' : undefined}
                onClick={() => goTo(questionIndex)}
              >
                {answered && <Check aria-hidden className="size-3" />}
                {questionIndex + 1}
              </Button>
            )
          })}
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {progress.index + 1} / {progress.total}
          </span>
        </nav>
      )}
      <fieldset key={question.id} disabled={disabled} className="space-y-2">
        <legend className="sr-only">{question.prompt}</legend>
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          {question.header && <p className="text-muted-foreground mb-1 text-xs font-medium">{question.header}</p>}
          <div className="typeset text-sm font-medium">
            <Markdown>{question.prompt}</Markdown>
          </div>
        </div>
        {question.options.length > 0 && (
          <div role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.prompt} className="space-y-1">
            {question.options.map((option, optionIndex) => {
              const answer = answers[question.id]
              const selected = Array.isArray(answer) ? answer.includes(option.id) : answer === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  role={question.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  aria-describedby={option.description ? `${panelId}-option-${optionIndex}-description` : undefined}
                  disabled={disabled}
                  className={cn(
                    'focus-visible:ring-ring/50 flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
                    selected ? 'border-primary/40 bg-primary/10' : 'hover:bg-muted border-transparent',
                  )}
                  onClick={() => choose(option.id)}
                  onKeyDown={event => {
                    const offset = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
                    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return
                    event.preventDefault()
                    const choices = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')
                    choices?.[(optionIndex + offset + question.options.length) % question.options.length]?.focus()
                  }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                      question.multiSelect ? 'rounded-sm' : 'rounded-full',
                      selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50',
                    )}
                  >
                    {selected && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium break-words">
                      {option.label}
                      {option.recommended && <span className="text-primary ml-2 text-[10px]">Recommended</span>}
                    </span>
                    {option.description && (
                      <span
                        id={`${panelId}-option-${optionIndex}-description`}
                        className="text-muted-foreground mt-0.5 block text-xs break-words"
                      >
                        {option.description}
                      </span>
                    )}
                  </span>
                  {optionIndex < 9 && (
                    <kbd className="text-muted-foreground shrink-0 font-mono text-[10px]">{optionIndex + 1}</kbd>
                  )}
                </button>
              )
            })}
          </div>
        )}
        {customAllowed && (
          <label className="block space-y-1.5 text-xs">
            <span className="text-muted-foreground">{question.options.length ? 'Other answer' : 'Your answer'}</span>
            <Input
              type={question.isSecret ? 'password' : 'text'}
              aria-label={question.options.length ? 'Other answer' : 'Your answer'}
              value={customAnswer}
              autoComplete="off"
              spellCheck={!question.isSecret}
              placeholder={question.options.length ? 'Add your own answer' : 'Type your answer'}
              onChange={event => {
                clearAdvance()
                const text = event.target.value
                setDraft(current => ({ ...current, answers: setQuestionCustomAnswer(question, current.answers, text) }))
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                event.preventDefault()
                if (!progress.canAdvance) return
                if (progress.isLast) submit()
                else goTo(progress.index + 1)
              }}
            />
          </label>
        )}
      </fieldset>
      {progress.isLast && decision && request.questions.length > 1 && (
        <details className="text-muted-foreground rounded-lg border px-3 py-2 text-xs">
          <summary className="cursor-pointer">Review {request.questions.length} answers</summary>
          <dl className="mt-2 space-y-2">
            {request.questions.map(item => (
              <div key={item.id}>
                <dt className="font-medium">{item.header ?? item.prompt}</dt>
                <dd className="mt-0.5 break-words">{questionAnswerLabels(item, decision).join(', ')}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="text-muted-foreground mr-auto text-[10px]">{answerHint}</span>
        {progress.index > 0 && (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => goTo(progress.index - 1)}>
            <ChevronLeft aria-hidden className="size-3" />
            Back
          </Button>
        )}
        {progress.isLast ? (
          <Button ref={submitRef} type="button" size="sm" disabled={disabled || decision === null} onClick={submit}>
            Submit answers
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={disabled || !progress.canAdvance}
            onClick={() => goTo(progress.index + 1)}
          >
            Next
            <ChevronRight aria-hidden className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}
