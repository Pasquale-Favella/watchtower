import * as Schema from 'effect/Schema'

/** Safe failures exposed by analytics RPC handlers. Keep details independent of
 * storage, filesystem paths, credentials, SQL and runtime stack traces. */
export class AnalyticsRpcError extends Schema.TaggedError<AnalyticsRpcError>()('AnalyticsRpcError', {
  code: Schema.Literals(['invalid-request', 'unavailable', 'query-failed']),
  message: Schema.Literals(['Invalid analytics request', 'Analytics service unavailable', 'Analytics query failed']),
}) {}

/** Safe failures exposed by configuration RPC handlers. */
export class ConfigRpcError extends Schema.TaggedError<ConfigRpcError>()('ConfigRpcError', {
  code: Schema.Literals(['invalid-request', 'unavailable', 'command-failed', 'conflict']),
  message: Schema.Literals([
    'Invalid configuration request',
    'Configuration service unavailable',
    'Configuration command failed',
    'Configuration conflict',
  ]),
}) {}
