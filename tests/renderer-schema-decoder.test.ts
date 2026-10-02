import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseEvent, parsePayload } from '../src/renderer/src/shared/lib/api.js'
import { decodeSchema } from '../src/renderer/src/shared/lib/schema-decoder.js'
import { cadenceOptionSchema, cadenceValueSchema } from '../src/shared/schemas/cadence.js'

const finiteNumber = Schema.Finite
const optionalNullableSchema = Schema.Struct({ value: Schema.optional(Schema.NullOr(Schema.String)) })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer Effect Schema decoding', () => {
  it('decodes cadence options, strips unknown fields, and accepts nullable milliseconds', () => {
    const schema = cadenceOptionSchema

    expect(decodeSchema(schema, { value: 'manual', label: 'Manual', ms: null, extra: 'stripped' })).toEqual({
      ok: true,
      value: { value: 'manual', label: 'Manual', ms: null },
    })
    expect(decodeSchema(schema, { value: '1m', label: '1 minute', ms: 60_000 })).toEqual({
      ok: true,
      value: { value: '1m', label: '1 minute', ms: 60_000 },
    })
  })

  it('rejects non-finite option numbers and keeps cadence values as arbitrary strings', () => {
    const optionSchema = cadenceOptionSchema

    expect(decodeSchema(optionSchema, { value: 'manual', label: 'Manual', ms: Number.POSITIVE_INFINITY }).ok).toBe(
      false,
    )
    expect(decodeSchema(cadenceValueSchema, 'not-an-enum')).toEqual({ ok: true, value: 'not-an-enum' })
    expect(decodeSchema(cadenceValueSchema, 4).ok).toBe(false)
  })

  it.each([
    {
      name: 'normal option',
      input: { value: '1m', label: '1 minute', ms: 60_000 },
      expected: { value: '1m', label: '1 minute', ms: 60_000 },
    },
    {
      name: 'unknown keys',
      input: { value: 'manual', label: 'Manual', ms: null, extra: 'discarded' },
      expected: { value: 'manual', label: 'Manual', ms: null },
    },
    {
      name: 'nullable milliseconds',
      input: { value: 'manual', label: 'Manual', ms: null },
      expected: { value: 'manual', label: 'Manual', ms: null },
    },
    {
      name: 'largest finite milliseconds',
      input: { value: 'manual', label: 'Manual', ms: Number.MAX_VALUE },
      expected: { value: 'manual', label: 'Manual', ms: Number.MAX_VALUE },
    },
    {
      name: 'smallest positive finite milliseconds',
      input: { value: 'manual', label: 'Manual', ms: Number.MIN_VALUE },
      expected: { value: 'manual', label: 'Manual', ms: Number.MIN_VALUE },
    },
    {
      name: 'negative milliseconds',
      input: { value: 'manual', label: 'Manual', ms: -1 },
      expected: { value: 'manual', label: 'Manual', ms: -1 },
    },
  ])('preserves recorded cadence option values for $name', ({ input, expected }) => {
    expect(decodeSchema(cadenceOptionSchema, input)).toStrictEqual({ ok: true, value: expected })
  })

  it.each([
    ['missing milliseconds', { value: 'manual', label: 'Manual' }],
    ['undefined milliseconds', { value: 'manual', label: 'Manual', ms: undefined }],
    ['missing value', { label: 'Manual', ms: null }],
    ['undefined value', { value: undefined, label: 'Manual', ms: null }],
    ['null value', { value: null, label: 'Manual', ms: null }],
    ['missing label', { value: 'manual', ms: null }],
    ['wrong label type', { value: 'manual', label: 1, ms: null }],
    ['wrong milliseconds type', { value: 'manual', label: 'Manual', ms: '60' }],
    ['NaN milliseconds', { value: 'manual', label: 'Manual', ms: Number.NaN }],
    ['positive infinity milliseconds', { value: 'manual', label: 'Manual', ms: Number.POSITIVE_INFINITY }],
    ['negative infinity milliseconds', { value: 'manual', label: 'Manual', ms: Number.NEGATIVE_INFINITY }],
    ['array instead of option', []],
    ['null instead of option', null],
  ])('rejects recorded invalid cadence options for %s', (_name, input) => {
    expect(decodeSchema(cadenceOptionSchema, input).ok).toBe(false)
  })

  it.each(['not-an-enum', ''])('preserves the cadence string %j', input => {
    expect(decodeSchema(cadenceValueSchema, input)).toStrictEqual({ ok: true, value: input })
  })

  it.each([undefined, 4, null, { value: '1m' }])('rejects the non-string cadence value %j', input => {
    expect(decodeSchema(cadenceValueSchema, input).ok).toBe(false)
  })

  it.each([{}, { value: undefined }, { value: null }, { value: 'ready' }])(
    'preserves recorded optional and nullable output for %j',
    input => {
      expect(decodeSchema(optionalNullableSchema, input)).toStrictEqual({ ok: true, value: input })
    },
  )

  it('rejects a numeric optional string', () => {
    expect(decodeSchema(optionalNullableSchema, { value: 1 }).ok).toBe(false)
  })

  it('preserves optional and nullable decoded values', () => {
    const schema = optionalNullableSchema

    expect(decodeSchema(schema, {})).toEqual({ ok: true, value: {} })
    expect(decodeSchema(schema, { value: null })).toEqual({ ok: true, value: { value: null } })
    expect(decodeSchema(schema, { value: 'ready' })).toEqual({ ok: true, value: { value: 'ready' } })
    expect(decodeSchema(schema, { value: 1 }).ok).toBe(false)
  })

  it('projects the first nested and union failure path and uses payload for root failures', () => {
    const nestedSchema = Schema.Struct({ settings: Schema.Struct({ cadence: Schema.String }) })
    const unionSchema = Schema.Union([
      Schema.Struct({ kind: Schema.Literal('count'), value: finiteNumber }),
      Schema.Struct({ kind: Schema.Literal('label'), value: Schema.String }),
    ])
    const nullableSchema = Schema.NullOr(Schema.String)

    expect(parsePayload(nestedSchema, 'settings', { settings: { cadence: false } })).toEqual({
      ok: false,
      error: 'Invalid settings payload (settings.cadence: has an unexpected type)',
    })
    expect(parsePayload(unionSchema, 'union', { kind: 'count', value: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      error: 'Invalid union payload (value: has an invalid value)',
    })
    expect(decodeSchema(nullableSchema, null)).toEqual({ ok: true, value: null })
    expect(parsePayload(nullableSchema, 'nullable', 1)).toEqual({
      ok: false,
      error: 'Invalid nullable payload (payload: does not match the expected shape)',
    })
  })

  it('drops unexpected event schema defects and forwards only the label and location', () => {
    const notices: Array<[string, string]> = []
    vi.stubGlobal('api', {
      notifyNotice: async (label: string, location: string) => {
        notices.push([label, location])
      },
    })

    const payload = Object.defineProperty({}, 'private', {
      enumerable: true,
      get: () => {
        throw new Error('secret payload contents')
      },
    })
    const parsed = parseEvent(Schema.Struct({ private: Schema.String }), 'test event', payload)

    expect(parsed).toBeNull()
    expect(notices).toEqual([['test event', 'payload']])
    expect(JSON.stringify(notices)).not.toContain('secret')
  })
})
