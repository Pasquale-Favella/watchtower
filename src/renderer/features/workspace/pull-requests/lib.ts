import type * as Rpc from 'effect/rpc/Rpc'
import type * as RpcGroup from 'effect/rpc/RpcGroup'

import type { WorkspacePullRequestRpcGroup } from '@/shared/rpc/workspace-pull-requests.js'

type Procedures = RpcGroup.Rpcs<typeof WorkspacePullRequestRpcGroup>
export type PullRequestTag = Procedures['_tag']
export type PullRequestInput<Tag extends PullRequestTag> = Rpc.Payload<Rpc.ExtractTag<Procedures, Tag>>
export type PullRequestResult<Tag extends PullRequestTag> = Rpc.Success<Rpc.ExtractTag<Procedures, Tag>>
type CommandTag = Exclude<
  PullRequestTag,
  | 'pull-requests:list'
  | 'pull-requests:detail'
  | 'pull-requests:checks'
  | 'pull-requests:diff'
  | 'pull-requests:threads'
  | 'pull-requests:create'
>
export type PullRequestCommand = {
  [Tag in CommandTag]: { readonly tag: Tag; readonly request: PullRequestInput<Tag> }
}[CommandTag]
