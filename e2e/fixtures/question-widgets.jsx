/* global document, window */
import './question-widgets.css'

import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Button } from '@/renderer/components/ui/button'
import { QuestionForm } from '@/renderer/features/workspace/requests/QuestionForm'
import { RequestRow } from '@/renderer/features/workspace/timeline/RequestRow'

const questions = [
  {
    id: 'branch',
    header: 'Branch',
    prompt: 'Choose the **branch** for this task.',
    multiSelect: false,
    options: [
      { id: 'main', label: 'Main branch', description: 'Continue on the current branch.', recommended: true },
      { id: 'work', label: 'New branch', description: 'Create a separate branch.' },
    ],
  },
  {
    id: 'checks',
    header: 'Checks',
    prompt: 'Which checks should run?',
    multiSelect: true,
    allowCustomAnswer: true,
    options: [
      { id: 'lint', label: 'Lint', description: 'Check code style.' },
      { id: 'test', label: 'Tests', description: 'Run the test suite.' },
    ],
  },
  {
    id: 'secret',
    header: 'Credential',
    prompt: 'Enter the temporary credential.',
    multiSelect: false,
    isSecret: true,
    options: [],
  },
]
const request = {
  requestId: 'question-widgets',
  runId: 'run-questions',
  generation: 1,
  kind: 'question',
  prompt: questions.map(question => question.prompt).join('\n'),
  questions,
}
const strictRequest = {
  ...request,
  requestId: 'strict-questions',
  questions: [
    {
      id: 'strict',
      prompt: 'Pick one choice',
      multiSelect: false,
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
      ],
    },
  ],
}

function Fixture() {
  const [visible, setVisible] = useState(true)
  const [strict, setStrict] = useState(false)
  const [parallel, setParallel] = useState(false)
  const [decision, setDecision] = useState(null)
  const active = strict ? strictRequest : request
  const respond = answer => {
    window.questionResponse = answer
    setDecision(answer)
  }
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex gap-2">
        <Button onClick={() => setVisible(current => !current)}>{visible ? 'Hide questions' : 'Show questions'}</Button>
        <Button
          onClick={() => {
            setStrict(true)
            setDecision(null)
          }}
        >
          Use strict choices
        </Button>
        <Button onClick={() => setParallel(current => !current)}>Toggle parallel questions</Button>
      </div>
      <section aria-label="Primary questions" className="bg-muted/30 rounded-xl border p-4">
        {decision ? (
          <RequestRow
            block={{
              kind: 'request',
              requestId: active.requestId,
              requestKind: 'question',
              prompt: active.prompt,
              request: active,
              decision,
              outcome: 'answered',
              sequence: 1,
            }}
            live={false}
          />
        ) : (
          visible && (
            <QuestionForm
              key={active.requestId}
              request={active}
              disabled={false}
              delivery={null}
              onRespond={respond}
            />
          )
        )}
      </section>
      {parallel && (
        <section aria-label="Parallel questions" className="rounded-xl border p-4">
          <QuestionForm
            request={{ ...strictRequest, requestId: 'parallel-questions' }}
            disabled={false}
            delivery={null}
            onRespond={() => {}}
          />
        </section>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
)
