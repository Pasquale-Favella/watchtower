import { fetchPullRequests } from '@/shared/lib/api'
import { createScopedDataStore } from '../../app/stores/data-store'
import type { PullRequestsPayload } from '../../../../shared/schemas/pull-requests.js'

/** Pull-request spend, scope-keyed and refresh-tick subscribed. (map ticket 02) */
export const usePullRequestsStore = createScopedDataStore<PullRequestsPayload>(fetchPullRequests)
