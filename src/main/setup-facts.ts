export type SkillInventoryEntry = { name: string; root: string }

export type McpConfigEntry = {
  normalized: string
  original: string
  mtime: number
  alwaysLoadPaths: string[]
}

export type DeferralEnvHit = { value: string; scope: string; path: string }

export type OptimizeSetup = {
  home: string
  mcpConfigs: Map<string, McpConfigEntry>
  envSettings: Map<string, DeferralEnvHit | null>
  agents: string[]
  skills: string[]
  commands: string[]
}
