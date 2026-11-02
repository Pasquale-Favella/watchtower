import { FolderKanban } from 'lucide-react'
import { useCallback } from 'react'

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/renderer/components/ui/sidebar'
import type { TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceNavigation } from './use-workspace-navigation.js'
import { WorkspaceProjects } from './WorkspaceProjects.js'

/** Project and Task navigation for the workspace vertical's shared app sidebar. */
export function WorkspaceSidebar() {
  const { navigation, selectProject, selectTask } = useWorkspaceNavigation()
  const { setOpen, setOpenMobile } = useSidebar()
  const selectTaskFromSidebar = useCallback(
    (taskId: TaskId | null) => {
      selectTask(taskId)
      setOpenMobile(false)
    },
    [selectTask, setOpenMobile],
  )

  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>Workspace</SidebarGroupLabel>
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
        <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Projects and Tasks"
              aria-label="Open workspace navigation"
              onClick={() => setOpen(true)}
            >
              <FolderKanban />
              <span>Projects</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="min-h-0 flex-1 overflow-y-auto group-data-[collapsible=icon]:hidden">
          <WorkspaceProjects
            selectedProjectId={navigation.projectId}
            selectedTaskId={navigation.taskId}
            onSelectProject={selectProject}
            onSelectTask={selectTaskFromSidebar}
          />
        </div>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
