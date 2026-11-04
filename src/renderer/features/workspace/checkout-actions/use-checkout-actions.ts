import { useCallback, useEffect, useRef, useState } from 'react'

import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'
import type { CheckoutGitStatus } from '@/shared/schemas/workspace-checkout-actions.js'

import { useWorkspaceOperation } from '../use-workspace-operation.js'
import { checkoutCommitAtom, checkoutStageAtom, checkoutStatusAtom, checkoutUnstageAtom } from './atoms.js'

export function useCheckoutActions(scope: CheckoutScope, revision: number) {
  const readStatus = useWorkspaceOperation(checkoutStatusAtom)
  const stageCommand = useWorkspaceOperation(checkoutStageAtom)
  const unstageCommand = useWorkspaceOperation(checkoutUnstageAtom)
  const commitCommand = useWorkspaceOperation(checkoutCommitAtom)
  const commands = useRef({ readStatus, stageCommand, unstageCommand, commitCommand })
  const [refreshKey, setRefreshKey] = useState(0)
  const [status, setStatus] = useState<{ readonly key: string; readonly data: CheckoutGitStatus } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const scopeKey = JSON.stringify(scope)
  const currentScope = useRef(scope)
  useEffect(() => {
    commands.current = { readStatus, stageCommand, unstageCommand, commitCommand }
    currentScope.current = scope
  })
  useEffect(() => {
    let cancelled = false
    commands.current.readStatus(currentScope.current).then(
      data => {
        if (!cancelled) {
          setStatus({ key: scopeKey, data })
          setError(null)
        }
      },
      cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not read Git status.')
      },
    )
    return () => {
      cancelled = true
    }
  }, [scopeKey, revision, refreshKey])
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setPending(true)
    setError(null)
    try {
      await action()
      setRefreshKey(key => key + 1)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the checkout.')
      return false
    } finally {
      setPending(false)
    }
  }, [])
  return {
    status: status?.key === scopeKey ? status.data : null,
    error,
    pending,
    refresh: () => setRefreshKey(key => key + 1),
    stage: (paths: readonly string[]) => run(() => commands.current.stageCommand({ ...scope, paths })),
    unstage: (paths: readonly string[]) => run(() => commands.current.unstageCommand({ ...scope, paths })),
    commit: (message: string) => run(() => commands.current.commitCommand({ ...scope, message })),
  }
}
