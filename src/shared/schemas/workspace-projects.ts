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

export const WORKSPACE_DIRECTORY_BROWSE_LIMIT = 500

/** Absolute or `~`-anchored directory path; the listing covers its immediate subfolders. */
export const browseWorkspaceDirectoriesSchema = Schema.Struct({
  directoryPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096), Schema.isPattern(/^[^\0]+$/)),
})
export type BrowseWorkspaceDirectories = Schema.Schema.Type<typeof browseWorkspaceDirectoriesSchema>

export const workspaceDirectoryListingSchema = Schema.Struct({
  parentPath: Schema.String,
  /** False when the browsed directory is missing or unreadable. */
  exists: Schema.Boolean,
  isRepository: Schema.Boolean,
  entries: Schema.Array(
    Schema.Struct({ name: Schema.String, fullPath: Schema.String, isRepository: Schema.Boolean }),
  ).check(Schema.isMaxLength(WORKSPACE_DIRECTORY_BROWSE_LIMIT)),
})
export type WorkspaceDirectoryListing = Schema.Schema.Type<typeof workspaceDirectoryListingSchema>

/** `owner/name` on GitHub; the shape is also what keeps it from reading as a CLI option. */
export const githubRepositorySchema = Schema.String.check(
  Schema.isMaxLength(201),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/),
)
/** Any Git remote except option-shaped input; transports Git disables stay disabled. */
export const gitRemoteUrlSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^[^-\s\0][^\s\0]*$/),
)
export const projectRemoteSourceSchema = Schema.Union([
  Schema.TaggedStruct('github', { repository: githubRepositorySchema }),
  Schema.TaggedStruct('git', { remoteUrl: gitRemoteUrlSchema }),
])
export type ProjectRemoteSource = Schema.Schema.Type<typeof projectRemoteSourceSchema>

export const projectPublishTargetSchema = Schema.Literals(['none', 'github-private'])
export type ProjectPublishTarget = Schema.Schema.Type<typeof projectPublishTargetSchema>

/** Creates the folder when missing and initializes Git when absent; an existing checkout is only registered. */
export const createWorkspaceProjectSchema = Schema.Struct({
  ...registerWorkspaceProjectSchema.fields,
  publish: projectPublishTargetSchema,
})
export type CreateWorkspaceProject = Schema.Schema.Type<typeof createWorkspaceProjectSchema>

/** The destination must be missing or empty unless it already holds the finished clone. */
export const cloneWorkspaceProjectSchema = Schema.Struct({
  ...registerWorkspaceProjectSchema.fields,
  source: projectRemoteSourceSchema,
})
export type CloneWorkspaceProject = Schema.Schema.Type<typeof cloneWorkspaceProjectSchema>

export const remoteRepositorySchema = Schema.Struct({ nameWithOwner: Schema.String, url: Schema.String })
export type RemoteRepository = Schema.Schema.Type<typeof remoteRepositorySchema>

export const remoteSourceReadinessSchema = Schema.Struct({
  github: Schema.Literals(['ready', 'unauthenticated', 'unavailable']),
})
export type RemoteSourceReadiness = Schema.Schema.Type<typeof remoteSourceReadinessSchema>

export const projectSetupErrorCodeSchema = Schema.Literals([
  'target-not-empty',
  'git-unavailable',
  'gh-unavailable',
  'gh-unauthenticated',
  'remote-not-found',
  'clone-failed',
  'init-failed',
  'publish-failed',
  'timeout',
])
export type ProjectSetupErrorCode = Schema.Schema.Type<typeof projectSetupErrorCodeSchema>

/** Fixed per code: Git and gh output can carry credentials or local paths, so it never crosses the boundary. */
export const PROJECT_SETUP_MESSAGES = {
  'target-not-empty': 'The destination folder is not empty.',
  'git-unavailable': 'Git is not installed or not on PATH.',
  'gh-unavailable': 'GitHub CLI (gh) is not installed or not on PATH.',
  'gh-unauthenticated': 'GitHub CLI is not signed in. Run gh auth login.',
  'remote-not-found': 'The repository was not found or is not accessible.',
  'clone-failed': 'Git could not clone the repository.',
  'init-failed': 'Git could not initialize the folder.',
  'publish-failed': 'GitHub CLI could not create the repository.',
  timeout: 'The operation timed out.',
} as const satisfies Record<ProjectSetupErrorCode, string>

export class ProjectSetupError extends Schema.TaggedError<ProjectSetupError>()('ProjectSetupError', {
  code: projectSetupErrorCodeSchema,
  message: Schema.String,
}) {
  static of(code: ProjectSetupErrorCode): ProjectSetupError {
    return new ProjectSetupError({ code, message: PROJECT_SETUP_MESSAGES[code] })
  }
}
