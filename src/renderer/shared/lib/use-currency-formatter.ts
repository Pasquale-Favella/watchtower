import { useAtomValue } from '@effect/atom-react'

import { activeCurrencyAtom } from '@/features/settings/atoms'

import { formatConverted, formatUsd } from './currency'

/** Reactive display helpers; changing currency repaints views without reloading USD analytics. */
export function useCurrencyFormatter() {
  const currency = useAtomValue(activeCurrencyAtom)
  return {
    currency,
    formatUsd: (amount: number) => formatUsd(amount, currency),
    formatConverted: (amount: number) => formatConverted(amount, currency),
  }
}
