/* global document, navigator, globalThis */
import './workspace-tool-widgets.css'

import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Button } from '@/renderer/components/ui/button'
import { PlanBlock } from '@/renderer/features/workspace/timeline/PlanBlock'
import { ReasoningBlock } from '@/renderer/features/workspace/timeline/ReasoningBlock'
import { ToolRow, TurnFoldRow, WorkGroupRow } from '@/renderer/features/workspace/timeline/WorkLog'

Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: async text => {
      globalThis.widgetClipboard = text
    },
  },
})

const tool = {
  kind: 'tool',
  toolCallId: 'command-1',
  name: 'Bash',
  status: 'running',
  input: '{"command":"npm test"}',
  command: 'npm test',
  cwd: 'C:/workspace',
  output:
    '\u001b[1;32mAll tests passed\u001b[0m\n' + Array.from({ length: 70 }, (_, index) => `line ${index}`).join('\n'),
  error: null,
  continued: false,
  sequence: 1,
}

function Fixture() {
  const [command, setCommand] = useState(tool)
  const [activityTools, setActivityTools] = useState([{ ...tool, toolCallId: 'activity-1', sequence: 2 }])
  const [disclosureChoices, setDisclosureChoices] = useState({})
  const [foldOpen, setFoldOpen] = useState(false)
  const [streaming, setStreaming] = useState(true)
  const [done, setDone] = useState(false)
  const updateDisclosure = (key, open) => setDisclosureChoices(current => ({ ...current, [key]: open }))
  return (
    <main className="dark bg-background text-foreground min-h-screen p-4">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setCommand(value => ({ ...value, output: value.output + '\nnew output line\n' }))}>
            Append output
          </Button>
          <Button
            onClick={() => setCommand(value => ({ ...value, status: 'completed', exitCode: 0, durationMs: 1234 }))}
          >
            Finish command
          </Button>
          <Button
            onClick={() =>
              setCommand(value => ({
                ...value,
                status: 'failed',
                error: 'The command exited with code 1.',
                exitCode: 1,
              }))
            }
          >
            Fail command
          </Button>
          <Button
            onClick={() =>
              setActivityTools(value =>
                value.length > 1
                  ? value
                  : [...value, { ...tool, toolCallId: 'activity-2', sequence: 3, output: 'second command output' }],
              )
            }
          >
            Add activity tool
          </Button>
          <Button
            onClick={() =>
              setActivityTools(value =>
                value.map(entry => ({ ...entry, status: 'completed', durationMs: 800, exitCode: 0 })),
              )
            }
          >
            Complete activity group
          </Button>
          <Button
            onClick={() =>
              setActivityTools(value =>
                value.map((entry, index) =>
                  index === 1
                    ? { ...entry, status: 'failed', error: 'The second activity failed.', exitCode: 1 }
                    : entry,
                ),
              )
            }
          >
            Fail second activity
          </Button>
          <Button
            onClick={() => {
              setStreaming(false)
              setDone(true)
            }}
          >
            Finish reasoning and plan
          </Button>
          <Button onClick={() => document.querySelector('main').classList.toggle('dark')}>Toggle theme</Button>
        </div>
        <article aria-label="Command widget">
          <ToolRow tool={command} />
        </article>
        <article aria-label="Reasoning widget">
          <ReasoningBlock text="Checking **dependencies** before applying changes." streaming={streaming} />
        </article>
        <article aria-label="Manual reasoning widget">
          <ReasoningBlock text="A manually expanded thought remains available." streaming={streaming} />
        </article>
        <article aria-label="Plan widget">
          <PlanBlock
            explanation="Apply the change and verify it."
            streaming={streaming}
            entries={[
              { content: 'Inspect the **current behavior**', status: 'completed' },
              { content: 'Implement changes', status: done ? 'completed' : 'inProgress' },
              { content: 'Run checks', status: done ? 'completed' : 'pending' },
            ]}
          />
        </article>
        <article aria-label="Activity group widget">
          <WorkGroupRow
            group={{
              key: 'work:activity',
              tools: activityTools,
              summary: {
                label: 'Ran 2 commands',
                toolCount: activityTools.length,
                failedCount: activityTools.filter(entry => entry.status === 'failed').length,
              },
            }}
            turnId="fixture-run"
            disclosureChoices={disclosureChoices}
            onDisclosureChange={(key, open) => updateDisclosure(key, open)}
          />
        </article>
        <article aria-label="Completed fold widget">
          <TurnFoldRow
            label="Worked"
            summary={{ label: 'Ran 2 commands', toolCount: activityTools.length, failedCount: 0 }}
            groups={[
              {
                key: 'work:activity',
                tools: activityTools,
                summary: {
                  label: 'Ran 2 commands',
                  toolCount: activityTools.length,
                  failedCount: activityTools.filter(entry => entry.status === 'failed').length,
                },
              },
            ]}
            turnId="completed-fixture-run"
            disclosureChoices={disclosureChoices}
            onDisclosureChange={(key, open) => updateDisclosure(key, open)}
            open={foldOpen}
            onOpenChange={setFoldOpen}
          />
        </article>
        <article aria-label="File changes widget">
          <ToolRow
            tool={{
              ...tool,
              toolCallId: 'files-1',
              name: 'FileChange',
              category: 'fileWrite',
              status: 'completed',
              command: undefined,
              input: null,
              output: null,
              changes: [
                { path: 'src/main.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
                { path: 'src/new.ts', kind: 'add' },
              ],
            }}
          />
        </article>
        <article aria-label="Unknown widget">
          <ToolRow
            tool={{
              ...tool,
              toolCallId: 'custom-1',
              name: 'Custom',
              category: 'other',
              command: undefined,
              status: 'unknown',
              input: '{"payload":"<script>globalThis.widgetExecuted = true</script>"}',
              output: '{"ok":true,"nested":{"count":2}}',
              url: 'javascript:alert(1)',
            }}
          />
        </article>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
)
