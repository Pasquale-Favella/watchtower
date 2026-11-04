import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import type * as Stream from 'effect/Stream'

import type {
  AgentAccessMode,
  AgentAccount,
  AgentCapabilities,
  AgentConnectionIdentity,
  AgentDriverEvent,
  AgentReconcileEvent,
  AgentRequestDecision,
  AgentSessionIdentity,
} from '@/shared/schemas/execution.js'
import { DEFAULT_AGENT_ACCESS_MODE } from '@/shared/schemas/execution.js'
import type { ResolvedPromptAttachment } from '@/shared/schemas/prompt-context.js'
import type {
  AgentRunId,
  AgentSessionId,
  ConversationId,
  ProjectId,
  TaskId,
  WorkspaceCheckoutId,
} from '@/shared/schemas/workspace.js'

export class AgentDriverError extends Schema.TaggedError<AgentDriverError>()('AgentDriverError', {
  code: Schema.Literals([
    'driver-unavailable',
    'authentication-required',
    'protocol-error',
    'disconnected',
    'invalid-state',
    'timeout',
    'outcome-uncertain',
  ]),
  message: Schema.String,
}) {}

export class UnsupportedAgentOperation extends Schema.TaggedError<UnsupportedAgentOperation>()(
  'UnsupportedAgentOperation',
  {
    operation: Schema.Literals(['openSession', 'loadSession', 'submit', 'interrupt', 'steer', 'respond', 'reconcile']),
    message: Schema.String,
  },
) {}

export interface AgentSessionContext {
  readonly sessionId: AgentSessionId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly conversationId: ConversationId
  readonly checkoutId: WorkspaceCheckoutId
  readonly workspacePath: string
  readonly generation: number
  readonly modelId?: string | undefined
  readonly modeId?: string | undefined
  /** Absent is treated as the fail-safe default; drivers never widen a missing value. */
  readonly accessMode?: AgentAccessMode | undefined
}

export interface NativeSessionReference {
  readonly nativeSessionId: string
  readonly generation: number
}

export interface AgentTurnInput {
  /** Immutable application identity. A retry uses a fresh Run ID. */
  readonly runId: AgentRunId
  readonly messages: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>
  readonly attachmentIds: ReadonlyArray<string>
  readonly attachments?: ReadonlyArray<ResolvedPromptAttachment>
}

export interface NativeTurnAcceptance {
  readonly nativeTurnId?: string | undefined
  readonly nativeSessionId: string
  readonly generation: number
}

export interface InterruptAcknowledgement {
  readonly acknowledged: boolean
  readonly termination: 'interrupted' | 'stillRunning' | 'unknown'
}

export interface DeliveryOutcome {
  /** Acceptance by the local handler/transport does not confirm native execution. */
  readonly outcome: 'accepted' | 'failed' | 'uncertain'
  /** Omission means unconfirmed; only an explicit native acknowledgment may confirm delivery. */
  readonly nativeConfirmation?: 'confirmed' | 'unconfirmed' | undefined
  readonly nativeRequestId?: string | undefined
}

export interface NativeSessionSnapshot {
  readonly state: 'idle' | 'running' | 'awaitingRequest' | 'ended' | 'unknown'
  readonly nativeTurnId?: string | undefined
  readonly cursor?: string | undefined
}

export interface AgentDriverSession {
  readonly identity: AgentSessionIdentity
  readonly capabilities: AgentCapabilities
  /** One application-owned ingestor consumes each active run stream. */
  readonly events: (
    runId: AgentRunId,
    afterCursor?: string | undefined,
  ) => Stream.Stream<AgentDriverEvent, AgentDriverError>
  readonly submit: (
    input: AgentTurnInput,
  ) => Effect.Effect<NativeTurnAcceptance, AgentDriverError | UnsupportedAgentOperation>
  readonly interrupt: (
    runId: AgentRunId,
    expectedNativeTurnId?: string | undefined,
  ) => Effect.Effect<InterruptAcknowledgement, AgentDriverError | UnsupportedAgentOperation>
  readonly steer: (
    runId: AgentRunId,
    expectedNativeTurnId: string | undefined,
    message: string,
    attachments?: readonly ResolvedPromptAttachment[],
  ) => Effect.Effect<DeliveryOutcome, AgentDriverError | UnsupportedAgentOperation>
  readonly respond: (
    runId: AgentRunId,
    requestId: string,
    generation: number,
    decision: AgentRequestDecision,
  ) => Effect.Effect<DeliveryOutcome, AgentDriverError | UnsupportedAgentOperation>
  /** Reconciliation explicitly marks replayed facts; replay is not a new turn. */
  readonly reconcile: () => Stream.Stream<AgentReconcileEvent, AgentDriverError | UnsupportedAgentOperation>
}

/** What a catalog probe learned. `signIn` is present only when the agent reports its account. */
export interface AgentCatalogProbe extends Pick<AgentCapabilities, 'models' | 'modes'> {
  readonly signIn?:
    | {
        readonly status: 'authenticated' | 'unauthenticated'
        readonly account?: AgentAccount | undefined
        /** Shown to the user when the agent needs attention. */
        readonly message?: string | undefined
      }
    | undefined
}

export interface AgentDriverConnection {
  readonly identity: AgentConnectionIdentity
  readonly discover: () => Effect.Effect<AgentCapabilities, AgentDriverError>
  /**
   * Disposable probe for the model and mode catalogs a passive discover cannot report, and the signed-in account
   * when the agent exposes one. It may open a throwaway native session, so only connection inspection calls it,
   * on a connection it closes right after.
   */
  readonly probeCatalog?: () => Effect.Effect<AgentCatalogProbe, AgentDriverError>
  /** Start a fresh native conversation. No implicit fallback from loadSession. */
  readonly openSession: (
    context: AgentSessionContext,
  ) => Effect.Effect<AgentDriverSession, AgentDriverError | UnsupportedAgentOperation>
  /** Load an existing native conversation by its exact identity. */
  readonly loadSession: (
    context: AgentSessionContext,
    native: NativeSessionReference,
  ) => Effect.Effect<AgentDriverSession, AgentDriverError | UnsupportedAgentOperation>
  /** Drain and close resources owned by this connection within the caller's Scope. */
  readonly close: (deadlineMs: number) => Effect.Effect<void, AgentDriverError>
}

export interface AgentDriverConnectOptions {
  readonly connectionId: string
  /** Non-secret settings only. Secrets are resolved by infrastructure from references. */
  readonly configuration?: Readonly<Record<string, string>> | undefined
  readonly secretReferences?: ReadonlyArray<string> | undefined
}

export type AgentDriverConnect = (
  options: AgentDriverConnectOptions,
) => Effect.Effect<AgentDriverConnection, AgentDriverError, Scope.Scope>

/** Core-facing session protocol. Implementations own protocol and process details in infrastructure. */
export class AgentDriver extends Context.Service<
  AgentDriver,
  {
    readonly driverId: string
    readonly connect: AgentDriverConnect
    /** Access modes the driver enforces natively. Omission declares approval-required only. */
    readonly accessModes?: ReadonlyArray<AgentAccessMode> | undefined
  }
>()('watchtower/core/AgentDriver') {}

/** Declared access modes as a fresh array; an undeclared driver can only prove the fail-safe default. */
export const agentDriverAccessModes = (driver: {
  readonly accessModes?: ReadonlyArray<AgentAccessMode> | undefined
}): Array<AgentAccessMode> => [...(driver.accessModes ?? [DEFAULT_AGENT_ACCESS_MODE])]
