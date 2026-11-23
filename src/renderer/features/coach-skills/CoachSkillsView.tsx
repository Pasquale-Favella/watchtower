import { useMemo, useState } from 'react'

import { LoadingRegion, SkeletonLines } from '@/renderer/components/skeletons.js'
import { Button } from '@/renderer/components/ui/button.js'
import { TextTooltip } from '@/renderer/components/ui/tooltip.js'
import {
  useWorkspaceConnectionCatalog,
  useWorkspaceConnections,
} from '@/renderer/features/workspace/connection-hooks.js'
import { connectionDetail, connectionStatus } from '@/renderer/features/workspace/model-picker/catalog.js'
import { WorkspaceChatColumn } from '@/renderer/features/workspace/WorkspaceChatColumn.js'
import { WorkspaceNewChat } from '@/renderer/features/workspace/WorkspaceNewChat.js'

import { useCoachChat, useCoachChatStarting, useDiscardCoachChat, useSetCoachChatStarting } from './coach-chat-hooks.js'
import { HarnessStatusDot } from './harness-status.js'
import { statusLabel } from './lib.js'
import { SaveSkillButton } from './SaveSkillButton.js'
import { SuggestedSkillChips } from './SuggestedSkillChips.js'

function renderAssistantAction(markdown: string) {
  return <SaveSkillButton markdown={markdown} />
}

function renderSuggestedPrompts(onSeed: (prompt: string) => void, disabled: boolean) {
  return <SuggestedSkillChips onSeed={onSeed} disabled={disabled} />
}

export function CoachSkillsView(): React.JSX.Element {
  const { chat, reload } = useCoachChat()
  const { discard, discarding } = useDiscardCoachChat()
  const starting = useCoachChatStarting()
  const setStarting = useSetCoachChatStarting()
  const [connectionId, setConnectionId] = useState('')
  const activeChat = chat.data

  const composer = useMemo(
    () => ({
      assistantAction: renderAssistantAction,
      onConnectionChange: setConnectionId,
      onStartingChange: setStarting,
      suggestedPrompts: renderSuggestedPrompts,
    }),
    [setStarting],
  )

  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden" aria-label="Coach & Skills">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Coach &amp; Skills</h1>
        <CoachConnectionStatus connectionId={connectionId} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!activeChat || discarding || starting}
          onClick={() => activeChat && void discard(activeChat.taskId)}
        >
          New chat
        </Button>
      </header>
      {activeChat ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" inert={discarding}>
          <WorkspaceChatColumn
            key={activeChat.taskId}
            taskId={activeChat.taskId}
            selectedConversationId={activeChat.conversationId}
            coach={composer}
          />
        </div>
      ) : chat.error ? (
        <div className="m-4 space-y-2" role="alert">
          <p>{chat.error}</p>
          <Button type="button" variant="outline" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : chat.status === 'loading' ? (
        <LoadingRegion label="Loading chat…" className="max-w-chat mx-auto flex w-full flex-col gap-4 p-4">
          <SkeletonLines lines={4} />
        </LoadingRegion>
      ) : (
        <WorkspaceNewChat projectId={null} onStarted={reload} coach={composer} />
      )}
    </section>
  )
}

function CoachConnectionStatus({ connectionId }: { readonly connectionId: string }): React.JSX.Element {
  const connections = useWorkspaceConnections()
  const reading = useWorkspaceConnectionCatalog(connectionId)
  const connection = connections.data?.items.find(item => item.connectionId === connectionId)
  const className = 'text-muted-foreground flex min-w-0 items-center gap-1.5 truncate text-xs'
  if (!connection) {
    return (
      <span className={className} role="status">
        {connections.status === 'loading'
          ? 'Checking connections…'
          : connections.data?.items.length
            ? 'Choose an agent'
            : 'No agent detected'}
      </span>
    )
  }
  const status = connectionStatus(reading)
  return (
    <TextTooltip
      label={connectionDetail(reading) ?? statusLabel(status)}
      trigger={
        <span className={className} role="status">
          <HarnessStatusDot status={status} />
          <span className="truncate">{connection.label}</span>
          <span className="sr-only">{statusLabel(status)}</span>
        </span>
      }
    />
  )
}
