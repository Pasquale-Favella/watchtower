import * as Schema from 'effect/Schema'

export const decodeRows = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(schema)))
