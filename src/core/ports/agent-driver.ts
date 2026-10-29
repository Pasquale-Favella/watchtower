import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import type * as Stream from 'effect/Stream'

import type {
  AgentCapabilities,
  AgentConnectionIdentity,
  AgentDriverEvent,
  AgentReconcileEvent,
  AgentRequestDecision,
  AgentSessionIdentity,
} from '@/shared/schemas/execution.js'
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

export interface AgentDriverConnection {
  readonly identity: AgentConnectionIdentity
  readonly discover: () => Effect.Effect<AgentCapabilities, AgentDriverError>
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
  }
>()('watchtower/core/AgentDriver') {}
