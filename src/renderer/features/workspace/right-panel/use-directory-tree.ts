import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { CheckoutScope, DirectoryListing } from '@/shared/schemas/checkout-inspection.js'

import { useWorkspaceOperation } from '../use-workspace-operation.js'
import { checkoutListEntriesAtom } from './checkout-inspection-atoms.js'

interface QueuedDirectoryLoad {
  readonly run: () => Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

/** Expanding a large tree never starts every filesystem request at once. */
export class DirectoryLoadQueue {
  private readonly waiting: QueuedDirectoryLoad[] = []
  private active = 0
  private closed = false

  constructor(private readonly concurrency = 4) {}

  run(work: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.waiting.push({ run: work, resolve, reject })
      this.drain()
    })
  }

  close(): void {
    this.closed = true
    for (const pending of this.waiting.splice(0)) pending.resolve()
  }

  private drain(): void {
    while (!this.closed && this.active < this.concurrency) {
      const pending = this.waiting.shift()
      if (!pending) return
      this.active++
      void pending
        .run()
        .then(pending.resolve, pending.reject)
        .finally(() => {
          this.active--
          this.drain()
        })
    }
  }
}

interface DirectoryOwner {
  readonly identity: string
  readonly requests: Map<string, Promise<void>>
  epoch: number
}

interface DirectoryState {
  readonly owner: DirectoryOwner
  readonly error: string | null
  readonly pending: number
}

/** Shares an in-flight directory read across explorers in the same window registry. */
export class DirectoryRequestCoordinator {
  private readonly requests = new Map<string, Promise<void>>()
  private readonly generations = new Map<string, number | symbol | undefined>()
  private readonly refreshes = new Map<string, Promise<void>>()
  private closed = false

  isClosed(): boolean {
    return this.closed
  }

  close(): void {
    this.closed = true
    this.requests.clear()
    this.generations.clear()
    this.refreshes.clear()
  }

  get(key: string): Promise<void> | undefined {
    return this.requests.get(key)
  }

  run(key: string, work: () => Promise<void>, generation?: number | symbol): Promise<void> {
    if (this.closed) return Promise.resolve()
    const existing = this.requests.get(key)
    if (existing) {
      if (generation === undefined || this.generations.get(key) === generation) return existing
      const refresh = this.refreshes.get(key)
      if (refresh) return refresh
      const start = () => {
        this.refreshes.delete(key)
        return this.run(key, work, generation)
      }
      const next = existing.then(start, start)
      this.refreshes.set(key, next)
      return next
    }
    const request = work().finally(() => {
      if (this.requests.get(key) === request) {
        this.requests.delete(key)
        this.generations.delete(key)
      }
    })
    this.requests.set(key, request)
    this.generations.set(key, generation)
    return request
  }
}

type DirectoryCache = ReadonlyMap<string, DirectoryListing>
interface DirectoryTreeState {
  readonly scopeKey: string
  readonly listings: DirectoryCache
  readonly requests: DirectoryRequestCoordinator
  readonly queue: DirectoryLoadQueue
}

type DirectoryTreeStateWrite = { readonly path: string; readonly listing: DirectoryListing }
type DirectoryTreeStateAtom = Atom.Writable<DirectoryTreeState, DirectoryTreeStateWrite>

export function createDirectoryTreeStateAtom(scopeKey: string): DirectoryTreeStateAtom {
  const resources = Atom.keepAlive(
    Atom.make(get => {
      const requests = new DirectoryRequestCoordinator()
      const queue = new DirectoryLoadQueue()
      get.addFinalizer(() => {
        requests.close()
        queue.close()
      })
      return { scopeKey, requests, queue }
    }),
  )
  const listings = Atom.keepAlive(Atom.make<DirectoryCache>(new Map()))
  return Atom.keepAlive(
    Atom.writable(
      get => ({ ...get(resources), listings: get(listings) }),
      (context, update) => {
        const state = context.get(listings)
        const previous = state.get(update.path)
        if (previous && sameListing(previous, update.listing)) return
        const nextListings = new Map(state).set(update.path, update.listing)
        const parent = update.path ? `${update.path}/` : ''
        const directories = new Set(
          update.listing.entries.filter(entry => entry.kind === 'directory').map(entry => entry.path),
        )
        for (const cachedPath of nextListings.keys()) {
          if (!cachedPath.startsWith(parent) || cachedPath === update.path) continue
          const childPath = cachedPath.slice(parent.length).split('/')[0]
          if (childPath && !directories.has(parent ? `${parent}${childPath}` : childPath))
            nextListings.delete(cachedPath)
        }
        context.set(listings, nextListings)
      },
    ),
  )
}

const directoryTreeStateAtom = Atom.family(createDirectoryTreeStateAtom)

