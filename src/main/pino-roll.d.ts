/**
 * Minimal typings for `pino-roll` (v4 ships no declarations). Covers only the
 * options this repo's Operational log sink uses; anything else passes through
 * the index signature to the builder untouched.
 */
declare module 'pino-roll' {
  export interface PinoRollOptions {
    file: string | (() => string)
    size?: string | number
    frequency?: string | number
    extension?: string
    symlink?: boolean
    dateFormat?: string
    mkdir?: boolean
    sync?: boolean
    limit?: { count?: number; removeOtherLogFiles?: boolean }
    [key: string]: unknown
  }

  export interface RollStream extends NodeJS.WritableStream {
    flush(cb?: (err?: Error) => void): void
    flushSync(): void
    reopen(file: string): void
  }

  export default function build(options?: PinoRollOptions): Promise<RollStream>
}
