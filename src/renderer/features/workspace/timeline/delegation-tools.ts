import type { ToolBlock } from './work-log.js'

const delegationToolPattern = /^(?:(?:mcp__)?watchtower-orchestrator(?:__|\s*[:/]\s*))?delegation_([a-z]+)$/i

export function delegationToolVerb(name: string): string | undefined {
  return delegationToolPattern.exec(name.trim())?.[1]?.toLowerCase()
}

const checking = {
  running: 'Checking delegated tasks',
  completed: 'Checked delegated tasks',
  failed: "Couldn't check delegated tasks",
}

const sentences: Readonly<Record<string, Record<Exclude<ToolBlock['status'], 'unknown'>, string>>> = {
  start: { running: 'Delegating a task', completed: 'Delegated a task', failed: "Couldn't delegate a task" },
  status: checking,
  list: checking,
  read: {
    running: 'Reading a delegated task',
    completed: 'Read a delegated task',
    failed: "Couldn't read a delegated task",
  },
  send: {
    running: 'Messaging a delegated task',
    completed: 'Messaged a delegated task',
    failed: "Couldn't message a delegated task",
  },
  cancel: {
    running: 'Stopping a delegated task',
    completed: 'Stopped a delegated task',
    failed: "Couldn't stop a delegated task",
  },
  capabilities: {
    running: 'Checking delegation targets',
    completed: 'Checked delegation targets',
    failed: "Couldn't check delegation targets",
  },
}

export function delegationToolSentence(tool: ToolBlock): string | undefined {
  const verb = delegationToolVerb(tool.name)
  if (!verb || !Object.hasOwn(sentences, verb)) return undefined
  return sentences[verb][tool.status === 'unknown' ? 'running' : tool.status]
}

export function delegationStartId(tool: ToolBlock): string | undefined {
  if (delegationToolVerb(tool.name) !== 'start') return undefined
  return tool.orchestration?.delegationId?.trim() || undefined
}
