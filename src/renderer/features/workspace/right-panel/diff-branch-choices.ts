import type { CheckoutBranchList } from '@/shared/schemas/checkout-inspection.js'

export interface DiffBranchChoice {
  readonly label: string
  readonly local: string | null
  readonly remote: string | null
}

export function diffBranchChoices(branches: CheckoutBranchList['items']): readonly DiffBranchChoice[] {
  const choices = new Map<string, DiffBranchChoice>()
  for (const branch of branches) {
    if (branch.kind === 'local') choices.set(branch.name, { label: branch.name, local: branch.name, remote: null })
  }
  for (const branch of branches) {
    if (branch.kind !== 'remote') continue
    const label = branch.name.slice(branch.name.indexOf('/') + 1)
    const existing = choices.get(label)
    if (!existing?.remote) choices.set(label, { label, local: existing?.local ?? null, remote: branch.name })
    else choices.set(branch.name, { label: branch.name, local: null, remote: branch.name })
  }
  return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label))
}
