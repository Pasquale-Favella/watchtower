import type { ReactNode } from 'react'

import { ReviewOwnerContext } from './review-context.js'

export function ReviewCommentsProvider({
  ownerKey,
  children,
}: {
  readonly ownerKey: string
  readonly children: ReactNode
}): React.JSX.Element {
  return <ReviewOwnerContext.Provider value={ownerKey}>{children}</ReviewOwnerContext.Provider>
}