function directoryScopeKey(scope: CheckoutScope): string {
  return JSON.stringify([scope.projectId, scope.checkoutId ?? null])
}

function sameListing(left: DirectoryListing, right: DirectoryListing): boolean {
  return (
    left.path === right.path &&
    left.truncated === right.truncated &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => {
      const next = right.entries[index]
      return (
        next !== undefined &&
        entry.name === next.name &&
        entry.path === next.path &&
        entry.kind === next.kind &&
        entry.ignored === next.ignored &&
        entry.size === next.size
      )
    })
  )
}

function reachableListings(listings: ReadonlyMap<string, DirectoryListing>, root: string): ReadonlySet<string> {
  const reachable = new Set<string>()
  const pending = [root]
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined || reachable.has(path)) continue
    reachable.add(path)
    for (const entry of listings.get(path)?.entries ?? []) {
      if (entry.kind === 'directory') pending.push(entry.path)
    }
  }
  return reachable
}

function initialDirectoryState(owner: DirectoryOwner): DirectoryState {
  return { owner, error: null, pending: 0 }
}

/** Lazy listings retain loaded folders and refresh them without blanking the explorer. */
export function useDirectoryTree(scope: CheckoutScope, root: string, revision: number) {
  const registry = useContext(RegistryContext)
  const execute = useWorkspaceOperation(checkoutListEntriesAtom)
  const scopeKey = directoryScopeKey(scope)
  const stateAtom = useMemo(() => directoryTreeStateAtom(scopeKey), [scopeKey])
  const cacheState = useAtomValue(stateAtom)
  const writeListing = useAtomSet(stateAtom)
  const projectId = scope.projectId
  const checkoutId = scope.checkoutId
  const identity = JSON.stringify([projectId, checkoutId ?? null, root])
  const owner = useMemo<DirectoryOwner>(
    () => ({
      identity,
      requests: new Map(),
      epoch: 0,
    }),
    [identity],
  )
  const [settled, setSettled] = useState(() => initialDirectoryState(owner))
  const update = useCallback(
    (change: (state: DirectoryState) => DirectoryState) => {
      setSettled(previous => change(previous.owner === owner ? previous : initialDirectoryState(owner)))
    },
    [owner],
  )
  const load = useCallback(
    (path: string, force = false, generation?: number | symbol): Promise<void> => {
      const key = path
      const current = owner.requests.get(path)
      if (current && !force) return current
      const sharedRequests = registry.get(stateAtom).requests
      const sharedRequest = sharedRequests.get(key)
      if (sharedRequest && !force) return sharedRequest
      if (!force && registry.get(stateAtom).listings.has(key)) return Promise.resolve()
      const epoch = owner.epoch
      update(previous => ({ ...previous, pending: previous.pending + 1 }))
      const request = sharedRequests.run(
        key,
        () =>
          cacheState.queue.run(async () => {
            try {
              const result = await execute({
                projectId,
                ...(checkoutId ? { checkoutId } : {}),
                path,
                includeIgnored: true,
              })
              if (sharedRequests.isClosed()) return
              writeListing({ path, listing: result })
              if (owner.epoch === epoch) update(previous => ({ ...previous, error: null }))
            } catch (cause) {
              if (owner.epoch === epoch)
                update(previous => ({
                  ...previous,
                  error: cause instanceof Error ? cause.message : 'Could not load files.',
                }))
            }
          }),
        generation,
      )
      void request.finally(() => {
        if (owner.requests.get(path) === request) owner.requests.delete(path)
        if (owner.epoch === epoch) update(previous => ({ ...previous, pending: Math.max(0, previous.pending - 1) }))
      })
      owner.requests.set(path, request)
      return request
    },
    [cacheState, checkoutId, execute, owner, projectId, registry, stateAtom, update, writeListing],
  )
  const refresh = useCallback(
    (generation: number | symbol) => {
      const listings = cacheState.listings
      for (const path of reachableListings(listings, root)) {
        if (listings.has(path)) void load(path, true, generation)
      }
      if (!listings.has(root)) void load(root, true, generation)
    },
    [cacheState, load, root],
  )

  useEffect(() => {
    update(previous => ({ ...previous, pending: 0 }))
    return () => {
      owner.epoch++
      owner.requests.clear()
    }
  }, [owner, update])
  const previousRevision = useRef(revision)
  useEffect(() => {
    if (previousRevision.current !== revision) {
      previousRevision.current = revision
      refresh(revision)
    } else if (!cacheState.listings.has(root)) {
      void load(root)
    }
  }, [cacheState, load, refresh, revision, root])

  const state = settled.owner === owner ? settled : initialDirectoryState(owner)
  return {
    listings: cacheState.listings,
    load,
    refresh: () => refresh(Symbol()),
    error: state.error,
    pending: state.pending > 0,
  }
}
