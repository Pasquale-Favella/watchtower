import { RegistryContext } from '@effect/atom-react'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { type ComponentProps, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SidebarProvider } from '@/renderer/components/ui/sidebar.js'
import { TooltipProvider } from '@/renderer/components/ui/tooltip.js'
import {
  coachChatQuery,
  coachChatRequest,
  coachChatStartingAtom,
  discardCoachChatAtom,
} from '@/renderer/features/coach-skills/coach-chat-atoms.js'
import { CoachSkillsView } from '@/renderer/features/coach-skills/CoachSkillsView.js'
import { CoachWelcome } from '@/renderer/features/coach-skills/CoachWelcome.js'
import { SaveSkillButton } from '@/renderer/features/coach-skills/SaveSkillButton.js'
import { coachSkillDetection } from '@/renderer/features/coach-skills/skill-detection-atoms.js'
import { workspaceTask } from '@/renderer/features/workspace/atoms.js'
import type { ConversationAssistantTurn } from '@/renderer/features/workspace/conversation-view.js'
import { coachNewChatDraftAtom } from '@/renderer/features/workspace/new-chat-atoms.js'
import { WorkspaceChatColumn } from '@/renderer/features/workspace/WorkspaceChatColumn.js'
import { AssistantTurnEnd } from '@/renderer/features/workspace/WorkspaceConversation.js'
import { WorkspaceNewChat } from '@/renderer/features/workspace/WorkspaceNewChat.js'
import { ApplicationClient } from '@/renderer/shared/lib/application-rpc.js'
import type { SkillsPayload } from '@/shared/schemas/skills.js'
import type { ProjectId } from '@/shared/schemas/workspace.js'
import type { CoachChat, WorkspaceTaskDetail } from '@/shared/schemas/workspace-store.js'

const userActions = vi.hoisted(() => ({
  click: new Map<string, () => unknown>(),
  discard: vi.fn(async () => undefined),
  save: vi.fn(async () => ({ ok: true, path: 'skill/SKILL.md' })),
}))

// Server rendering observes the component tree. Capture the handlers before React drops them from the HTML.
vi.mock('@/renderer/components/ui/button.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/renderer/components/ui/button.js')>()
  return {
    ...actual,
    Button: (props: ComponentProps<typeof actual.Button>) => {
      if (typeof props.children === 'string' && props.onClick && !props.disabled) {
        const click = props.onClick
        userActions.click.set(props.children, () => click({} as never))
      }
      return createElement(actual.Button, props)
    },
  }
})

// The confirm dialog renders inline so server rendering sees its copy and captures its confirm handler.
vi.mock('@/renderer/components/ui/alert-dialog.js', () => {
  const block = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  return {
    AlertDialog: block,
    AlertDialogContent: block,
    AlertDialogHeader: block,
    AlertDialogFooter: block,
    AlertDialogTitle: block,
    AlertDialogDescription: block,
    AlertDialogCancel: block,
    AlertDialogAction: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => {
      if (typeof children === 'string' && onClick) userActions.click.set(children, onClick)
      return createElement('button', { type: 'button' }, children)
    },
  }
})

vi.mock('@/renderer/components/ui/tooltip.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/renderer/components/ui/tooltip.js')>()
  return {
    ...actual,
    TooltipTrigger: (props: ComponentProps<typeof actual.TooltipTrigger>) => {
      const button = props.render as ReactElement<ComponentProps<'button'>> | undefined
      if (button?.type === 'button' && button.props.onClick && !button.props.disabled) {
        const click = button.props.onClick
        userActions.click.set('suggested skill', () => click({} as never))
      }
      return createElement(actual.TooltipTrigger, props)
    },
  }
})

