import { z } from 'zod'

export const cadenceOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  ms: z.number().nullable(),
})
export type CadenceOption = z.infer<typeof cadenceOptionSchema>

/** The persisted refresh-cadence value over `cadence:get`/`cadence:set`
 * (a plain scalar, validated by `isValidCadence` in the main process). */
export const cadenceValueSchema = z.string()
export type CadenceValue = z.infer<typeof cadenceValueSchema>
