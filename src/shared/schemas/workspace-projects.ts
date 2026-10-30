import * as Schema from 'effect/Schema'

import { projectIdSchema, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'
import { projectRegistrationReceiptSchema } from '@/shared/schemas/workspace-store.js'

export const registerWorkspaceProjectSchema = Schema.Struct({
  commandId: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1)),
  projectId: projectIdSchema,
  checkoutId: workspaceCheckoutIdSchema,
  name: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(512)),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768), Schema.isPattern(/^[^\0]+$/)),
})
export type RegisterWorkspaceProject = Schema.Schema.Type<typeof registerWorkspaceProjectSchema>

export const workspaceProjectRegistrationSchema = projectRegistrationReceiptSchema
export type WorkspaceProjectRegistration = Schema.Schema.Type<typeof workspaceProjectRegistrationSchema>