vi.mock('@effect/atom-react', async importOriginal => {
  const actual = await importOriginal<typeof import('@effect/atom-react')>()
  return {
    ...actual,
    useAtomSet: (...args: Parameters<typeof actual.useAtomSet>) => {
      const set = actual.useAtomSet(...args)
      if (args[0] === discardCoachChatAtom) return userActions.discard
      if (args[0] === ApplicationClient.mutation('skills:save')) return userActions.save
      return set
    },
  }
})

const now = '2026-11-02T12:00:00.000Z'
const STARTER_PROMPTS = [
  'Where am I wasting tokens?',
  'Summarise my last 30 days of work',
  'Craft a SKILL.md for my most common git workflow',
  'What patterns should I turn into skills?',
]
const noPatterns: SkillsPayload = {
  period: { start: now, end: now },
  summary: {
    sessions: 0,
    calls: 0,
    skillEvents: 0,
    bashEvents: 0,
    toolEvents: 0,
    drafts: 0,
    opportunities: 0,
    ghosts: 0,
  },
  drafts: [],
  opportunities: [],
  ghosts: [],
}

type WelcomeElement = ReactElement<{
  children?: ReactNode
  disabled?: boolean
  onClick?: () => void
  type?: string
}>

// CoachWelcome has no hooks, so its element tree can be walked to reach the starter buttons' handlers.
function elementsWhere(node: ReactNode, match: (element: WelcomeElement) => boolean): WelcomeElement[] {
  const found: WelcomeElement[] = []
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (!isValidElement<WelcomeElement['props']>(current)) return
    if (match(current)) found.push(current)
    visit(current.props.children)
  }
  visit(node)
  return found
}

function starterButtons(node: ReactNode): WelcomeElement[] {
  return elementsWhere(node, element => element.type === 'button' && typeof element.props.children === 'string')
}
const identity: CoachChat = { taskId: 'coach-task' as never, conversationId: 'coach-conversation' as never }
const detail: WorkspaceTaskDetail = {
  task: {
    id: identity.taskId,
    projectId: 'coach-project' as ProjectId,
    title: 'My coaching chat',
    status: 'open',
    description: '',
    createdAt: now,
    updatedAt: now,
  },
  conversations: [{ id: identity.conversationId, taskId: identity.taskId, createdAt: now }],
  totalConversations: 1,
  nextAfterConversationId: null,
}

function render(registry: AtomRegistry.AtomRegistry, element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      RegistryContext.Provider,
      { value: registry },
      createElement(TooltipProvider, null, createElement(SidebarProvider, null, element)),
    ),
  )
}

