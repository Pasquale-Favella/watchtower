import { useAtomValue } from '@effect/atom-react'

import { activeCurrencyAtom } from '@/renderer/features/settings/atoms'

import { formatConverted, formatUsd } from '@/renderer/shared/lib/currency'

/** Reactive display helpers; changing currency repaints views without reloading USD analytics. */
export function useCurrencyFormatter() {
  const currency = useAtomValue(activeCurrencyAtom)
  return {
    currency,
    formatUsd: (amount: number) => formatUsd(amount, currency),
    formatConverted: (amount: number) => formatConverted(amount, currency),
  }
}
