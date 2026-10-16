import { execFile as nodeExecFile, type ChildProcess, type SpawnOptions, spawn as nodeSpawn } from 'node:child_process'

export interface LoginTerminalDeps {
  platform?: NodeJS.Platform
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  execFile?: typeof nodeExecFile
}

export type LoginTerminalResult = { ok: true } | { ok: false; error: string }

function attachErrorListener(child: ChildProcess): void {
  child.on('error', () => {
    /* A terminal launch failure is returned or ignored, never uncaught. */
  })
}

function launch(
  argv: readonly string[],
  deps: Required<Pick<LoginTerminalDeps, 'platform' | 'spawn' | 'execFile'>>,
): LoginTerminalResult {
  try {
    if (deps.platform === 'win32') {
      const child = deps.spawn('cmd.exe', ['/k', ...argv], { detached: true, stdio: 'ignore', windowsHide: false })
      attachErrorListener(child)
      child.unref()
      return { ok: true }
    }
    if (deps.platform === 'darwin') {
      const script = `tell application "Terminal" to do script "${argv.join(' ')}"`
      const child = deps.execFile('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'])
      attachErrorListener(child)
      return { ok: true }
    }
    const child = deps.spawn('x-terminal-emulator', ['-e', ...argv], { detached: true, stdio: 'ignore' })
    attachErrorListener(child)
    child.unref()
    return { ok: true }
  } catch {
    return { ok: false, error: 'The login terminal could not be opened. Run the harness login command in a terminal.' }
  }
}

export function openLoginTerminal(
  instanceId: string,
  getLoginCommand: (instanceId: string) => readonly string[] | undefined,
  deps: LoginTerminalDeps = {},
): LoginTerminalResult {
  const argv = getLoginCommand(instanceId)
  if (!argv || argv.length === 0) return { ok: false, error: 'No login command is available for this harness.' }
  return launch(argv, {
    platform: deps.platform ?? process.platform,
    spawn: deps.spawn ?? nodeSpawn,
    execFile: deps.execFile ?? nodeExecFile,
  })
}
