import type { IncomingMessage, ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import type { LedgerStore } from '../../store/ledger.js'
import { hasBearerAuthorization } from './auth.js'
import { createLedgerMcpServer } from './server.js'
// Shared seam directly — never the spawner (`sidecar.ts` needs
// `node:child_process`, which the sidecar bundle must not pull in).
import { reportLedgerRequestFailure } from '../../../shared/operational-log.js'

/**
 * The loopback-HTTP face of the `watchtower-ledger` MCP server: the SAME
 * tools/resources/prompts as the stdio entry, served over StreamableHTTP for
 * harnesses that reject client-provided stdio servers (the Copilot CLI drops
 * them outright — `Rejecting non-http/sse MCP server ... from client` — so
 * stdio can never deliver ledger tools there). Stateless: a fresh SDK server
 * per request over the shared read-only store, exactly like the stdio entry
 * serves one protocol stream.
 *
 * Bound to 127.0.0.1 on an ephemeral port by the entry; every route requires
 * the per-spawn bearer token (no ambient authority on the loopback).
 */

/** Tool args are tiny scope objects — 1MB is a generous ceiling that still
 *  bounds a neighbour process stuffing the request pipe. */
const MAX_BODY_BYTES = 1_000_000

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

export function createLedgerMcpHttpHandler(
  store: LedgerStore,
  token: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!hasBearerAuthorization(req.headers.authorization, token)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    let body: unknown
    try {
      body = req.method === 'POST' ? await readJsonBody(req) : undefined
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad request' })
      return
    }
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await createLedgerMcpServer(store).connect(transport)
      await transport.handleRequest(req, res, body)
    } catch {
      // Operational log (ticket #129): method and route only — never bodies,
      // tokens, or ledger facts. Stderr only, so the stdout READY announcement
      // stays parseable under logging load.
      reportLedgerRequestFailure(req.method ?? 'UNKNOWN', pathname, 'internal')
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    }
  }
}
