/** Keeps the most recent terminal output within a byte budget, dropping the oldest chunks first. */
export class TerminalScrollback {
  private chunks: Array<{ readonly data: string; readonly bytes: number }> = []
  private head = 0
  private bytes = 0

  constructor(private readonly capacityBytes: number) {}

  get byteLength(): number {
    return this.bytes
  }

  append(data: string): void {
    if (data.length === 0) return
    let chunk = data
    let size = Buffer.byteLength(chunk, 'utf8')
    if (size > this.capacityBytes) {
      chunk = tailUtf8(chunk, this.capacityBytes)
      size = Buffer.byteLength(chunk, 'utf8')
    }
    this.chunks.push({ data: chunk, bytes: size })
    this.bytes += size
    while (this.bytes > this.capacityBytes && this.head < this.chunks.length - 1) {
      const dropped = this.chunks[this.head]
      if (!dropped) break
      this.bytes -= dropped.bytes
      this.head += 1
    }
    if (this.head > 256 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  snapshot(): string {
    return this.chunks
      .slice(this.head)
      .map(chunk => chunk.data)
      .join('')
  }

  clear(): void {
    this.chunks = []
    this.head = 0
    this.bytes = 0
  }
}

/** The last `capacity` bytes of `text`, starting on a character boundary. */
function tailUtf8(text: string, capacity: number): string {
  const buffer = Buffer.from(text, 'utf8')
  let start = buffer.length - capacity
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}
