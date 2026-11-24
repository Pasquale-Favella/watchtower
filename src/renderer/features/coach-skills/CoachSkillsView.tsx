import { useMemo, useState } from 'react'

import { LoadingRegion, SkeletonLines } from '@/renderer/components/skeletons.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog.js'
import { Button } from '@/renderer/components/ui/button.js'
import { WorkspaceChatColumn } from '@/renderer/features/workspace/WorkspaceChatColumn.js'
import { WorkspaceNewChat } from '@/renderer/features/workspace/WorkspaceNewChat.js'

import { useCoachChat, useCoachChatStarting, useDiscardCoachChat, useSetCoachChatStarting } from './coach-chat-hooks.js'
import { CoachWelcome } from './CoachWelcome.js'
import { SaveSkillButton } from './SaveSkillButton.js'

function renderAssistantAction(markdown: string) {
  return <SaveSkillButton markdown={markdown} />
}

export function CoachSkillsView(): React.JSX.Element {
  const { chat, reload } = useCoachChat()
  const { discard, discarding } = useDiscardCoachChat()
  const starting = useCoachChatStarting()
  const setStarting = useSetCoachChatStarting()
  const [confirmingNewChat, setConfirmingNewChat] = useState(false)
  const activeChat = chat.data

  const composer = useMemo(
    () => ({
      assistantAction: renderAssistantAction,
      onStartingChange: setStarting,
      Welcome: CoachWelcome,
    }),
    [setStarting],
  )

  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden" aria-label="Coach & Skills">
      {activeChat ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" inert={discarding}>
          {/* The section title lives in the top bar, so an active chat only carries a quiet New chat action. */}
          <div className="flex shrink-0 justify-end px-3 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={discarding || starting}
              onClick={() => setConfirmingNewChat(true)}
              className="text-foreground h-7 gap-1.5 text-[11.5px] font-medium"
            >
              New chat
            </Button>
          </div>
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
      <AlertDialog open={confirmingNewChat} onOpenChange={setConfirmingNewChat}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new chat?</AlertDialogTitle>
            <AlertDialogDescription>
              The current coaching chat is discarded and can&apos;t be recovered. A running reply is stopped first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmingNewChat(false)
                if (activeChat) void discard(activeChat.taskId)
              }}
            >
              Discard and start new
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
