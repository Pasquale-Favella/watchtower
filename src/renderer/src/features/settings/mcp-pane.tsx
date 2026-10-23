import { RegistryContext, useAtomSet } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import { Check, Copy, KeyRound, RotateCcw, Server } from 'lucide-react'
import { type JSX, useContext, useEffect, useRef, useState } from 'react'

import { useRemoteQuery } from '@/app/hooks/use-remote-query'
import { pinWindowAtom } from '@/app/hooks/use-remote-query'
import {
  getMcpConnectionAtom,
  MCP_STATUS_REQUEST,
  mcpStatusQuery,
  regenerateMcpTokenAtom,
  setMcpStartupModeAtom,
} from '@/features/settings/capability-atoms'
import { PaneHeader } from '@/features/settings/pane-parts'
import { Button } from '@/shared/components/ui/button'
import { Card } from '@/shared/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'

import type { LedgerMcpStartupMode } from '../../../../shared/schemas/ledger-mcp.js'

const STARTUP_OPTIONS: Array<{ value: LedgerMcpStartupMode; label: string }> = [
  { value: 'on-demand', label: 'On demand' },
  { value: 'at-launch', label: 'At Watchtower launch' },
]

/** Settings › Local MCP: the app-level loopback HTTP server used by Copilot
 * and explicitly configured local MCP clients. The token is never persisted;
 * copying the config is the explicit action that reveals it to the user. */
export function McpPane(): JSX.Element {
  const registry = useContext(RegistryContext)
  const copiedTimer = useRef<number | undefined>(undefined)
  const { data: status, error: statusError } = useRemoteQuery(mcpStatusQuery, MCP_STATUS_REQUEST, () => 'mcp-status')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setStartupModeCommand = useAtomSet(setMcpStartupModeAtom, { mode: 'promise' })
  const getConnection = useAtomSet(getMcpConnectionAtom, { mode: 'promise' })
  const clearConnection = useAtomSet(getMcpConnectionAtom)
  const regenerateTokenCommand = useAtomSet(regenerateMcpTokenAtom, { mode: 'promise' })

  useEffect(() => {
    pinWindowAtom(registry, setMcpStartupModeAtom)
    pinWindowAtom(registry, regenerateMcpTokenAtom)
    return () => {
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
      clearConnection(Atom.Reset)
    }
  }, [registry, clearConnection])

  const setStartupMode = async (value: string): Promise<void> => {
    const mode = value as LedgerMcpStartupMode
    setBusy(true)
    setError(null)
    try {
      const result = await setStartupModeCommand(mode)
      if (!result.ok) setError(result.message)
    } finally {
      setBusy(false)
    }
  }

  const copyConfig = async (): Promise<void> => {
    setBusy(true)
    setCopied(false)
    setError(null)
    try {
      const result = await getConnection(undefined)
      if (result.ok) {
        try {
          await navigator.clipboard.writeText(result.connection.config)
          setCopied(true)
          if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
          copiedTimer.current = window.setTimeout(() => {
            copiedTimer.current = undefined
            setCopied(false)
          }, 1800)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } else {
        setError(result.message)
      }
    } finally {
      clearConnection(Atom.Reset)
      setBusy(false)
    }
  }

  const regenerateToken = async (): Promise<void> => {
    setBusy(true)
    setCopied(false)
    setError(null)
    try {
      const result = await regenerateTokenCommand(undefined)
      if (!result.ok) setError(result.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-md flex-col gap-3">
      <PaneHeader title="Local MCP" subtitle="Let MCP-compatible apps on this computer read your Watchtower ledger." />

      <Card className="flex flex-col gap-4 px-4 py-4">
        <div className="flex items-start gap-2.5">
          <Server className="text-brand-text mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-foreground text-[12.5px] font-medium">Ledger MCP server</p>
            <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
              The server stays on 127.0.0.1 and is available only while Watchtower is running.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-mcp-startup" className="text-foreground text-[12.5px] font-medium">
            Startup
          </label>
          <p className="text-muted-foreground text-[11px]">
            On demand starts it when Coach or another local app asks for the connection. Launch prewarms it with
            Watchtower.
          </p>
          <Select
            value={status?.startupMode ?? 'on-demand'}
            onValueChange={value => {
              if (value) void setStartupMode(value)
            }}
            disabled={busy}
          >
            <SelectTrigger id="settings-mcp-startup" size="sm" className="mt-1 w-full text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STARTUP_OPTIONS.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <div className="min-w-0">
            <p className="text-foreground text-[11.5px] font-medium">Status</p>
            <p className="text-muted-foreground truncate text-[10.5px]">
              {status?.running ? `Running at ${status.url}` : 'Not running'}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${status?.running ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}
          >
            {status?.running ? 'Running' : 'Stopped'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void copyConfig()}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : 'Copy MCP config'}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void regenerateToken()}>
            <RotateCcw className="size-3.5" />
            Regenerate token
          </Button>
        </div>
        <p className="text-muted-foreground flex items-start gap-1.5 text-[10.5px] leading-snug">
          <KeyRound className="mt-0.5 size-3 shrink-0" />
          The copied config contains a local bearer token. Treat it like a password; regenerating it disconnects
          existing clients.
        </p>
        {(error ?? statusError) && <p className="text-destructive text-[11px]">{error ?? statusError}</p>}
      </Card>
    </div>
  )
}
