import { ChevronRightIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from 'lucide-react'

import { Markdown } from '@/renderer/components/Markdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible'
import { cn } from '@/renderer/shared/lib/utils'

import type { ConversationRequestOutcome, ConversationTurnBlock } from '../conversation-view.js'
import { questionAnswerLabels, requestLabel } from '../request-controls.js'
import { RequestToolDetails } from '../request-tool-details.js'

type RequestBlock = Extract<ConversationTurnBlock, { readonly kind: 'request' }>

function getRequestLabel(block: RequestBlock): string {
  if (block.request) return requestLabel(block.request)
  if (block.requestKind === 'question') return 'Question'
  return 'Approval requested'
}

const outcomeLabels: Readonly<Record<Exclude<ConversationRequestOutcome, 'pending'>, string>> = {
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Cancelled',
  answered: 'Answered',
}

/**
 * A request in the transcript. Its controls live in the composer drawer; this row records what was
 * asked and how it ended, updating in place once the request resolves.
 */
export function RequestRow({
  block,
  live,
}: {
  readonly block: RequestBlock
  /** The Run is still active, so a pending request is waiting on the user rather than abandoned. */
  readonly live: boolean
}): React.JSX.Element {
  const pending = block.outcome === 'pending'
  const status = pending ? (live ? 'Waiting for you' : 'No response') : outcomeLabels[block.outcome]
  const Icon = block.requestKind === 'question' ? MessageCircleQuestionIcon : ShieldQuestionIcon
  const label = getRequestLabel(block)
  const summary = block.prompt?.split('\n', 1)[0]?.trim() ?? ''
  const questions = block.request?.kind === 'question' ? block.request.questions : []
  const answerPreview = questions.flatMap(question => questionAnswerLabels(question, block.decision)).join(' · ')
  const hasDetail =
    Boolean(block.request?.toolCallId || block.request?.tool) ||
    questions.length > 0 ||
    Boolean(block.prompt && block.prompt.trim() !== summary) ||
    (block.decision?.kind === 'deny' && Boolean(block.decision.reason))
  return (
    <Collapsible
      className={cn(
        'rounded-md border px-2.5 py-1.5 text-xs',
        pending && live ? 'border-warning/50 bg-warning/5' : 'bg-muted/40',
      )}
    >
      <CollapsibleTrigger
        disabled={!hasDetail}
        className="flex w-full min-w-0 items-center gap-2 text-left disabled:cursor-default"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'text-muted-foreground size-3 shrink-0 transition-transform data-[panel-open]:rotate-90',
            !hasDetail && 'invisible',
          )}
        />
        <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">{label}</span>
        {(summary || answerPreview) && (
          <span className="text-muted-foreground min-w-0 truncate">{answerPreview || summary}</span>
        )}
        <span
          className={cn(
            'ml-auto shrink-0',
            pending && live ? 'text-warning' : 'text-muted-foreground',
            block.outcome === 'declined' && 'text-destructive',
          )}
        >
          {status}
        </span>
      </CollapsibleTrigger>
      {hasDetail && (
        <CollapsibleContent className="space-y-3 pt-2">
          {block.request && <RequestToolDetails request={block.request} />}
          {questions.length > 0 ? (
            <dl className="space-y-3">
              {questions.map(question => {
                const answers = questionAnswerLabels(question, block.decision)
                return (
                  <div key={question.id} className="rounded-md border px-3 py-2">
                    {question.header && (
                      <p className="text-muted-foreground mb-1 text-[10px] font-medium">{question.header}</p>
                    )}
                    <dt className="typeset font-medium">
                      <Markdown>{question.prompt}</Markdown>
                    </dt>
                    <dd className="mt-2">
                      {answers.length > 0 ? (
                        <ul aria-label="Submitted answers" className="flex flex-wrap gap-1.5">
                          {answers.map((answer, index) => (
                            <li
                              key={`${question.id}:${index}`}
                              className="bg-primary/10 rounded-md px-2 py-1 break-words whitespace-pre-wrap"
                            >
                              {answer}
                            </li>
                          ))}
                        </ul>
                      ) : question.options.length > 0 ? (
                        <ul className="text-muted-foreground space-y-1">
                          {question.options.map(option => (
                            <li key={option.id}>
                              <span className="font-medium">{option.label}</span>
                              {option.description && <span className="block text-[10px]">{option.description}</span>}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground">
                          {pending ? 'Waiting for an answer' : 'No answer was submitted'}
                        </p>
                      )}
                    </dd>
                  </div>
                )
              })}
            </dl>
          ) : (
            block.prompt && (
              <div className="typeset bg-muted max-h-60 overflow-auto rounded p-2 break-words">
                <Markdown>{block.prompt}</Markdown>
              </div>
            )
          )}
          {block.decision?.kind === 'deny' && block.decision.reason && (
            <p className="text-muted-foreground break-words">{block.decision.reason}</p>
          )}
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
