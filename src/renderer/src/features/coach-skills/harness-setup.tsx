import { useState } from 'react'
import { Check, Clipboard, ExternalLink, RefreshCw } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/shared/lib/utils'
import { openCoachLoginTerminal } from '@/shared/lib/api'
import { useCoachSkillsStore } from './store'
import { HarnessStatusDot } from './harness-status'
import { statusLabel } from './lib'
import type { CoachHarnessRow } from '../../../../shared/schemas/agents.js'

export function HarnessSetup({ row, compact = false }: { row: CoachHarnessRow; compact?: boolean }) {
  const refreshHarnesses = useCoachSkillsStore(s => s.refreshHarnesses)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const copy = async (): Promise<void> => {
    if (!row.auth.loginCommand) return
    try {
      await navigator.clipboard.writeText(row.auth.loginCommand)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not copy the login command.')
    }
  }

  const openTerminal = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await openCoachLoginTerminal(row.instanceId)
    setBusy(false)
    if (!result.ok) setError(result.error)
  }

  const recheck = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    await refreshHarnesses()
    setBusy(false)
  }

  return (
    <div className={cn('flex flex-col gap-2 text-[11px]', compact ? 'py-1' : 'rounded-md border border-border/70 bg-card p-3')}>
      {!compact && (
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <HarnessStatusDot status={row.status} />
          {statusLabel(row.status)}
        </div>
      )}
      <p className="text-muted-foreground">{row.status === 'pending' ? 'Checking…' : row.message ?? 'Setup required before this harness can run.'}</p>
      {row.auth.loginCommand ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="min-w-0 max-w-full truncate rounded bg-muted px-1.5 py-1 font-mono text-[10px] text-foreground">{row.auth.loginCommand}</code>
          <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} className="h-6 gap-1 px-1.5 text-[10px]" title="Copy login command">
            {copied ? <Check className="size-3" /> : <Clipboard className="size-3" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void openTerminal()} disabled={busy || row.status === 'pending'} className="h-6 gap-1 px-1.5 text-[10px]">
            <ExternalLink className="size-3" />
            Open terminal
          </Button>
        </div>
      ) : row.status !== 'pending' ? (
        <p className="text-muted-foreground">Sign in with {row.displayName}'s own CLI, then re-check.</p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => void recheck()} disabled={busy} className="h-6 gap-1 px-1.5 text-[10px]">
          <RefreshCw className={cn('size-3', busy && 'animate-spin')} />
          Re-check
        </Button>
        {error && <span className="text-[10px] text-destructive">{error}</span>}
      </div>
    </div>
  )
}