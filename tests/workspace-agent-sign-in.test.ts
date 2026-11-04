import { describe, expect, it } from 'vitest'

import {
  CLAUDE_SIGN_IN_MESSAGE,
  claudeSignIn,
  claudeSubscriptionLabel,
} from '@/infrastructure/agent-harnesses/drivers/claude/account.js'
import { claudeModelChoices } from '@/infrastructure/agent-harnesses/drivers/claude/models.js'
import { connectionDetail, connectionStatus } from '@/renderer/features/workspace/model-picker/catalog.js'
import type { WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

const effort = ['low', 'medium', 'high', 'xhigh', 'max'] as const

describe('claudeModelChoices', () => {
  it('names each model with its version even when the CLI reports bare names', () => {
    const choices = claudeModelChoices(
      [
        {
          value: 'default',
          displayName: 'Default (recommended)',
          description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
          supportedEffortLevels: [...effort],
        },
        {
          value: 'claude-fable-5-1[1m]',
          displayName: 'Fable',
          description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
          supportedEffortLevels: [...effort],
        },
        { value: 'sonnet', displayName: 'Sonnet 5', description: 'Most efficient for everyday tasks' },
        { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
        { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
      ],
      240,
    )
    expect(choices.map(choice => [choice.id, choice.label, choice.description, choice.modes?.length])).toEqual([
      ['default', 'Default (Opus 5 with 1M context)', 'Best for everyday, complex tasks', 5],
      ['claude-fable-5-1[1m]', 'Fable 5.1', 'Most capable for your hardest and longest-running tasks', 5],
      ['sonnet', 'Sonnet 5', 'Most efficient for everyday tasks', 0],
      ['haiku', 'Haiku 4.5', 'Fastest for quick answers', 0],
    ])
    expect(choices[1]?.modes?.[3]).toEqual({ id: 'xhigh', label: 'Extra high' })
  })
})

describe('claudeSignIn', () => {
  it('names the subscription and email of a signed-in account', () => {
    expect(
      claudeSignIn({ email: 'dev@example.com', subscriptionType: 'claude_max_subscription', tokenSource: 'oauth' }),
    ).toEqual({
      status: 'authenticated',
      account: { label: 'Claude Max Subscription', email: 'dev@example.com' },
    })
    expect(claudeSubscriptionLabel('max20')).toBe('Claude Ultra Subscription')
    expect(claudeSubscriptionLabel('pro')).toBe('Claude Pro Subscription')
  })

  it('recognises API keys and cloud providers without a subscription', () => {
    expect(claudeSignIn({ apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'none' }).account).toEqual({
      label: 'Claude API Key',
    })
    expect(claudeSignIn({ apiProvider: 'bedrock' }).account).toEqual({ label: 'Amazon Bedrock' })
  })

  it('reports a signed-out CLI with the sign-in command', () => {
    expect(claudeSignIn({ tokenSource: 'none', apiKeySource: 'none' })).toEqual({
      status: 'unauthenticated',
      message: CLAUDE_SIGN_IN_MESSAGE,
    })
  })
})

const inspection = (overrides: Partial<WorkspaceConnectionInspection>): WorkspaceConnectionInspection => ({
  connectionId: 'claude',
  driverId: 'claude-agent-sdk',
  protocol: { state: 'initialized' },
  authentication: 'unknown',
  capabilities: {
    openSession: { support: 'supported', restrictions: [], evidence: [] },
    loadSession: { support: 'supported', restrictions: [], evidence: [] },
    submit: { support: 'supported', restrictions: [], evidence: [] },
    interrupt: { support: 'supported', restrictions: [], evidence: [] },
    steer: { support: 'unsupported', restrictions: [], evidence: [] },
    respond: { support: 'supported', restrictions: [], evidence: [] },
    reconcile: { support: 'unsupported', restrictions: [], evidence: [] },
    models: { state: 'connection-scoped', items: [] },
    modes: { state: 'unknown', items: [] },
  },
  ...overrides,
})
const read = (value: WorkspaceConnectionInspection) => ({ inspection: value, pending: false, failed: false })

describe('connection status in the agent rail', () => {
  it('is ready with the account when signed in', () => {
    const signedIn = inspection({
      authentication: 'authenticated',
      account: { label: 'Claude Max Subscription', email: 'dev@example.com' },
    })
    expect(connectionStatus(read(signedIn))).toBe('ready')
    expect(connectionDetail(read(signedIn))).toBe('Claude Max Subscription · dev@example.com')
  })

  it('is unavailable with the sign-in command when signed out, and needs attention when unverified', () => {
    const signedOut = inspection({ authentication: 'unauthenticated', statusMessage: CLAUDE_SIGN_IN_MESSAGE })
    expect(connectionStatus(read(signedOut))).toBe('error')
    expect(connectionDetail(read(signedOut))).toBe(CLAUDE_SIGN_IN_MESSAGE)
    const unverified = inspection({ statusMessage: 'Could not verify the Claude sign-in status.' })
    expect(connectionStatus(read(unverified))).toBe('warning')
  })
})
