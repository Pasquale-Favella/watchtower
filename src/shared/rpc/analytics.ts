import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { comparePairSchema, comparePayloadSchema } from '../schemas/compare.js'
import { modelsPayloadSchema } from '../schemas/models.js'
import { optimizePayloadSchema } from '../schemas/optimize.js'
import { overviewPayloadSchema, overviewScopeSchema } from '../schemas/overview.js'
import { pullRequestsPayloadSchema } from '../schemas/pull-requests.js'
import { skillsPayloadSchema, skillsThresholdsSchema } from '../schemas/skills.js'
import { spendPayloadSchema } from '../schemas/spend.js'
import {
  analyticalViewsSchema,
  dashboardViewsSchema,
  projectRowSchema,
  searchHitSchema,
  sessionDetailRequestSchema,
  sessionDetailSchema,
  sessionRowSchema,
} from '../schemas/views.js'
import { yieldPayloadSchema } from '../schemas/yield.js'
import { AnalyticsRpcError } from './errors.js'

const sessionListFilterSchema = Schema.Struct({
  project: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
})
const compareRequestSchema = Schema.Struct({
  scope: overviewScopeSchema,
  pair: Schema.optional(comparePairSchema),
})
const skillsRequestSchema = Schema.Struct({
  scope: overviewScopeSchema,
  thresholds: Schema.optional(skillsThresholdsSchema),
})
const scopeRequestSchema = Schema.Struct({ scope: overviewScopeSchema })
const queryRequestSchema = Schema.Struct({ query: Schema.String })

/** Renderer analytics calls, retaining the existing channel as each RPC tag. */
export const GetViews = Rpc.make('store:views', {
  success: Schema.NullOr(dashboardViewsSchema),
  error: AnalyticsRpcError,
})
export const GetProjects = Rpc.make('store:projects', {
  success: Schema.mutable(Schema.Array(projectRowSchema)),
  error: AnalyticsRpcError,
})
export const GetSessions = Rpc.make('store:sessions', {
  payload: { filter: Schema.optional(sessionListFilterSchema) },
  success: Schema.mutable(Schema.Array(sessionRowSchema)),
  error: AnalyticsRpcError,
})
export const GetSession = Rpc.make('store:session', {
  payload: sessionDetailRequestSchema,
  success: Schema.NullOr(sessionDetailSchema),
  error: AnalyticsRpcError,
})
export const GetAnalytics = Rpc.make('store:analytics', {
  success: Schema.NullOr(analyticalViewsSchema),
  error: AnalyticsRpcError,
})
export const GetOverview = Rpc.make('overview:query', {
  payload: scopeRequestSchema,
  success: Schema.NullOr(overviewPayloadSchema),
  error: AnalyticsRpcError,
})
export const GetSessionRows = Rpc.make('sessions:view', {
  payload: scopeRequestSchema,
  success: Schema.mutable(Schema.Array(sessionRowSchema)),
  error: AnalyticsRpcError,
})
export const GetPullRequests = Rpc.make('pullRequests:view', {
  payload: scopeRequestSchema,
  success: Schema.NullOr(pullRequestsPayloadSchema),
  error: AnalyticsRpcError,
})
export const GetSpend = Rpc.make('spend:view', {
  payload: scopeRequestSchema,
  success: Schema.NullOr(spendPayloadSchema),
  error: AnalyticsRpcError,
})
export const GetModels = Rpc.make('models:view', {
  payload: scopeRequestSchema,
  success: Schema.NullOr(modelsPayloadSchema),
  error: AnalyticsRpcError,
})
export const GetCompare = Rpc.make('compare:view', {
  payload: compareRequestSchema,
  success: Schema.NullOr(comparePayloadSchema),
  error: AnalyticsRpcError,
})
export const GetOptimize = Rpc.make('optimize:view', {
  payload: scopeRequestSchema,
  success: Schema.NullOr(optimizePayloadSchema),
  error: AnalyticsRpcError,
})
export const GetYield = Rpc.make('optimize:yield', {
  payload: scopeRequestSchema,
  success: Schema.NullOr(yieldPayloadSchema),
  error: AnalyticsRpcError,
})
export const GetSkills = Rpc.make('skills:view', {
  payload: skillsRequestSchema,
  success: Schema.NullOr(skillsPayloadSchema),
  error: AnalyticsRpcError,
})
export const Search = Rpc.make('store:search', {
  payload: queryRequestSchema,
  success: Schema.mutable(Schema.Array(searchHitSchema)),
  error: AnalyticsRpcError,
})

export const AnalyticsRpcGroup = RpcGroup.make(
  GetViews,
  GetProjects,
  GetSessions,
  GetSession,
  GetAnalytics,
  GetOverview,
  GetSessionRows,
  GetPullRequests,
  GetSpend,
  GetModels,
  GetCompare,
  GetOptimize,
  GetYield,
  GetSkills,
  Search,
)
