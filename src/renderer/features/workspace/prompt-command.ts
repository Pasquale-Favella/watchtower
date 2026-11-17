export type WorkspacePromptCommand =
  | { readonly kind: 'clear' }
  | { readonly kind: 'model'; readonly query: string }
  | { readonly kind: 'side' | 'btw'; readonly prompt: string }
  | { readonly kind: 'native'; readonly name: string; readonly prompt: string }

export interface NativePromptCommand {
  readonly name: string
}

export function activeGoalControl(command: WorkspacePromptCommand | null): 'pause' | 'clear' | null {
  if (command?.kind !== 'native' || command.name.toLocaleLowerCase() !== 'goal') return null
  const match = /^\/goal\s+(pause|clear)$/i.exec(command.prompt.trim())
  const action = match?.[1]?.toLocaleLowerCase()
  if (action === 'pause' || action === 'clear') return action
  return null
}

/** Resolve standalone composer commands before dispatching a prompt to a Harness. */
export function parseWorkspacePromptCommand(
  value: string,
  nativeCommands: readonly NativePromptCommand[],
): WorkspacePromptCommand | null {
  const match = value.trim().match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  const name = match[1].toLocaleLowerCase()
  const prompt = match[2]?.trim() ?? ''
  if (name === 'clear' && !prompt) return { kind: 'clear' }
  if (name === 'model') return { kind: 'model', query: prompt }
  if (name === 'side' || name === 'btw') return { kind: name, prompt }
  const advertised = nativeCommands.find(command => command.name.toLocaleLowerCase() === name)
  return advertised ? { kind: 'native', name: advertised.name, prompt: value.trim() } : null
}
