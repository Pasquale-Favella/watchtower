export type ProxyPathConfig = {
  readonly paths: readonly string[]
  readonly caseSensitive: boolean
}

export function normalizeProxyPath(path: string, caseSensitive: boolean): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return caseSensitive ? normalized : normalized.toLowerCase()
}

export function isProxiedPath(cwd: string | undefined | null, config: ProxyPathConfig): boolean {
  if (!cwd || typeof cwd !== 'string' || config.paths.length === 0) return false
  const normalized = normalizeProxyPath(cwd, config.caseSensitive)
  if (normalized === '') return false
  return config.paths.some(path => normalized === path || normalized.startsWith(path + '/'))
}
