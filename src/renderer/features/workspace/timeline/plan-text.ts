export interface PlanEntry {
  readonly content: string
  readonly status: 'pending' | 'inProgress' | 'completed'
}

export function planCopyText(entries: readonly PlanEntry[], explanation?: string | null): string {
  const steps = entries.map(entry => `${entry.status === 'completed' ? '- [x]' : '- [ ]'} ${entry.content}`).join('\n')
  return [explanation?.trim() ? explanation : '', steps].filter(Boolean).join('\n\n')
}
