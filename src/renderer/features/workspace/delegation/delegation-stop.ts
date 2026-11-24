export interface StopDelegationCommand {
  readonly commandId: string
  readonly delegationId: string
}

/**
 * One stop request per click. A Delegated Task that already has a stop in flight ignores further clicks,
 * so a double click cannot send two cancel commands.
 */
export class DelegationStopGuard {
  private readonly inFlight = new Set<string>()

  isPending(delegationId: string): boolean {
    return this.inFlight.has(delegationId)
  }

  async stop(
    delegationId: string,
    send: (command: StopDelegationCommand) => Promise<unknown>,
    newCommandId: () => string = () => crypto.randomUUID(),
  ): Promise<'sent' | 'skipped'> {
    if (this.inFlight.has(delegationId)) return 'skipped'
    this.inFlight.add(delegationId)
    try {
      await send({ commandId: newCommandId(), delegationId })
      return 'sent'
    } finally {
      this.inFlight.delete(delegationId)
    }
  }
}
