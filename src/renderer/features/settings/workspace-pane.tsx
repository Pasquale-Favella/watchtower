import { QueryErrorNotice } from '@/renderer/components/QueryErrorNotice'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select'
import { useWorkspaceAgentPreferences } from '@/renderer/features/workspace/agent-preferences'
import { useWorkspaceConnections } from '@/renderer/features/workspace/connection-hooks'
import { accessModeConfig, resolveAccessMode } from '@/renderer/features/workspace/model-picker/access-mode'
import type { AgentAccessMode } from '@/shared/schemas/execution.js'

const NO_DEFAULT_CONNECTION = 'no-default-connection'

/** Settings › Workspace: defaults used when starting new Workspace conversations. */
export function WorkspacePane(): React.JSX.Element {
  const preferences = useWorkspaceAgentPreferences()
  const connectionsQuery = useWorkspaceConnections()
  const connections = connectionsQuery.data?.items ?? []
  const access = resolveAccessMode(preferences.accessMode, undefined)
  const selectedConnectionExists = connections.some(connection => connection.connectionId === preferences.connectionId)
  const connectionValue = preferences.connectionId || NO_DEFAULT_CONNECTION

  return (
    <div className="flex max-w-md flex-col gap-5">
      <QueryErrorNotice error={connectionsQuery.error} hasData={connectionsQuery.data !== null} />

      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.05em] uppercase">New chats</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-workspace-connection" className="text-foreground text-[12.5px] font-medium">
            Default Harness Connection
          </label>
          <p className="text-muted-foreground text-[11px]">
            Choose the Harness Connection to select for new chats. You can change it for each conversation.
          </p>
          <Select
            value={connectionValue}
            disabled={connectionsQuery.status === 'loading'}
            onValueChange={value => {
              if (value) preferences.setConnectionId(value === NO_DEFAULT_CONNECTION ? '' : value)
            }}
          >
            <SelectTrigger id="settings-workspace-connection" size="sm" className="mt-1 w-full text-[12.5px]">
              <SelectValue>
                {connections.find(connection => connection.connectionId === preferences.connectionId)?.label ??
                  (preferences.connectionId ? 'Unavailable connection' : 'Ask each time')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DEFAULT_CONNECTION}>Ask each time</SelectItem>
              {preferences.connectionId && !selectedConnectionExists && (
                <SelectItem value={preferences.connectionId}>Unavailable connection</SelectItem>
              )}
              {connections.map(connection => (
                <SelectItem key={connection.connectionId} value={connection.connectionId}>
                  {connection.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {connections.length === 0 && connectionsQuery.data !== null && (
            <p className="text-muted-foreground text-[10.5px]">
              No Harness Connections are currently detected. Install or configure a supported agent to use it here.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-workspace-access" className="text-foreground text-[12.5px] font-medium">
            Default access mode
          </label>
          <p className="text-muted-foreground text-[11px]">
            Starting access mode for new chats. A Harness Connection may enforce a more limited mode.
          </p>
          <Select
            value={access.mode}
            onValueChange={value => {
              if (value) preferences.setAccessMode(value as AgentAccessMode)
            }}
          >
            <SelectTrigger id="settings-workspace-access" size="sm" className="mt-1 w-full text-[12.5px]">
              <SelectValue>{accessModeConfig[access.mode].label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {access.options.map(option => (
                <SelectItem key={option.mode} value={option.mode}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-[10.5px]">{accessModeConfig[access.mode].description}</p>
        </div>
      </div>
    </div>
  )
}
