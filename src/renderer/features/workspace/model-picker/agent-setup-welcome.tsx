import { WatchtowerGreeting } from '@/renderer/components/shell/WatchtowerGreeting.js'

export function AgentSetupWelcome({ hasConnections }: { readonly hasConnections: boolean }): React.JSX.Element {
  return (
    <div className="bg-muted/40 flex min-w-0 flex-1 flex-col items-center justify-center gap-3 px-8 py-5 text-center">
      <WatchtowerGreeting aria-hidden className="text-primary size-24 shrink-0" />
      <div className="space-y-1.5">
        <h3 className="text-sm font-medium">Let&apos;s set up your agent</h3>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {hasConnections
            ? 'Pick an agent on the left, then choose its model and effort here.'
            : 'Install and sign in to a supported coding agent, then reopen this picker to get started.'}
        </p>
      </div>
    </div>
  )
}
