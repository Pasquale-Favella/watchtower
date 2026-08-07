import { z } from 'zod'

export const updateStatusSchema = z.object({
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  tag: z.string().nullable(),
})
export type UpdateStatus = z.infer<typeof updateStatusSchema>

/** The running app's version string over `app:version`. */
export const appVersionSchema = z.string()
export type AppVersion = z.infer<typeof appVersionSchema>
