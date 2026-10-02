import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Finite
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))

export const spendSegmentSchema = Schema.Struct({
  name: writable(Schema.String),
  cost: writable(finiteNumber),
  sourceModels: writable(Schema.optional(mutableArray(Schema.String))),
})
export type SpendSegment = Schema.Schema.Type<typeof spendSegmentSchema>

export const spendDayEntrySchema = Schema.Struct({
  date: writable(Schema.String),
  cost: writable(finiteNumber),
  segments: writable(mutableArray(spendSegmentSchema)),
})
export type SpendDayEntry = Schema.Schema.Type<typeof spendDayEntrySchema>

export const spendFlowNodeSchema = Schema.Struct({
  id: writable(Schema.String),
  label: writable(Schema.String),
  cost: writable(finiteNumber),
  sourceModels: writable(Schema.optional(mutableArray(Schema.String))),
})
export type SpendFlowNode = Schema.Schema.Type<typeof spendFlowNodeSchema>

export const spendFlowLinkSchema = Schema.Struct({
  model: writable(Schema.String),
  project: writable(Schema.String),
  cost: writable(finiteNumber),
})
export type SpendFlowLink = Schema.Schema.Type<typeof spendFlowLinkSchema>

export const spendFlowSchema = Schema.Struct({
  models: writable(mutableArray(spendFlowNodeSchema)),
  projects: writable(mutableArray(spendFlowNodeSchema)),
  links: writable(mutableArray(spendFlowLinkSchema)),
})
export type SpendFlow = Schema.Schema.Type<typeof spendFlowSchema>

export const spendPayloadSchema = Schema.Struct({
  byModel: writable(mutableArray(spendDayEntrySchema)),
  byProject: writable(mutableArray(spendDayEntrySchema)),
  flow: writable(spendFlowSchema),
  dataStart: writable(Schema.NullOr(Schema.String)),
})
export type SpendPayload = Schema.Schema.Type<typeof spendPayloadSchema>
