import { useAtomSet } from '@effect/atom-react'
import { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Schema from 'effect/Schema'
import { useEffect, useRef, useState } from 'react'

import { CheckoutInspectionRpcError } from '@/shared/rpc/checkout-inspection.js'
import type {
  CheckoutBranchList,
  CheckoutScope,
  DiffSource,
  DiffSourceSelector,
  DirectoryListing,
  FileContent,
  FilePatch,
} from '@/shared/schemas/checkout-inspection.js'

import {
  checkoutBranchesAtom,
  checkoutDiffPreviewAtom,
  checkoutFilePatchAtom,
  checkoutListEntriesAtom,
  checkoutReadFileAtom,
} from './checkout-inspection-atoms.js'

export interface InspectionFailure {
  /** The RPC failure code, or null for transport and unexpected failures. */
  readonly code: string | null
  readonly message: string
}

export interface InspectionState<Value> {
  readonly data: Value | null
  readonly error: InspectionFailure | null
  /** True until the first result for this request arrives. Revalidation keeps the previous data visible. */
  readonly loading: boolean
}

export function describeInspectionFailure(error: unknown): InspectionFailure {
  if (Schema.is(CheckoutInspectionRpcError)(error)) return { code: error.code, message: error.message }
  if (error instanceof RpcClientError)
    return { code: null, message: 'Application connection unavailable. Reconnecting.' }
  return { code: null, message: 'Unable to inspect the checkout. Try again.' }
}

interface Settled<Value> {
  readonly identity: string
  readonly data: Value | null
  readonly error: InspectionFailure | null
}

/**
 * Loads one request identity. `revision` changes re-run the load for the same identity while the
 * previous result stays on screen, so a focus refresh does not blank the panel.
 */
function useInspectionQuery<Value>(
  identity: string | null,
  revision: number,
  load: () => Promise<Value>,
): InspectionState<Value> {
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  const [settled, setSettled] = useState<Settled<Value> | null>(null)
  useEffect(() => {
    if (identity === null) return
    let active = true
    loadRef.current().then(
      data => {
        if (active) setSettled({ identity, data, error: null })
      },
      error => {
        if (active) setSettled({ identity, data: null, error: describeInspectionFailure(error) })
      },
    )
    return () => {
      active = false
    }
  }, [identity, revision])
  if (identity === null) return { data: null, error: null, loading: false }
  if (settled === null || settled.identity !== identity) return { data: null, error: null, loading: true }
  return { data: settled.data, error: settled.error, loading: false }
}

export function useCheckoutDiffPreview(
  scope: CheckoutScope,
  source: DiffSourceSelector,
  revision: number,
): InspectionState<DiffSource> {
  const execute = useAtomSet(checkoutDiffPreviewAtom, { mode: 'promise' })
  const identity = JSON.stringify(['diff', scope, source])
  return useInspectionQuery(identity, revision, () => execute({ ...scope, source }))
}

export interface FilePatchTarget {
  readonly source: DiffSourceSelector
  readonly path: string
  readonly previousPath?: string | undefined
}

export function useCheckoutFilePatch(
  scope: CheckoutScope,
  target: FilePatchTarget | null,
  revision: number,
): InspectionState<FilePatch> {
  const execute = useAtomSet(checkoutFilePatchAtom, { mode: 'promise' })
  const identity = target === null ? null : JSON.stringify(['patch', scope, target])
  return useInspectionQuery(identity, revision, () => {
    if (target === null) return Promise.reject(new Error('No file selected'))
    return execute({ ...scope, ...target })
  })
}

export function useCheckoutBranches(
  scope: CheckoutScope,
  enabled: boolean,
  revision: number,
): InspectionState<CheckoutBranchList> {
  const execute = useAtomSet(checkoutBranchesAtom, { mode: 'promise' })
  const identity = enabled ? JSON.stringify(['branches', scope]) : null
  return useInspectionQuery(identity, revision, () => execute(scope))
}

export function useCheckoutDirectory(
  scope: CheckoutScope,
  path: string,
  revision: number,
): InspectionState<DirectoryListing> {
  const execute = useAtomSet(checkoutListEntriesAtom, { mode: 'promise' })
  const identity = JSON.stringify(['directory', scope, path])
  return useInspectionQuery(identity, revision, () => execute({ ...scope, path }))
}

export function useCheckoutFileContent(
  scope: CheckoutScope,
  path: string | null,
  revision: number,
): InspectionState<FileContent> {
  const execute = useAtomSet(checkoutReadFileAtom, { mode: 'promise' })
  const identity = path === null ? null : JSON.stringify(['file', scope, path])
  return useInspectionQuery(identity, revision, () => {
    if (path === null) return Promise.reject(new Error('No file selected'))
    return execute({ ...scope, path })
  })
}
