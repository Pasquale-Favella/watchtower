export const SETTINGS_GROUPS = ['general', 'analytics', 'workspace'] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

export const SETTINGS_PANES = {
  general: [
    { id: 'general', label: 'Appearance & updates' },
    { id: 'privacy', label: 'Privacy & data' },
    { id: 'mcp', label: 'Local MCP' },
  ],
  analytics: [
    { id: 'analytics', label: 'Display & scanning' },
    { id: 'providers', label: 'Providers' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'aliases', label: 'Model aliases' },
    { id: 'export', label: 'Export' },
    { id: 'skills', label: 'Skills detection' },
  ],
  workspace: [{ id: 'workspace', label: 'Agent defaults' }],
} as const

export type SettingsPane = (typeof SETTINGS_PANES)[SettingsGroup][number]['id']
export const SETTINGS_GROUP_LABELS: Record<SettingsGroup, string> = {
  general: 'General',
  analytics: 'Analytics',
  workspace: 'Workspace',
}
