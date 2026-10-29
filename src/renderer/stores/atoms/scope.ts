import * as Atom from 'effect/reactivity/Atom'

import type { OverviewPeriod, OverviewScope } from '@/shared/schemas/overview.js'
import type { DateRange } from '@/shared/schemas/renderer.js'

export const periodAtom = Atom.keepAlive(Atom.make<OverviewPeriod>('today'))
export const customRangeAtom = Atom.keepAlive(Atom.make<DateRange | null>(null))
export const providerAtom = Atom.keepAlive(Atom.make('all'))

export const overviewScopeAtom = Atom.make<OverviewScope>(get => {
  const provider = get(providerAtom)
  const range = get(customRangeAtom)
  return {
    period: get(periodAtom),
    ...(provider === 'all' ? {} : { provider }),
    ...(range === null ? {} : { range }),
  }
})

export const setPeriodAtom = Atom.writable(
  get => get(periodAtom),
  (context, period: OverviewPeriod) => {
    context.set(periodAtom, period)
    context.set(customRangeAtom, null)
  },
)

export const setCustomRangeAtom = Atom.writable(
  get => get(customRangeAtom),
  (context, range: DateRange | null) => context.set(customRangeAtom, range),
)

export const setProviderAtom = Atom.writable(
  get => get(providerAtom),
  (context, provider: string) => context.set(providerAtom, provider),
)
