/**
 * Spawn-context parsing for the `watchtower-ledger` MCP server entry: the
 * main process bakes `{ dbPath }` (stdio) or `{ dbPath, token }` (HTTP) into
 * `WATCHTOWER_LEDGER_MCP`, and the plain-node child validates it back out.
 * One module so the stdio and HTTP entry paths share the parse + `dbPath`
 * check instead of each repeating it. Electron-free like its importer.
 */

export interface LedgerMcpContext {
  dbPath: string
}

export interface LedgerMcpHttpContext {
  dbPath: string
  token: string
}

interface LedgerMcpSpawnEnv {
  dbPath?: unknown
  token?: unknown
}

function parseSpawnEnv(): LedgerMcpSpawnEnv {
  const raw: unknown = JSON.parse(process.env['WATCHTOWER_LEDGER_MCP'] ?? '')
  return raw as LedgerMcpSpawnEnv
}

function readDbPath(parsed: LedgerMcpSpawnEnv): string {
  if (typeof parsed?.dbPath !== 'string' || parsed.dbPath.length === 0) {
    throw new Error('context must carry dbPath')
  }
  return parsed.dbPath
}

export function readContext(): LedgerMcpContext {
  return { dbPath: readDbPath(parseSpawnEnv()) }
}

export function readHttpContext(): LedgerMcpHttpContext {
  const parsed = parseSpawnEnv()
  const dbPath = readDbPath(parsed)
  const token = parsed?.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('context must carry token')
  }
  return { dbPath, token }
}
