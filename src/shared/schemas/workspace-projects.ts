import * as Schema from 'effect/Schema'

import {
  projectIdSchema,
  projectSchema,
  workspaceCheckoutIdSchema,
  workspaceCheckoutSchema,
} from '@/shared/schemas/workspace.js'

export const registerWorkspaceProjectSchema = Schema.Struct({
  projectId: projectIdSchema,
  checkoutId: workspaceCheckoutIdSchema,
  name: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(512)),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768), Schema.isPattern(/^[^\0]+$/)),
})
export type RegisterWorkspaceProject = Schema.Schema.Type<typeof registerWorkspaceProjectSchema>

export const workspaceProjectRegistrationSchema = Schema.Struct({
  project: projectSchema,
  mainCheckout: workspaceCheckoutSchema,
})
export type WorkspaceProjectRegistration = Schema.Schema.Type<typeof workspaceProjectRegistrationSchema>
