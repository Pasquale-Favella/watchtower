import { useSyncExternalStore } from 'react'

/** Shell commands a timeline row sent to an owner's drawer, waiting for a running terminal to receive them. */
const EMPTY: readonly string[] = []
const queues = new Map<string, readonly string[]>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export function queueTerminalCommand(owner: string, command: string): void {
  queues.set(owner, [...(queues.get(owner) ?? EMPTY), command])
  emit()
}

export function takeTerminalCommand(owner: string): void {
  const rest = (queues.get(owner) ?? EMPTY).slice(1)
  if (rest.length === 0) queues.delete(owner)
  else queues.set(owner, rest)
  emit()
}

export function queuedTerminalCommands(owner: string): readonly string[] {
  return queues.get(owner) ?? EMPTY
}

export function subscribeTerminalCommands(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useQueuedTerminalCommands(owner: string): readonly string[] {
  return useSyncExternalStore(subscribeTerminalCommands, () => queuedTerminalCommands(owner))
}
