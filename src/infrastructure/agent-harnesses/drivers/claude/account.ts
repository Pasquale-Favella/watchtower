import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'

import type { AgentCatalogProbe } from '@/core/ports/agent-driver.js'

export const CLAUDE_SIGN_IN_MESSAGE = 'Claude Code is not signed in. Run `claude auth login` and try again.'

const SUBSCRIPTION_LABELS: Readonly<Record<string, string>> = {
  claudemaxsubscription: 'Max',
  claudemax5xsubscription: 'Max',
  claudemax20xsubscription: 'Ultra',
  claudeenterprisesubscription: 'Enterprise',
  claudeteamsubscription: 'Team',
  claudeprosubscription: 'Pro',
  claudefreesubscription: 'Free',
  max: 'Max',
  maxplan: 'Max',
  max5: 'Max',
  max20: 'Ultra',
  enterprise: 'Enterprise',
  team: 'Team',
  pro: 'Pro',
  free: 'Free',
}

const compact = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '')
const titleCase = (value: string) =>
  value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ')

/** "Claude Max Subscription" from the SDK's subscription type. */
export function claudeSubscriptionLabel(subscriptionType: string): string {
  const plan = SUBSCRIPTION_LABELS[compact(subscriptionType)] ?? titleCase(subscriptionType)
  const normalized = compact(plan)
  if (normalized.startsWith('claude') && normalized.endsWith('subscription')) return plan
  if (normalized.startsWith('claude')) return `${plan} Subscription`
  if (normalized.endsWith('subscription')) return `Claude ${plan}`
  return `Claude ${plan} Subscription`
}

const isApiKeyMethod = (method: string | undefined) =>
  method !== undefined && ['apikey', 'anthropicapikey', 'anthropicauthtoken'].includes(compact(method))

/**
 * Sign-in from the SDK's account info: a cloud provider or any token source counts as signed
 * in; with no token, an API key or account fields still do. Only their total absence means signed out.
 */
export function claudeSignIn(account: AccountInfo): NonNullable<AgentCatalogProbe['signIn']> {
  const hasApiKey = account.apiKeySource !== undefined && account.apiKeySource !== 'none'
  const authenticated =
    (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') ||
    (account.tokenSource !== undefined && account.tokenSource !== 'none') ||
    hasApiKey ||
    Boolean(account.email) ||
    Boolean(account.subscriptionType)
  if (!authenticated) return { status: 'unauthenticated', message: CLAUDE_SIGN_IN_MESSAGE }
  let label: string | undefined
  if (account.apiProvider === 'bedrock') label = 'Amazon Bedrock'
  else if (account.apiProvider === 'vertex') label = 'Google Vertex AI'
  else if (isApiKeyMethod(account.tokenSource) || (hasApiKey && !account.subscriptionType)) label = 'Claude API Key'
  else if (account.subscriptionType) label = claudeSubscriptionLabel(account.subscriptionType)
  return {
    status: 'authenticated',
    account: { ...(label ? { label } : {}), ...(account.email ? { email: account.email } : {}) },
  }
}
