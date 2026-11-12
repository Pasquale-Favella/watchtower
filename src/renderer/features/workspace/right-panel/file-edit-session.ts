export interface FileEditState {
  readonly content: string
  readonly savedContent: string
  readonly saving: boolean
  readonly error: string | null
}

export interface FileEditSessionOptions {
  readonly content: string
  readonly revision?: string | undefined
  readonly persist: (content: string, expectedContent: string) => Promise<string | undefined>
  readonly changed: (state: FileEditState) => void
  readonly confirmed?: (() => void) | undefined
  readonly debounceMs?: number
}

/** One ordered save queue per file, shared by all views of that file. */
export class FileEditSession {
  private state: FileEditState
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<boolean> | null = null
  private lastRead: string
  private revision: string | undefined
  private readonly retiredRevisions = new Set<string>()
  private deferredRead: { readonly content: string; readonly revision?: string | undefined } | null = null

  constructor(private readonly options: FileEditSessionOptions) {
    this.state = { content: options.content, savedContent: options.content, saving: false, error: null }
    this.lastRead = options.content
    this.revision = options.revision
  }

  get snapshot(): FileEditState {
    return this.state
  }

  change(content: string): void {
    this.update({ ...this.state, content })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush()
    }, this.options.debounceMs ?? 400)
  }

  /** A refresh never replaces an unconfirmed draft or replays an older read after a save. */
  receive(content: string, revision?: string): void {
    if (revision && (revision === this.revision || this.retiredRevisions.has(revision))) return
    if (!revision && this.lastRead === content) return
    if (this.state.saving) {
      this.deferredRead = { content, revision }
      return
    }
    this.lastRead = content
    this.revision = revision
    if (content === this.state.savedContent) return
    if (this.state.content !== this.state.savedContent) {
      this.update({
        ...this.state,
        error: 'The file changed on disk. Your edits are kept. Reload the file to use the disk version.',
      })
      return
    }
    this.update({ content, savedContent: content, saving: false, error: null })
  }

  reload(content: string, revision?: string): void {
    if (this.state.saving) return
    clearTimeout(this.timer)
    this.lastRead = content
    this.revision = revision
    this.update({ content, savedContent: content, saving: false, error: null })
  }

  flush(): Promise<boolean> {
    clearTimeout(this.timer)
    if (this.pending) return this.pending
    if (this.state.content === this.state.savedContent) return Promise.resolve(true)
    this.pending = this.save().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async save(): Promise<boolean> {
    this.update({ ...this.state, saving: true, error: null })
    while (this.state.content !== this.state.savedContent) {
      const content = this.state.content
      try {
        const revision = await this.options.persist(content, this.state.savedContent)
        if (this.revision) this.retiredRevisions.add(this.revision)
        if (this.retiredRevisions.size > 16) {
          const oldest = this.retiredRevisions.values().next().value
          if (oldest !== undefined) this.retiredRevisions.delete(oldest)
        }
        this.revision = revision || undefined
      } catch (cause) {
        this.update({
          ...this.state,
          saving: false,
          error: cause instanceof Error ? cause.message : 'Could not save this file. Your edits are kept.',
        })
        return false
      }
      this.update({ ...this.state, savedContent: content })
      this.options.confirmed?.()
    }
    this.update({ ...this.state, saving: false })
    const deferred = this.deferredRead
    this.deferredRead = null
    if (deferred) this.receive(deferred.content, deferred.revision)
    return true
  }

  private update(state: FileEditState): void {
    this.state = state
    this.options.changed(state)
  }
}
