import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import { Badge } from '@/renderer/components/ui/badge'
import { Button } from '@/renderer/components/ui/button'
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@/renderer/components/ui/questionnaire'
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

type Question = AgentRequest['questions'][number]

interface QuestionFormProps {
  readonly request: AgentRequest
  readonly disabled: boolean
  readonly delivery: ResponseDeliveryState | null
  readonly onRespond: (decision: AgentRequestDecision) => void
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

function answerHint(question: Question): string {
  if (question.options.length === 0) return 'Write your answer.'
  if (question.multiSelect) return 'Choose all that apply.'
  return 'Choose one answer.'
}

export function QuestionForm({ request, disabled, delivery, onRespond }: QuestionFormProps): React.JSX.Element {
  const [draft, setDraft] = useState(() => readQuestionDraft(request))
  const { answers, index } = draft
  const formRef = useRef<HTMLFormElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const advanceTimer = useRef<number | null>(null)
  /** Set by a pointer press on a choice, so only clicks auto-advance; arrow keys and shortcuts select without moving on. */
  const pointerChoice = useRef(false)
  const progress = questionProgress(request.questions, answers, index)
  const question = progress.question
  const decision = questionDecision(request, answers)
  const items = useMemo(
    () =>
      request.questions.map(item => ({
        name: item.id,
        required: true,
        choices: item.options.map(option => ({ value: option.id })),
      })),
    [request.questions],
  )

  const clearAdvance = () => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current)
    advanceTimer.current = null
  }
  useEffect(() => clearAdvance, [])
  useEffect(() => rememberQuestionDraft(request, draft), [request, draft])
  useEffect(() => {
    if (delivery === 'accepted') forgetQuestionDraft(request)
  }, [delivery, request])

  const goTo = (next: number) => {
    clearAdvance()
    setDraft(current => ({ ...current, index: Math.min(Math.max(next, 0), Math.max(progress.total - 1, 0)) }))
  }
  const choose = (target: Question, optionId: string, advance: boolean) => {
    if (disabled) return
    setDraft(current => ({ ...current, answers: chooseQuestionOption(target, current.answers, optionId) }))
    if (target.multiSelect || !advance) return
    clearAdvance()
    const targetIndex = request.questions.findIndex(item => item.id === target.id)
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null
      if (targetIndex >= progress.total - 1) submitRef.current?.focus()
      else goTo(targetIndex + 1)
    }, AUTO_ADVANCE_MS)
  }
  const setCustomAnswer = (target: Question, text: string) => {
    clearAdvance()
    setDraft(current => ({ ...current, answers: setQuestionCustomAnswer(target, current.answers, text) }))
  }

  // Inside the form the questionnaire owns digit shortcuts. This fallback keeps them working while focus is
  // elsewhere in the window (not in a text field), for the first question panel only.
  const shortcutChoose = useEffectEvent((optionId: string) => question && choose(question, optionId, false))
  const options = question?.options
  useEffect(() => {
    if (disabled || !options?.length) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return
      if (document.activeElement?.closest('[data-question-panel]')) return
      if (document.querySelector('[data-question-panel]') !== formRef.current) return
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
  const preamble = request.prompt.trim()
  const combinedQuestions = request.questions
    .map(item => item.prompt)
    .join('\n')
    .trim()

  return (
    <Questionnaire
      ref={formRef}
      data-question-panel
      aria-label="Agent questions"
      className="gap-3"
      items={items}
      item={question.id}
      onItemChange={name => goTo(request.questions.findIndex(item => item.id === name))}
      shortcuts="numbers"
      onSubmit={event => {
        event.preventDefault()
        clearAdvance()
        if (!disabled && decision) onRespond(decision)
      }}
    >
      {preamble && preamble !== question.prompt.trim() && preamble !== combinedQuestions && (
        <div className="typeset text-muted-foreground text-xs">
          <Markdown>{request.prompt}</Markdown>
        </div>
      )}
      {progress.total > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <nav aria-label="Question navigation" className="flex flex-wrap items-center gap-1">
            {request.questions.map((item, questionIndex) => {
              const current = questionIndex === progress.index
              const answered = questionProgress([item], answers, 0).complete
              return (
                <Button
                  key={item.id}
                  type="button"
                  size="xs"
                  variant={current ? 'secondary' : 'ghost'}
                  disabled={disabled}
                  aria-label={`Question ${questionIndex + 1}${item.header ? `: ${item.header}` : ''}${answered ? ', answered' : ''}`}
                  aria-current={current ? 'step' : undefined}
                  onClick={() => goTo(questionIndex)}
                >
                  <span
                    aria-hidden
                    className={cn('size-1.5 rounded-full', answered ? 'bg-primary' : 'bg-muted-foreground/30')}
                  />
                  {item.header ?? questionIndex + 1}
                </Button>
              )
            })}
          </nav>
          <QuestionnaireProgress className="ml-auto min-w-0 text-[10px]" />
        </div>
      )}
      {request.questions.map(item => {
        const customAllowed = item.options.length === 0 || item.allowCustomAnswer === true
        const answer = answers[item.id]
        const customLabel = item.options.length ? 'Other answer' : 'Your answer'
        return (
          <QuestionnaireItem
            key={item.id}
            name={item.id}
            required
            multiple={item.multiSelect}
            className="data-active:animate-in data-active:fade-in-0 gap-3"
          >
            <QuestionnaireTitle className="mb-1! text-sm">
              {item.header && progress.total === 1 && (
                <span className="text-muted-foreground mb-1 block text-xs">{item.header}</span>
              )}
              <span className="typeset block">
                <Markdown>{item.prompt}</Markdown>
              </span>
            </QuestionnaireTitle>
            <QuestionnaireDescription className="text-xs">{answerHint(item)}</QuestionnaireDescription>
            <QuestionnaireChoices>
              {item.options.map(option => (
                <QuestionnaireChoice
                  key={option.id}
                  value={option.id}
                  disabled={disabled}
                  checked={Array.isArray(answer) ? answer.includes(option.id) : answer === option.id}
                  onPointerDown={() => {
                    pointerChoice.current = true
                  }}
                  onChange={() => {
                    const viaPointer = pointerChoice.current
                    pointerChoice.current = false
                    choose(item, option.id, viaPointer)
                  }}
                >
                  <span className="flex flex-wrap items-center gap-2 font-medium break-words">
                    {option.label}
                    {option.recommended && <Badge variant="secondary">Recommended</Badge>}
                  </span>
                  {option.description && (
                    <QuestionnaireChoiceDescription className="text-xs break-words">
                      {option.description}
                    </QuestionnaireChoiceDescription>
                  )}
                </QuestionnaireChoice>
              ))}
              {customAllowed && (
                <QuestionnaireInput
                  type={item.isSecret ? 'password' : 'text'}
                  aria-label={customLabel}
                  value={questionCustomAnswer(item, answers)}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={!item.isSecret}
                  placeholder={item.options.length ? 'Add your own answer' : 'Type your answer'}
                  onChange={event => setCustomAnswer(item, event.target.value)}
                />
              )}
            </QuestionnaireChoices>
            <QuestionnaireError className="mt-0 text-xs" />
          </QuestionnaireItem>
        )
      })}
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
      <QuestionnaireActions>
        <QuestionnairePrevious size="sm" variant="ghost" disabled={disabled}>
          <ChevronLeft aria-hidden />
          Back
        </QuestionnairePrevious>
        <QuestionnaireNext size="sm" disabled={disabled}>
          Next
          <ChevronRight aria-hidden />
        </QuestionnaireNext>
        <QuestionnaireSubmit ref={submitRef} size="sm" disabled={disabled}>
          Submit answers
        </QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>
  )
}
