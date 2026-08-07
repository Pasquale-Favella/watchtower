import { z } from 'zod'

export const exportResultSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  error: z.string().optional(),
})
export type ExportResult = z.infer<typeof exportResultSchema>
