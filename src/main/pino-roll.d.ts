/**
 * Minimal typings for `pino-roll`: v4 ships no declarations (and DefinitelyTyped
 * has none), so this shim declares the sliver the Operational log sink uses.
 * It must stay visible to BOTH tsconfigs: the web program reaches
 * main/operational-log.ts through the preload's main imports (hence the extra
 * include in tsconfig.web.json) — an incorporates-it-in-the-importer attempt
 * fails with TS2665.
 */
declare module 'pino-roll' {
  export interface PinoRollOptions {
    file: string | (() => string)
    size?: string | number
    mkdir?: boolean
    sync?: boolean
    limit?: { count?: number; removeOtherLogFiles?: boolean }
  }

  export interface RollStream extends NodeJS.WritableStream {
    flush(cb?: (err?: Error) => void): void
    flushSync(): void
    reopen(file: string): void
  }

  export default function build(options?: PinoRollOptions): Promise<RollStream>
}
