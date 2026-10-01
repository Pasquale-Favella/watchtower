import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { parseEvent, parsePayload } from '../src/renderer/src/shared/lib/api.js'
import { effectSchemaDecoder } from '../src/renderer/src/shared/lib/schema-decoder.js'
import { cadenceOptionSchema, cadenceValueSchema } from '../src/shared/schemas/cadence.js'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const optionalNullableSchema = Schema.Struct({ value: Schema.optional(Schema.NullOr(Schema.String)) })

// Keep these frozen schemas until application-owned Zod contracts and imports are removed.
const frozenCadenceOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  ms: z.number().nullable(),
})
const frozenCadenceValueSchema = z.string()
const frozenOptionalNullableSchema = z.object({ value: z.string().nullable().optional() })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer Effect Schema decoder', () => {
  it('decodes cadence options, strips unknown fields, and accepts nullable milliseconds', () => {
    const decoder = effectSchemaDecoder(cadenceOptionSchema)

    expect(decoder({ value: 'manual', label: 'Manual', ms: null, extra: 'stripped' })).toEqual({
      ok: true,
      value: { value: 'manual', label: 'Manual', ms: null },
    })
    expect(decoder({ value: '1m', label: '1 minute', ms: 60_000 })).toEqual({
      ok: true,
      value: { value: '1m', label: '1 minute', ms: 60_000 },
    })
  })

  it('rejects non-finite option numbers and keeps cadence values as arbitrary strings', () => {
    const optionDecoder = effectSchemaDecoder(cadenceOptionSchema)

    expect(optionDecoder({ value: 'manual', label: 'Manual', ms: Number.POSITIVE_INFINITY }).ok).toBe(false)
    expect(effectSchemaDecoder(cadenceValueSchema)('not-an-enum')).toEqual({ ok: true, value: 'not-an-enum' })
    expect(effectSchemaDecoder(cadenceValueSchema)(4).ok).toBe(false)
  })

  it.each([
    ['normal option', { value: '1m', label: '1 minute', ms: 60_000 }],
    ['unknown keys are stripped', { value: 'manual', label: 'Manual', ms: null, extra: 'discarded' }],
    ['nullable milliseconds', { value: 'manual', label: 'Manual', ms: null }],
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
    ['largest finite milliseconds', { value: 'manual', label: 'Manual', ms: Number.MAX_VALUE }],
    ['smallest positive finite milliseconds', { value: 'manual', label: 'Manual', ms: Number.MIN_VALUE }],
    ['negative milliseconds', { value: 'manual', label: 'Manual', ms: -1 }],
    ['array instead of option', []],
    ['null instead of option', null],
  ])('matches the frozen Zod cadence option contract for %s', (_caseName, input) => {
    const oldResult = frozenCadenceOptionSchema.safeParse(input)
    const newResult = effectSchemaDecoder(cadenceOptionSchema)(input)

    if (oldResult.success) {
      expect(newResult).toEqual({ ok: true, value: oldResult.data })
    } else {
      expect(newResult.ok).toBe(false)
    }
  })

  it.each([
    ['arbitrary string', 'not-an-enum'],
    ['empty string', ''],
    ['missing value', undefined],
    ['number', 4],
    ['null', null],
    ['object', { value: '1m' }],
  ])('matches the frozen Zod cadence value contract for %s', (_caseName, input) => {
    const oldResult = frozenCadenceValueSchema.safeParse(input)
    const newResult = effectSchemaDecoder(cadenceValueSchema)(input)

    if (oldResult.success) {
      expect(newResult).toEqual({ ok: true, value: oldResult.data })
    } else {
      expect(newResult.ok).toBe(false)
    }
  })

  it.each([
    ['missing optional property', {}],
    ['undefined optional property', { value: undefined }],
    ['null optional property', { value: null }],
    ['string optional property', { value: 'ready' }],
    ['wrong optional property type', { value: 1 }],
  ])('matches frozen Zod optional, nullable, and undefined behavior for %s', (_caseName, input) => {
    const oldResult = frozenOptionalNullableSchema.safeParse(input)
    const newResult = effectSchemaDecoder(optionalNullableSchema)(input)

    if (oldResult.success) {
      expect(newResult).toEqual({ ok: true, value: oldResult.data })
    } else {
      expect(newResult.ok).toBe(false)
    }
  })

  it('preserves optional and nullable decoded values', () => {
    const decoder = effectSchemaDecoder(optionalNullableSchema)

    expect(decoder({})).toEqual({ ok: true, value: {} })
    expect(decoder({ value: null })).toEqual({ ok: true, value: { value: null } })
    expect(decoder({ value: 'ready' })).toEqual({ ok: true, value: { value: 'ready' } })
    expect(decoder({ value: 1 }).ok).toBe(false)
  })

  it('projects the first nested and union failure path and uses payload for root failures', () => {
    const nestedDecoder = effectSchemaDecoder(Schema.Struct({ settings: Schema.Struct({ cadence: Schema.String }) }))
    const unionDecoder = effectSchemaDecoder(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal('count'), value: finiteNumber }),
        Schema.Struct({ kind: Schema.Literal('label'), value: Schema.String }),
      ]),
    )
    const nullableDecoder = effectSchemaDecoder(Schema.NullOr(Schema.String))

    expect(parsePayload(nestedDecoder, 'settings', { settings: { cadence: false } })).toEqual({
      ok: false,
      error: 'Invalid settings payload (settings.cadence: has an unexpected type)',
    })
    expect(parsePayload(unionDecoder, 'union', { kind: 'count', value: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      error: 'Invalid union payload (value: has an invalid value)',
    })
    expect(nullableDecoder(null)).toEqual({ ok: true, value: null })
    expect(parsePayload(nullableDecoder, 'nullable', 1)).toEqual({
      ok: false,
      error: 'Invalid nullable payload (payload: does not match the expected shape)',
    })
  })

  it('drops unexpected event decoder defects and forwards only the label and location', () => {
    const notices: Array<[string, string]> = []
    vi.stubGlobal('api', {
      notifyNotice: async (label: string, location: string) => {
        notices.push([label, location])
      },
    })

    const parsed = parseEvent(
      () => {
        throw new Error('secret payload contents')
      },
      'test event',
      { private: 'secret payload contents' },
    )

    expect(parsed).toBeNull()
    expect(notices).toEqual([['test event', 'payload']])
    expect(JSON.stringify(notices)).not.toContain('secret')
  })
})
