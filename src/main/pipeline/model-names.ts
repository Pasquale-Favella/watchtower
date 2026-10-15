function stripPinAndDate(model: string): string {
  return model.replace(/@.*$/, '').replace(/-\d{8}$/, '')
}

function getCanonicalName(model: string): string {
  return stripPinAndDate(model).replace(/^[^/]+\//, '')
}

const autoModelNames: Record<string, string> = {
  'cursor-auto': 'Cursor (auto)',
  'cursor-agent-auto': 'Cursor (auto)',
  'copilot-auto': 'Copilot (auto)',
  'copilot-openai-auto': 'Copilot (OpenAI)',
  'copilot-anthropic-auto': 'Copilot (Anthropic)',
  'ibm-bob-auto': 'IBM Bob (auto)',
  'kiro-auto': 'Kiro (auto)',
  'quickdesk-auto': 'Quick Desktop (auto)',
  'cline-auto': 'Cline (auto)',
  'openclaw-auto': 'OpenClaw (auto)',
  'qwen-auto': 'Qwen (auto)',
  'kimi-auto': 'Kimi (auto)',
}

const shortNames: Record<string, string> = {
  'claude-fable-5': 'Fable 5',
  'claude-mythos-5': 'Mythos 5',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-3-5-haiku': 'Haiku 3.5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-4.1-nano': 'GPT-4.1 Nano',
  'gpt-4.1-mini': 'GPT-4.1 Mini',
  'gpt-4.1': 'GPT-4.1',
  'codex-auto-review': 'Codex Auto Review',
  'gpt-5.5-pro': 'GPT-5.5 Pro',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4-pro': 'GPT-5.4 Pro',
  'gpt-5.4-nano': 'GPT-5.4 Nano',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3': 'GPT-5.3',
  'gpt-5.2-pro': 'GPT-5.2 Pro',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
  'gpt-5.1-codex': 'GPT-5.1 Codex',
  'gpt-5.1': 'GPT-5.1',
  'gpt-5-pro': 'GPT-5 Pro',
  'gpt-5-nano': 'GPT-5 Nano',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5': 'GPT-5',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'gemini-3-flash-preview': 'Gemini 3 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'kimi-k2-thinking-turbo': 'Kimi K2 Thinking Turbo',
  'kimi-k2-thinking': 'Kimi K2 Thinking',
  'kimi-k3': 'Kimi K3',
  'kimi-k2p6': 'Kimi K2.6',
  'kimi-thinking-preview': 'Kimi Thinking',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2p5': 'Kimi K2.5',
  'kimi-k2-instruct': 'Kimi K2 Instruct',
  'kimi-k2-0905': 'Kimi K2',
  'kimi-k2': 'Kimi K2',
  'kimi-latest': 'Kimi Latest',
  'moonshot-v1': 'Moonshot v1',
  'deepseek-v4-pro': 'DeepSeek v4 Pro',
  'deepseek-v4-flash': 'DeepSeek v4 Flash',
  'deepseek-coder-max': 'DeepSeek Coder Max',
  'deepseek-coder': 'DeepSeek Coder',
  'deepseek-r1': 'DeepSeek R1',
  'o4-mini': 'o4-mini',
  o3: 'o3',
  'MiniMax-M2.7-highspeed': 'MiniMax M2.7 Highspeed',
  'MiniMax-M2.7': 'MiniMax M2.7',
  'glm-5p1': 'GLM-5.2',
  'grok-build-0.1': 'Grok Build',
  'grok-composer-2.5-fast': 'Grok Composer 2.5 Fast',
  'glm-5p2': 'GLM-5.2',
  'qwen3p7-plus': 'Qwen 3.7 Plus',
  'kimi-k2p7-code': 'Kimi K2.7 Code',
}

const sortedShortNames: readonly (readonly [string, string])[] = Object.entries(shortNames).sort(
  (a, b) => b[0].length - a[0].length,
)
const claudeFamilies: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }

function deriveClaudeShortName(canonical: string): string | undefined {
  const match = canonical.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/)
  if (!match) return undefined
  const [, family, major, minor] = match
  return `${claudeFamilies[family]} ${major}${minor ? `.${minor}` : ''}`
}

export function getShortModelName(model: string, resolveAlias: (name: string) => string = name => name): string {
  if (autoModelNames[model]) return autoModelNames[model]
  const canonical = resolveAlias(getCanonicalName(model))
  const claude = deriveClaudeShortName(canonical)
  if (claude) return claude
  for (const [key, name] of sortedShortNames) {
    if (canonical === key || canonical.startsWith(key + '-')) return name
  }
  if (canonical.includes('/')) {
    const segment = canonical.slice(canonical.lastIndexOf('/') + 1)
    return segment ? getShortModelName(segment, resolveAlias) : canonical
  }
  return canonical
}
