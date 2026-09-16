/**
 * Bearer-token helpers for the loopback-HTTP `watchtower-ledger` MCP face:
 * one place builds the `Authorization` header value, one place checks it —
 * so the spawner (`sidecar.ts`), the handler (`http-server.ts`), and the
 * tests can't drift into mismatched `Bearer ...` spellings. Dependency-free
 * so both the main-side spawner and the plain-node server can import it.
 */

export function bearerHeaderValue(token: string): string {
  return `Bearer ${token}`
}

export function hasBearerAuthorization(header: string | undefined, token: string): boolean {
  return header === bearerHeaderValue(token)
}