describe('Coach & Skills Workspace chat', () => {
  beforeEach(() => {
    userActions.click.clear()
    userActions.discard.mockClear()
    userActions.save.mockClear()
  })

  it('seeds a detected pattern as an editable draft and keeps New chat disabled before the first send', () => {
    const payload: SkillsPayload = {
      period: { start: now, end: now },
      summary: {
        sessions: 2,
        calls: 6,
        skillEvents: 6,
        bashEvents: 0,
        toolEvents: 0,
        drafts: 1,
        opportunities: 0,
        ghosts: 0,
      },
      drafts: [
        {
          name: 'data-fetch',
          source: 'skill',
          frequency: 6,
          spreadSessions: 2,
          spreadProjects: 1,
          costUSD: 3.5,
          turns: 4,
          latest: now,
          sample: 'data-fetch',
          sourceSessions: [],
        },
      ],
      opportunities: [],
      ghosts: [],
    }
    const registry = AtomRegistry.make({
      initialValues: [
        [coachChatQuery.requestAtom, coachChatRequest],
        [coachChatQuery.resultAtom, AsyncResult.success(null)],
        [coachSkillDetection.requestAtom, { scope: { period: 'today' }, frequency: 5, spread: 2 }],
        [coachSkillDetection.resultAtom, AsyncResult.success(payload)],
      ],
    })
    try {
      const markup = render(registry, createElement(CoachSkillsView))
      expect(markup).toContain('Suggested skills')
      expect(markup).toContain('data-fetch')
      expect(markup).toContain('Agent and model')
      expect(markup).not.toMatch(
        /aria-label="(?:Terminal|Conversation details|Right panel|Toggle workspace navigation)"/,
      )
      expect(userActions.click.has('New chat')).toBe(false)
      expect(registry.get(coachNewChatDraftAtom)).toBe('')
      userActions.click.get('suggested skill')?.()
      expect(registry.get(coachNewChatDraftAtom)).toContain('Craft a SKILL.md for the skill `data-fetch`')
      expect(registry.get(coachNewChatDraftAtom)).toContain('6 occurrences across 2 sessions / 1 project')
      expect(userActions.discard).not.toHaveBeenCalled()
    } finally {
      registry.dispose()
    }
  })

  it('restores the RPC chat and discards its Task once New chat is confirmed', async () => {
    const registry = AtomRegistry.make({
      initialValues: [
        [coachChatQuery.requestAtom, coachChatRequest],
        [coachChatQuery.resultAtom, AsyncResult.success(identity)],
        [workspaceTask.requestAtom, { taskId: identity.taskId, options: { limit: 30 } }],
        [workspaceTask.resultAtom, AsyncResult.success(detail)],
      ],
    })
    try {
      const markup = render(registry, createElement(CoachSkillsView))
      expect(markup).toContain('aria-label="Main conversation"')
      expect(markup).toContain('Agent and model')
      expect(markup).not.toContain('What should we work on?')
      expect(markup).not.toMatch(
        /aria-label="(?:Terminal|Conversation details|Right panel|Toggle workspace navigation)"/,
      )
      const workspace = render(
        registry,
        createElement(WorkspaceChatColumn, {
          taskId: identity.taskId,
          selectedConversationId: identity.conversationId,
        }),
      )
      expect(workspace).toContain('aria-label="Conversation details"')
      expect(workspace).toContain('aria-label="Terminal"')
      expect(workspace).toContain('aria-label="Right panel"')
      expect(markup).toContain('Start a new chat?')
      await userActions.click.get('New chat')?.()
      expect(userActions.discard).not.toHaveBeenCalled()
      await userActions.click.get('Discard and start new')?.()
      expect(userActions.discard).toHaveBeenCalledExactlyOnceWith({ payload: { taskId: identity.taskId } })
    } finally {
      registry.dispose()
    }
  })

  it('keeps New chat disabled while the first message of a chat is still being admitted', async () => {
    const registry = AtomRegistry.make({
      initialValues: [
        [coachChatQuery.requestAtom, coachChatRequest],
        [coachChatQuery.resultAtom, AsyncResult.success(identity)],
        [workspaceTask.requestAtom, { taskId: identity.taskId, options: { limit: 30 } }],
        [workspaceTask.resultAtom, AsyncResult.success(detail)],
        [coachChatStartingAtom, true],
      ],
    })
    try {
      const markup = render(registry, createElement(CoachSkillsView))
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>New chat<\/button>/)
      await userActions.click.get('New chat')?.()
      expect(userActions.discard).not.toHaveBeenCalled()
      registry.set(coachChatStartingAtom, false)
      render(registry, createElement(CoachSkillsView))
      expect(userActions.click.has('New chat')).toBe(true)
      await userActions.click.get('Discard and start new')?.()
      expect(userActions.discard).toHaveBeenCalledExactlyOnceWith({ payload: { taskId: identity.taskId } })
    } finally {
      registry.dispose()
    }
  })

  it('shows the Coach welcome above the composer with its starters, title and description', () => {
    const registry = AtomRegistry.make({
      initialValues: [
        [coachChatQuery.requestAtom, coachChatRequest],
        [coachChatQuery.resultAtom, AsyncResult.success(null)],
        [coachSkillDetection.requestAtom, { scope: { period: 'today' }, frequency: 5, spread: 2 }],
        [coachSkillDetection.resultAtom, AsyncResult.success(noPatterns)],
      ],
    })
    try {
      const markup = render(registry, createElement(CoachSkillsView))
      const title = markup.search(/<h2[^>]*>Coach &amp; Skills<\/h2>/)
      expect(title).toBeGreaterThan(-1)
      expect(markup).toContain('Ask the harness for guidance on your workflow')
      expect(markup).toContain('The agent can query your platform data live through the in-app')
      for (const prompt of STARTER_PROMPTS) expect(markup).toContain(prompt)
      expect(markup).toContain('Craft a skill from a detected pattern')
      expect(markup).not.toContain('What should we work on?')
      expect(title).toBeLessThan(markup.indexOf('aria-label="Send"'))
    } finally {
      registry.dispose()
    }
  })

  it('seeds the composer from a Coach starter without sending it', () => {
    const registry = AtomRegistry.make()
    const onStarted = vi.fn()
    let welcome: ReactNode = null
    const coach = {
      onStartingChange: () => undefined,
      Welcome: (props: { onSeed: (prompt: string) => void; disabled: boolean }) => {
        welcome = CoachWelcome(props)
        return welcome
      },
    }
    try {
      render(registry, createElement(WorkspaceNewChat, { projectId: null, onStarted, coach }))
      const starters = starterButtons(welcome)
      expect(starters.map(button => button.props.children)).toEqual(STARTER_PROMPTS)
      expect(starters.every(button => !button.props.disabled)).toBe(true)
      starters[0]?.props.onClick?.()
      expect(registry.get(coachNewChatDraftAtom)).toBe(STARTER_PROMPTS[0])
      expect(onStarted).not.toHaveBeenCalled()
    } finally {
      registry.dispose()
    }
  })

  it('shows no Coach welcome in the Workspace new chat', () => {
    const registry = AtomRegistry.make()
    try {
      const markup = render(registry, createElement(WorkspaceNewChat, { projectId: null, onStarted: () => undefined }))
      expect(markup).toContain('What should we work on?')
      expect(markup).not.toMatch(/<h2[^>]*>Coach &amp; Skills<\/h2>/)
      expect(markup).not.toContain('Ask the harness for guidance')
      expect(markup).not.toContain('Craft a skill from a detected pattern')
      for (const prompt of STARTER_PROMPTS) expect(markup).not.toContain(prompt)
    } finally {
      registry.dispose()
    }
  })

  it('offers Save beside Copy for a completed Coach answer and passes the original markdown to the native dialog', async () => {
    const registry = AtomRegistry.make()
    const markdown = '---\nname: data-fetch\n---\n# Data fetch'
    const entry: ConversationAssistantTurn = {
      kind: 'assistant',
      id: 'answer',
      runId: 'run' as never,
      generation: 1,
      nativeTurnId: null,
      sequence: 1,
      occurredAt: now,
      audit: [],
      blocks: [{ kind: 'text', text: markdown, itemId: null, sequence: 1 }],
      run: {
        runId: 'run' as never,
        generation: 1,
        status: 'completed',
        startedAt: now,
        observedAt: now,
        settledAt: now,
        pendingRequestKind: null,
        lastOutput: 'text',
      },
    }
    try {
      const workspace = render(registry, createElement(AssistantTurnEnd, { entry }))
      expect(workspace).toContain('Copy response')
      expect(workspace).not.toContain('Save…')
      const coach = render(
        registry,
        createElement(AssistantTurnEnd, {
          entry,
          assistantAction: text => createElement(SaveSkillButton, { markdown: text }),
        }),
      )
      expect(coach).toContain('Copy response')
      expect(coach).toContain('Save…')
      await userActions.click.get('Save…')?.()
      expect(userActions.save).toHaveBeenCalledExactlyOnceWith({ payload: { name: 'data-fetch', content: markdown } })
    } finally {
      registry.dispose()
    }
  })
})
