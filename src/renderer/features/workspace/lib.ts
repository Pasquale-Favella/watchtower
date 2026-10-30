import type * as Rpc from 'effect/rpc/Rpc'
import type * as RpcGroup from 'effect/rpc/RpcGroup'

import type { WorkspaceRpcGroup } from '@/shared/rpc/workspace.js'
import type { WorkspaceConversationPage, WorkspacePayloadPage } from '@/shared/schemas/workspace-store.js'

type WorkspaceRpcs = RpcGroup.Rpcs<typeof WorkspaceRpcGroup>
export type WorkspaceTag = WorkspaceRpcs['_tag']
export type WorkspaceRequest<Tag extends WorkspaceTag> = Rpc.Payload<Rpc.ExtractTag<WorkspaceRpcs, Tag>>
export type WorkspaceResult<Tag extends WorkspaceTag> = Rpc.Success<Rpc.ExtractTag<WorkspaceRpcs, Tag>>
export type WorkspaceCommandInput<Tag extends WorkspaceTag> = Omit<WorkspaceRequest<Tag>, 'commandId'>

export const workspaceQueryKey = (request: unknown): string => JSON.stringify(request)

/** Pin subsequent pages to the first page's watermark; subscribe after that watermark once drained. */
export function nextConversationRequest(
  request: WorkspaceRequest<'workspace:readConversationPage'>,
  page: WorkspaceConversationPage,
): WorkspaceRequest<'workspace:readConversationPage'> | null {
  if (!page.hasMore || page.nextAfterSequence === null) return null
  return {
    ...request,
    afterSequence: page.nextAfterSequence,
    throughSequence: request.throughSequence ?? page.highWatermark,
  }
}

export function nextPayloadRequest(
  request: WorkspaceRequest<'workspace:readWorkspacePayload'>,
  page: WorkspacePayloadPage,
): WorkspaceRequest<'workspace:readWorkspacePayload'> | null {
  return page.nextAfterOffset === null ? null : { ...request, afterOffset: page.nextAfterOffset }
}
