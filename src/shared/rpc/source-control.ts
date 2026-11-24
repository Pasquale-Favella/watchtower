import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

/** GitHub CLI state: absent, installed but signed out, or signed in. */
export const githubCliStateSchema = Schema.Literals(['ready', 'unauthenticated', 'unavailable'])
export type GitHubCliState = Schema.Schema.Type<typeof githubCliStateSchema>

/** What this computer offers for source control. Read-only: nothing is installed, signed in or changed. */
export const sourceControlDiscoverySchema = Schema.Struct({
  git: Schema.Struct({ available: Schema.Boolean, version: Schema.NullOr(Schema.String) }),
  github: Schema.Struct({
    cli: githubCliStateSchema,
    /** The gh CLI version when it runs, whether or not it is signed in. */
    version: Schema.NullOr(Schema.String),
    /** The signed-in account name. It is shown only on request and never logged. */
    account: Schema.NullOr(Schema.String),
  }),
})
export type SourceControlDiscovery = Schema.Schema.Type<typeof sourceControlDiscoverySchema>

export class SourceControlRpcError extends Schema.TaggedError<SourceControlRpcError>()('SourceControlRpcError', {
  code: Schema.Literals(['unavailable']),
  message: Schema.Literals(['Source control discovery is unavailable.']),
}) {}

export const SourceControlRpcGroup = RpcGroup.make(
  Rpc.make('sourceControl:discover', {
    payload: Schema.Struct({}),
    success: sourceControlDiscoverySchema,
    error: SourceControlRpcError,
  }),
)
