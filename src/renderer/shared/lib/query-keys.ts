import type { OverviewScope } from '@/shared/schemas/overview.js'

export const keyOfScope = (scope: OverviewScope): string => JSON.stringify(scope)

export interface SessionRequest {
  readonly sessionId: string
  readonly sourceId?: number
}

export const sessionRequestKey = ({ sessionId, sourceId }: SessionRequest): string =>
  JSON.stringify([sessionId, sourceId ?? null])
