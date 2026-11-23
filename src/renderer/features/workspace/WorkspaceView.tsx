import { useWorkspaceNavigation } from './use-workspace-navigation.js'
import { WorkspaceChatColumn } from './WorkspaceChatColumn.js'
import { WorkspaceNewChat } from './WorkspaceNewChat.js'
import { WorkspaceProjectDialog } from './WorkspaceProjectDialog.js'

export function WorkspaceView() {
  const { navigation, selectProject, selectTask, selectConversation } = useWorkspaceNavigation()

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Agent workspace">
      <WorkspaceProjectDialog />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Selected task">
        {navigation.taskId ? (
          <WorkspaceChatColumn
            key={navigation.taskId}
            taskId={navigation.taskId}
            selectedConversationId={navigation.conversationId}
            onSelectTask={selectTask}
            onSelectConversation={selectConversation}
          />
        ) : (
          <WorkspaceNewChat
            projectId={navigation.projectId}
            onProjectChange={selectProject}
            onStarted={(projectId, taskId, conversationId) => {
              selectProject(projectId)
              selectTask(taskId)
              selectConversation(conversationId)
            }}
          />
        )}
      </section>
    </main>
  )
}
