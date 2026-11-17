export type TerminalEnvironmentSource = Readonly<Record<string, string | undefined>>

/** Electron and Watchtower launch state that a user shell must not inherit. */
const SCRUBBED_NAMES = new Set(['ELECTRON_RUN_AS_NODE', 'TERM', 'COLORTERM'])
const SCRUBBED_PREFIXES = ['ELECTRON_RENDERER_', 'VITE_', 'WATCHTOWER_']

/** Copies the inherited environment without Watchtower-internal entries, then sets the terminal identity. */
export function terminalEnvironment(source: TerminalEnvironmentSource): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (SCRUBBED_NAMES.has(upper) || SCRUBBED_PREFIXES.some(prefix => upper.startsWith(prefix))) continue
    environment[name] = value
  }
  environment.TERM = 'xterm-256color'
  environment.COLORTERM = 'truecolor'
  return environment
}
