import { useAtomSet } from '@effect/atom-react'
import { useEffect, useRef, useState } from 'react'

import { openExternalAtom } from '@/renderer/shared/lib/native-capabilities.js'

import { useWorkspaceOperation } from '../use-workspace-operation.js'
import type { WorkspaceOperation } from '../workspace-operation.js'
import {
  pullRequestChecksAtom,
  pullRequestCommandAtom,
  pullRequestCreateAtom,
  pullRequestDetailAtom,
  pullRequestDiffAtom,
  pullRequestListAtom,
  pullRequestThreadsAtom,
} from './atoms.js'
import type { PullRequestCommand, PullRequestInput } from './lib.js'

interface QueryState<A> {
  readonly key: string
  readonly data: A | null
  readonly error: string | null
}

function usePullRequestQuery<Input, Value, Error>(
  atom: WorkspaceOperation<Input, Value, Error>,
  request: Input | null,
  revision: number,
) {
  const execute = useWorkspaceOperation(atom)
  const latest = useRef({ execute, request })
  useEffect(() => {
    latest.current = { execute, request }
  })
  const [settled, setSettled] = useState<QueryState<Value> | null>(null)
  const key = request === null ? null : JSON.stringify(request)
  useEffect(() => {
    if (key === null || latest.current.request === null) return
    let active = true
    latest.current.execute(latest.current.request).then(
      data => {
        if (active) setSettled({ key, data, error: null })
      },
      cause => {
        if (active)
          setSettled({
            key,
            data: null,
            error: cause instanceof Error ? cause.message : 'Could not read pull requests.',
          })
      },
    )
    return () => {
      active = false
    }
  }, [key, revision])
  if (key === null || settled?.key !== key) return { data: null, error: null, loading: key !== null }
  return { data: settled.data, error: settled.error, loading: false }
}

export const usePullRequestList = (request: PullRequestInput<'pull-requests:list'> | null, revision: number) =>
  usePullRequestQuery(pullRequestListAtom, request, revision)
export const usePullRequestDetail = (request: PullRequestInput<'pull-requests:detail'> | null, revision: number) =>
  usePullRequestQuery(pullRequestDetailAtom, request, revision)
export const usePullRequestChecks = (request: PullRequestInput<'pull-requests:checks'> | null, revision: number) =>
  usePullRequestQuery(pullRequestChecksAtom, request, revision)
export const usePullRequestDiff = (request: PullRequestInput<'pull-requests:diff'> | null, revision: number) =>
  usePullRequestQuery(pullRequestDiffAtom, request, revision)
export const usePullRequestThreads = (request: PullRequestInput<'pull-requests:threads'> | null, revision: number) =>
  usePullRequestQuery(pullRequestThreadsAtom, request, revision)

export function usePullRequestCommands() {
  const executeCommand = useWorkspaceOperation(pullRequestCommandAtom)
  const createCommand = useWorkspaceOperation(pullRequestCreateAtom)
  const openExternal = useAtomSet(openExternalAtom, { mode: 'promise' })
  const lock = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function perform<A>(operation: () => Promise<A>): Promise<{ readonly value: A } | null> {
    if (lock.current) return null
    lock.current = true
    setPending(true)
    setError(null)
    try {
      return { value: await operation() }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The pull request operation could not be confirmed. Refresh before retrying.',
      )
      return null
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  return {
    pending,
    error,
    execute: async (command: PullRequestCommand) => (await perform(() => executeCommand(command))) !== null,
    create: async (request: PullRequestInput<'pull-requests:create'>) =>
      (await perform(() => createCommand(request)))?.value ?? null,
    openExternal: (url: string) => {
      void openExternal(url).catch(() => setError('Could not open this link.'))
    },
  }
}

export function usePullRequestRefresh(visible: boolean) {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!visible) return
    const refresh = () => {
      if (document.visibilityState !== 'hidden') setRevision(value => value + 1)
    }
    const interval = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [visible])
  return { revision, refresh: () => setRevision(value => value + 1) }
}
